// A local page for one question magpie's window cannot host: what does every
// channel of a model charge right now, and is it up?
//
//   npm run dashboard        # http://127.0.0.1:3917
//
// It reads the system access token from magpie's plugin-auth.json (or
// PACKY_TOKEN / PACKY_USER), the per-group keys the plugin made from
// packycode-keys.json, then the console's price list and 24-hour metrics,
// and GET /v1/models per key to see which channels serve what at this moment.

import { execSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import tls from "node:tls"
import { parsePricing, multiplierOf, priceOf } from "../src/pricing.mjs"
import { allowedGroup, RESTRICTED } from "../src/groups.mjs"

const CONSOLE = process.env.PACKY_CONSOLE || "https://www.packyapi.com"
const INFER = process.env.PACKY_INFER || "https://slb-v1.api.fan"
const PORT = Number(process.env.PORT) || 3917
const DIR = process.env.MAGPIE_DIR || path.join(os.homedir(), ".config", "magpie")

// ── auth ───────────────────────────────────────────────────────────────────

function readAuth() {
  if (process.env.PACKY_TOKEN) return { token: process.env.PACKY_TOKEN, userID: process.env.PACKY_USER || "" }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, "plugin-auth.json"), "utf8"))
    const e = j.packycode ?? Object.entries(j).find(([k]) => k.startsWith("packycode"))?.[1]
    return { token: e?.key || "", userID: e?.metadata?.userID || "" }
  } catch {
    return { token: "", userID: "" }
  }
}

function readKeys() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, "packycode-keys.json"), "utf8"))
    return Object.fromEntries(Object.entries(j).map(([g, r]) => [g, r.key]))
  } catch {
    return {}
  }
}

// ── HTTP with the proxy the plugin host uses ──────────────────────────────

function systemProxy() {
  // a mac's ClashX sets scutil's proxy but not always a shell variable
  try {
    const out = String(execSync("scutil --proxy 2>/dev/null")).toString()
    const host = /HTTPSProxy\s*:\s*(\S+)/.exec(out)?.[1]
    const port = /HTTPSPort\s*:\s*(\d+)/.exec(out)?.[1]
    if (host && port) return `http://${host}:${port}`
  } catch {}
  return ""
}

const rawProxy =
  process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.HTTP_PROXY || systemProxy()
const proxy = /^https?:\/\//i.test(rawProxy) ? rawProxy : ""

class ProxyAgent extends https.Agent {
  createConnection(options, cb) {
    const u = new URL(proxy)
    const sock = net.connect({ host: u.hostname, port: Number(u.port) || 8080 })
    sock.once("error", cb)
    sock.once("connect", () => {
      sock.write(`CONNECT ${options.host}:${options.port || 443} HTTP/1.1\r\nHost: ${options.host}:${options.port || 443}\r\n\r\n`)
      let buf = ""
      const onData = (d) => {
        buf += d.toString("latin1")
        const i = buf.indexOf("\r\n\r\n")
        if (i < 0) return
        sock.removeListener("data", onData)
        if (!/^HTTP\/1\.[01] 200/.test(buf)) return cb(new Error("proxy: " + buf.split("\r\n")[0]))
        const rest = Buffer.from(buf.slice(i + 4), "latin1")
        const t = tls.connect({ socket: sock, servername: options.servername || options.host })
        t.once("secureConnect", () => {
          if (rest.length) t.unshift(rest)
          cb(null, t)
        })
        t.once("error", cb)
      }
      sock.on("data", onData)
    })
  }
}

const agent = proxy ? new ProxyAgent({ keepAlive: true }) : null

function getJSON(url, { token, headers = {}, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      {
        host: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "GET",
        agent,
        headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        timeout,
      },
      (res) => {
        let s = ""
        res.setEncoding("utf8")
        res.on("data", (c) => (s += c))
        res.on("end", () => {
          if (res.statusCode >= 400) {
            let why = s.slice(0, 200)
            try {
              const j = JSON.parse(s)
              why = j?.error?.message ?? j?.error ?? j?.message ?? why
            } catch {}
            const e = new Error(`${u.host} ${res.statusCode}: ${why}`)
            e.status = res.statusCode
            return reject(e)
          }
          try {
            resolve(JSON.parse(s))
          } catch {
            reject(new Error(`${u.host} answered something that is not JSON`))
          }
        })
      },
    )
    req.on("timeout", () => req.destroy(new Error("timed out")))
    req.on("error", reject)
    req.end()
  })
}

// ── the data the page shows ───────────────────────────────────────────────

const cache = new Map() // url → { at, value }
const cached = async (key, ttl, fn) => {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ttl) return hit.value
  const value = await fn()
  cache.set(key, { at: Date.now(), value })
  return value
}

function modelGroups(pricing, model, opts = {}) {
  return model.groups
    .map((g) => {
      const mult = multiplierOf(pricing, model.id, g)
      const price = mult != null ? priceOf(pricing, model, g) : null
      return {
        group: g,
        mult,
        input: price?.input ?? null,
        output: price?.output ?? null,
        restricted: Boolean(RESTRICTED[g]),
        allowed: allowedGroup(g, opts),
      }
    })
    .filter((x) => x.mult != null)
    .sort((a, b) => a.mult - b.mult)
}

async function liveByGroup(keys) {
  const out = new Map()
  const entries = Object.entries(keys)
  for (let i = 0; i < entries.length; i += 5) {
    const batch = entries.slice(i, i + 5)
    await Promise.all(
      batch.map(async ([group, key]) => {
        try {
          const j = await getJSON(INFER + "/v1/models", { token: key, timeout: 12000 })
          out.set(group, new Set((j?.data ?? []).map((m) => m.id)))
        } catch {
          out.set(group, null) // unknown (or down)
        }
      }),
    )
  }
  return out
}

async function buildOverview() {
  const { token, userID } = readAuth()
  if (!token) throw new Error("no sign-in found: run magpie plugin login packycode, or set PACKY_TOKEN")
  const raw = await cached("pricing", 120_000, () => getJSON(CONSOLE + "/api/pricing"))
  const pricing = parsePricing(raw)
  const summary = await cached("summary", 120_000, () =>
    getJSON(CONSOLE + "/api/perf-metrics/summary?hours=24").catch(() => ({ data: { models: [] } })),
  )
  const perf = new Map((summary?.data?.models ?? []).map((m) => [m.model_name, m]))
  const keys = readKeys()
  const live = await cached("live", 60_000, () => liveByGroup(keys))

  const models = []
  for (const m of pricing.models.values()) {
    if (m.quotaType === 1 || !(m.ratio > 0)) continue
    if (!m.endpoints.some((e) => e === "anthropic" || e === "openai" || e === "openai-response")) continue
    const groups = modelGroups(pricing, m)
    if (!groups.length) continue
    // the channel the plugin would use: cheapest allowed group that is up
    const current =
      groups.find((g) => !g.restricted && g.mult != null && (live.get(g.group)?.has(m.id) ?? null) !== false) ??
      groups.find((g) => !g.restricted) ??
      groups[0]
    const p = perf.get(m.id)
    models.push({
      id: m.id,
      ratio: m.ratio,
      current: current?.group ?? "",
      currentMult: current?.mult ?? null,
      input: current?.input ?? null,
      output: current?.output ?? null,
      success: p?.success_rate ?? null,
      latency: p?.avg_latency_ms ?? null,
      tps: p?.avg_tps ?? null,
      issues: p?.health?.issues?.map((x) => `${x.group}:${x.signal}`) ?? [],
      groups,
    })
  }
  models.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return {
    at: new Date().toISOString(),
    console: CONSOLE,
    infer: INFER,
    user: userID || "",
    groups: [...pricing.groupRatio.entries()].map(([group, mult]) => ({
      group,
      mult,
      restricted: Boolean(RESTRICTED[group]),
      hasKey: Boolean(keys[group]),
      live: live.get(group) ? live.get(group).size : null,
    })),
    models,
  }
}

async function buildRecent() {
  const { token, userID } = readAuth()
  if (!token) throw new Error("no sign-in found")
  const j = await cached("recent", 30_000, () =>
    getJSON(CONSOLE + "/api/log/self?p=0&page_size=30&type=2", {
      token,
      headers: userID ? { "new-api-user": String(userID) } : {},
    }),
  )
  return {
    at: new Date().toISOString(),
    items: (j?.data?.items ?? []).map((it) => ({
      at: new Date((it.created_at ?? 0) * 1000).toISOString(),
      model: it.model_name ?? "",
      group: it.group ?? "",
      channel: it.channel_name || (it.channel != null ? String(it.channel) : ""),
      tokensIn: it.prompt_tokens ?? 0,
      tokensOut: it.completion_tokens ?? 0,
      quota: it.quota ?? 0,
      ms: it.use_time ?? null,
      stream: Boolean(it.is_stream),
    })),
  }
}

async function buildModel(name) {
  const { token } = readAuth()
  const raw = await cached("pricing", 120_000, () => getJSON(CONSOLE + "/api/pricing"))
  const pricing = parsePricing(raw)
  const m = pricing.models.get(name)
  if (!m) throw new Error("no such model: " + name)
  const perf = await cached("perf:" + name, 60_000, () =>
    getJSON(CONSOLE + `/api/perf-metrics?model=${encodeURIComponent(name)}&hours=24`).catch(() => null),
  )
  const byGroup = new Map((perf?.data?.groups ?? []).map((g) => [g.group, g]))
  const keys = readKeys()
  const live = await cached("live", 60_000, () => liveByGroup(keys))
  const groups = modelGroups(pricing, m).map((g) => ({
    ...g,
    live: live.get(g.group)?.has(name) ?? null,
    hasKey: Boolean(keys[g.group]),
    success: byGroup.get(g.group)?.success_rate ?? null,
    ttft: byGroup.get(g.group)?.avg_ttft_ms ?? null,
    latency: byGroup.get(g.group)?.avg_latency_ms ?? null,
    tps: byGroup.get(g.group)?.avg_tps ?? null,
  }))
  // the one the plugin would ask: cheapest allowed channel that answers now
  const current = groups.find((g) => !g.restricted && g.live !== false) ?? groups[0] ?? null
  return { id: name, ratio: m.ratio, completion: m.completion, current: current?.group ?? "", groups }
}

// ── the page ──────────────────────────────────────────────────────────────

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>PackyCode 渠道看板</title>
<style>
  :root { --bg:#0f1115; --card:#171a21; --line:#262b36; --fg:#e6e8ee; --muted:#8b93a7; --ok:#3ecf8e; --bad:#f2545b; --warn:#f5a623; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f7f9; --card:#fff; --line:#e4e7ec; --fg:#1b1f27; --muted:#68708a; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif; background:var(--bg); color:var(--fg); }
  header { display:flex; gap:16px; align-items:baseline; padding:18px 22px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; }
  .muted { color:var(--muted); font-size:12px; }
  main { display:grid; grid-template-columns: minmax(420px, 1.15fr) minmax(420px, 1fr); gap:0; height:calc(100vh - 64px); }
  .pane { overflow:auto; padding:14px 16px; }
  .pane.detail { border-left:1px solid var(--line); }
  input[type=search] { width:100%; padding:8px 10px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); margin-bottom:10px; }
  table { width:100%; border-collapse:collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { position:sticky; top:0; background:var(--bg); color:var(--muted); font-weight:500; font-size:12px; }
  tr.model { cursor:pointer; }
  tr.model:hover, tr.model.sel { background:var(--card); }
  .tag { display:inline-block; padding:0 6px; border-radius:6px; font-size:11px; border:1px solid var(--line); color:var(--muted); }
  .tag.ok { color:var(--ok); border-color:color-mix(in srgb, var(--ok) 40%, transparent); }
  .tag.bad { color:var(--bad); border-color:color-mix(in srgb, var(--bad) 40%, transparent); }
  .tag.warn { color:var(--warn); border-color:color-mix(in srgb, var(--warn) 40%, transparent); }
  .num { text-align:right; }
  .name { max-width: 300px; overflow:hidden; text-overflow:ellipsis; }
  .right { text-align:right; }
  h2 { font-size:14px; margin:4px 0 8px; }
  .chips { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; }
  .chip { padding:2px 8px; border-radius:999px; border:1px solid var(--line); font-size:12px; color:var(--muted); }
  .chip b { color:var(--fg); font-weight:600; }
  .err { color:var(--bad); padding:16px; }
  details.recent { margin-top:18px; border-top:1px solid var(--line); padding-top:10px; }
  details.recent summary { cursor:pointer; color:var(--muted); font-size:12px; margin-bottom:6px; }
  details.groups { margin-bottom:14px; }
  details.groups summary { cursor:pointer; color:var(--muted); font-size:12px; margin-bottom:6px; }
</style></head><body>
<header>
  <h1>PackyCode 渠道看板</h1>
  <span class="muted" id="meta">加载中…</span>
  <span class="muted" style="margin-left:auto">数据：<a id="consoleLink" href="#" target="_blank" style="color:inherit">价目表</a> · 每 60 秒刷新</span>
</header>
<main>
  <section class="pane">
    <details class="groups" open>
      <summary>渠道概览 <span class="muted" id="gcount"></span></summary>
      <table id="groups"><thead><tr><th>渠道</th><th class="num">倍率</th><th>类型</th><th>Key</th><th class="num">在线模型</th></tr></thead><tbody></tbody></table>
    </details>
    <input id="q" type="search" placeholder="搜索模型…（如 opus / sonnet / kimi）">
    <table id="models"><thead><tr>
      <th>模型</th><th>当前渠道</th><th class="num">倍率</th><th class="num">输入 $/1M</th><th class="num">输出 $/1M</th><th class="num">24h 成功率</th><th class="num">TTFT</th><th>状态</th>
    </tr></thead><tbody></tbody></table>
  </section>
  <section class="pane detail">
    <div id="detail"><div class="muted">选一个模型看它所有渠道。</div></div>
    <details open class="recent">
      <summary>最近调用（实际渠道）</summary>
      <table id="recent"><thead><tr><th>时间</th><th>模型</th><th>渠道</th><th>节点</th><th class="num">in/out</th><th class="num">耗时</th></tr></thead><tbody></tbody></table>
    </details>
  </section>
</main>
<script>
let data = null
const $ = (s) => document.querySelector(s)
const fmt = (n, d = 2) => n == null ? '—' : Number(n).toFixed(d)
const ms = (n) => n == null ? '—' : (n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms')
const money = (n) => n == null ? '—' : '$' + Number(n).toFixed(2)
async function load() {
  try {
    const r = await fetch('/api/data'); const j = await r.json()
    if (j.error) throw new Error(j.error)
    data = j
    $('#meta').textContent = j.models.length + ' 个模型 · ' + j.groups.filter(g => !g.restricted).length + ' 个可用渠道 · ' + new Date(j.at).toLocaleTimeString()
    $('#consoleLink').href = j.console + '/pricing'
    draw()
  } catch (e) { $('#detail').innerHTML = '<div class="err">' + e.message + '</div>' }
}
function rows() {
  const q = $('#q').value.trim().toLowerCase()
  const body = $('#models tbody')
  body.innerHTML = ''
  for (const m of data.models) {
    if (q && !m.id.toLowerCase().includes(q)) continue
    const tr = document.createElement('tr'); tr.className = 'model'; tr.dataset.id = m.id
    const tags = m.issues.length ? m.issues.map(i => '<span class="tag warn">' + i + '</span>').join(' ') : ''
    tr.innerHTML = '<td class="name" title="' + m.id + '">' + m.id + '</td>' +
      '<td>' + (m.current || '—') + '</td>' +
      '<td class="num">' + (m.currentMult == null ? '—' : m.currentMult + '×') + '</td>' +
      '<td class="num">' + money(m.input) + '</td>' +
      '<td class="num">' + money(m.output) + '</td>' +
      '<td class="num">' + (m.success == null ? '—' : fmt(m.success) + '%') + '</td>' +
      '<td class="num">' + ms(m.latency) + '</td>' +
      '<td>' + (tags || '<span class="tag ok">正常</span>') + '</td>'
    tr.onclick = () => { document.querySelectorAll('tr.model').forEach(x => x.classList.remove('sel')); tr.classList.add('sel'); show(m.id) }
    body.append(tr)
  }
}
async function loadRecent() {
  try {
    const j = await (await fetch('/api/recent')).json()
    if (j.error) throw new Error(j.error)
    const tb = document.querySelector('#recent tbody')
    tb.innerHTML = ''
    for (const r of j.items) {
      const tr = document.createElement('tr')
      tr.innerHTML = '<td>' + new Date(r.at).toLocaleTimeString() + '</td>' +
        '<td class="name" title="' + r.model + '">' + r.model + '</td>' +
        '<td>' + (r.group || '—') + (r.stream ? ' <span class="tag">流</span>' : '') + '</td>' +
        '<td class="muted">' + (r.channel || '—') + '</td>' +
        '<td class="num">' + r.tokensIn + '/' + r.tokensOut + '</td>' +
        '<td class="num">' + (r.ms == null ? '—' : (r.ms >= 1000 ? (r.ms / 1000).toFixed(1) + 's' : r.ms + 'ms')) + '</td>'
      tb.append(tr)
    }
  } catch (e) {
    document.querySelector('#recent tbody').innerHTML = '<tr><td colspan="6" class="err">' + e.message + '</td></tr>'
  }
}

function draw() {
  const gb = document.querySelector('#groups tbody')
  gb.innerHTML = ''
  for (const g of data.groups) {
    const tr = document.createElement('tr')
    tr.innerHTML = '<td>' + g.group + '</td>' +
      '<td class="num">' + (g.mult == null ? '—' : g.mult + '×') + '</td>' +
      '<td>' + (g.restricted ? '<span class="tag bad">受限</span>' : '<span class="tag ok">可用</span>') + '</td>' +
      '<td>' + (g.hasKey ? '有' : '<span class="muted">无</span>') + '</td>' +
      '<td class="num">' + (g.live == null ? '—' : g.live) + '</td>'
    gb.append(tr)
  }
  $('#gcount').textContent = '（' + data.groups.length + ' 个渠道）'
  rows()
}
$('#q').oninput = rows
async function show(id) {
  const d = $('#detail')
  d.innerHTML = '<div class="muted">加载 ' + id + ' 的渠道…</div>'
  try {
    const j = await (await fetch('/api/model?name=' + encodeURIComponent(id))).json()
    if (j.error) throw new Error(j.error)
    const rows = j.groups.map(g => '<tr>' +
      '<td>' + g.group + (g.group === j.current ? ' <span class="tag ok">当前</span>' : '') + (g.restricted ? ' <span class="tag bad">受限</span>' : '') + '</td>' +
      '<td class="num">' + (g.mult == null ? '—' : g.mult + '×') + '</td>' +
      '<td class="num">' + money(g.input) + '</td>' +
      '<td class="num">' + money(g.output) + '</td>' +
      '<td>' + (g.live === true ? '<span class="tag ok">在线</span>' : g.live === false ? '<span class="tag bad">无渠道</span>' : g.hasKey ? '<span class="tag">未知</span>' : '<span class="tag">无 key</span>') + '</td>' +
      '<td class="num">' + (g.success == null ? '—' : fmt(g.success) + '%') + '</td>' +
      '<td class="num">' + ms(g.ttft) + '</td>' +
      '<td class="num">' + (g.tps == null ? '—' : fmt(g.tps)) + '</td>' +
      '</tr>').join('')
    d.innerHTML = '<h2>' + id + '</h2><div class="chips">' +
      '<span class="chip">模型倍率 <b>' + j.ratio + '</b></span>' +
      '<span class="chip">补全倍率 <b>' + (j.completion ?? '—') + '</b></span>' +
      '<span class="chip">渠道 <b>' + j.groups.length + '</b></span></div>' +
      '<table><thead><tr><th>渠道</th><th class="num">倍率</th><th class="num">输入 $/1M</th><th class="num">输出 $/1M</th><th>实时</th><th class="num">24h 成功率</th><th class="num">TTFT</th><th class="num">TPS</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="muted">倍率 = 模型倍率 × 渠道倍率 × 高峰系数；「当前」是按此刻可用性估算的，实际走的渠道见下面「最近调用」。</p>'
  } catch (e) { d.innerHTML = '<div class="err">' + e.message + '</div>' }
}
load(); loadRecent(); setInterval(load, 60000); setInterval(loadRecent, 30000)
</script></body></html>`

// ── serve ─────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const send = (code, body, type = "application/json; charset=utf-8") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" })
    res.end(typeof body === "string" ? body : JSON.stringify(body))
  }
  try {
    if (u.pathname === "/") return send(200, HTML, "text/html; charset=utf-8")
    if (u.pathname === "/api/data") return send(200, await buildOverview())
    if (u.pathname === "/api/model") return send(200, await buildModel(u.searchParams.get("name") || ""))
    if (u.pathname === "/api/recent") return send(200, await buildRecent())
    send(404, { error: "not found" })
  } catch (e) {
    send(500, { error: String(e?.message ?? e) })
  }
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`PackyCode 渠道看板: http://127.0.0.1:${PORT}`)
  console.log(`  控制台 ${CONSOLE}（${proxy ? "经代理 " + proxy : "直连"}） · 推理 ${INFER}`)
})
