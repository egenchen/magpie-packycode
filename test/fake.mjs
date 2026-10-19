// A stand-in for PackyAPI, for the tests: the price list, the console's
// token calls, /v1/models and the three inference paths, with keys that can
// be told to fail once or always.

import http from "node:http"

export const PRICING = {
  success: true,
  group_ratio: { cheap: 0.5, mid: 1, pricey: 2, cc: 2.5, codex: 0.8, image: 5 },
  usable_group: { cheap: "cheap pool", mid: "mid pool", pricey: "pricey pool", cc: "claude code only", codex: "codex only", image: "images" },
  model_group_ratio: {},
  peak_active: {},
  auto_groups: [],
  supported_endpoint: {
    anthropic: { path: "/v1/messages", method: "POST" },
    openai: { path: "/v1/chat/completions", method: "POST" },
    "openai-response": { path: "/v1/responses", method: "POST" },
    "image-generation": { path: "/v1/images/generations", method: "POST" },
  },
  data: [
    {
      model_name: "claude-x",
      quota_type: 0,
      model_ratio: 3,
      completion_ratio: 5,
      cache_ratio: 0.1,
      enable_groups: ["cheap", "mid", "pricey", "cc"],
      supported_endpoint_types: ["anthropic"],
    },
    {
      model_name: "claude-only-cc",
      quota_type: 0,
      model_ratio: 1,
      completion_ratio: 4,
      enable_groups: ["cc"],
      supported_endpoint_types: ["anthropic"],
    },
    {
      model_name: "gpt-x",
      quota_type: 0,
      model_ratio: 1,
      completion_ratio: 4,
      enable_groups: ["codex", "pricey"],
      supported_endpoint_types: ["openai-response", "openai"],
    },
    {
      model_name: "img-x",
      quota_type: 1,
      model_price: 0.04,
      enable_groups: ["image"],
      supported_endpoint_types: ["image-generation"],
    },
    {
      model_name: "gem-only",
      quota_type: 0,
      model_ratio: 0.5,
      completion_ratio: 2,
      enable_groups: ["pricey"],
      supported_endpoint_types: ["gemini"],
    },
  ],
}

/** live models per group: what GET /v1/models answers for a key of it. */
export const LIVE = {
  cheap: ["claude-x"],
  mid: ["claude-x"],
  pricey: ["claude-x", "gpt-x"],
  cc: ["claude-x", "claude-only-cc"],
  codex: ["gpt-x"],
  image: [],
}

export function fakePackyAPI({ tokens = [], live = LIVE, perf = {}, self = {}, usage = [] } = {}) {
  const state = {
    tokens: tokens.map((t, i) => ({ id: t.id ?? i + 1, status: 1, expired_time: -1, unlimited_quota: true, ...t })),
    fail: new Map(), // key → { status, body, times }
    requests: [], // { path, key, model }
    created: [],
    deleted: [],
    nextId: 1000,
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x")
    const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")
    const user = req.headers["new-api-user"]
    const name = url.pathname
    const body = await read(req)
    const json = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(obj))
    }
    const tokenOf = (key) => state.tokens.find((t) => t.key === key && t.status === 1)
    const groupsOf = (t) => {
      if (t.group_mode === "multi" && t.groups) return JSON.parse(t.groups)
      return t.group ? [t.group] : []
    }

    // ── console ──
    if (name === "/api/status") return json(200, { data: { quota_per_unit: 500000, price: 1 } })
    if (name === "/api/pricing") return json(200, PRICING)

    if (name === "/api/perf-metrics") {
      const model = url.searchParams.get("model")
      return json(200, { data: { model_name: model, groups: perf[model] ?? [] } })
    }

    if (name.startsWith("/api/user/self")) {
      if (!auth || !user) return json(401, { message: "未提供 New-Api-User", success: false })
      return json(200, { data: { id: 12345, quota: 50_000_000, used_quota: 2_000_000_000, email: "me@example.com", ...self }, success: true })
    }

    if (name === "/api/token/search") {
      const kw = url.searchParams.get("keyword") ?? ""
      const items = state.tokens.filter((t) => !kw || String(t.name).includes(kw))
      return json(200, { data: { page: 1, page_size: 100, total: items.length, items }, success: true })
    }

    if (name === "/api/token/" && req.method === "POST") {
      const p = JSON.parse(body || "{}")
      if (p.groups && typeof p.groups !== "string") return json(200, { message: "groups must be a string", success: false })
      const t = {
        id: state.nextId++,
        name: p.name,
        key: "sk-made-" + Math.random().toString(36).slice(2, 10),
        group: p.group ?? "",
        group_mode: "single",
        groups: "",
        status: 1,
        expired_time: p.expired_time ?? -1,
        unlimited_quota: !!p.unlimited_quota,
        used_quota: 0,
      }
      state.tokens.push(t)
      state.created.push(t)
      return json(200, { message: "", success: true })
    }

    if (name.startsWith("/api/token/") && req.method === "DELETE") {
      const id = Number(name.split("/").pop())
      const i = state.tokens.findIndex((t) => t.id === id)
      if (i >= 0) state.tokens.splice(i, 1)
      state.deleted.push(id)
      return json(200, { message: "", success: true })
    }

    if (name === "/api/token/usage_detail") {
      const from = Number(url.searchParams.get("start_timestamp") ?? 0)
      const to = Number(url.searchParams.get("end_timestamp") ?? 9e9)
      const at = (u) => Math.floor((u.at ?? 0) / 1000)
      const items = usage
        .filter((u) => at(u) >= from && at(u) <= to)
        .map((u) => ({ name: u.name, key: u.key, cost: u.cost, request_count: 1 }))
      return json(200, { data: { page: 1, page_size: 100, total: items.length, items }, success: true })
    }

    // ── relay ──
    if (name === "/v1/models") {
      const t = tokenOf(auth)
      if (!t) return json(401, { error: { message: "bad key" } })
      const ids = [...new Set(groupsOf(t).flatMap((g) => live[g] ?? []))]
      return json(200, { data: ids.map((id) => ({ id, object: "model", supported_endpoint_types: [] })) })
    }

    if (name === "/v1/dashboard/billing/usage") {
      return json(200, { object: "list", total_usage: 123.45 })
    }

    if (name === "/v1/messages" || name === "/v1/chat/completions" || name === "/v1/responses") {
      const p = JSON.parse(body || "{}")
      const t = tokenOf(auth)
      if (p.model === "magpie-group-probe-does-not-exist") {
        // the group probe is a request too, but not a call: keep it out of
        // the log the tests read
        const gs = t ? groupsOf(t) : []
        return json(400, { error: { message: `当前令牌未覆盖供应商 ""（模型=${p.model}，已选分组=[${gs.join(" ")}]）`, type: "packy_api_error" } })
      }
      const headers = {}
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v
      state.requests.push({ path: name, key: auth, model: p.model, groups: t ? groupsOf(t) : [], headers })
      if (!t) return json(401, { error: { message: "bad key" } })
      const f = state.fail.get(auth)
      if (f && f.times !== 0) {
        if (f.times > 0) f.times--
        return json(f.status ?? 503, f.body ?? { error: { message: "分组 x 下模型 y 无可用渠道", type: "packy_api_error" } })
      }
      return json(200, { id: "msg_1", type: "message", role: "assistant", model: p.model, content: [{ type: "text", text: "hi" }], usage: { input_tokens: 3, output_tokens: 1 } })
    }

    json(404, { error: { message: "not found: " + name } })
  })

  return {
    server,
    state,
    fail(key, { status = 503, body, times = -1 } = {}) {
      state.fail.set(key, { status, body, times })
    },
    heal(key) {
      state.fail.delete(key)
    },
    async listen() {
      await new Promise((r) => server.listen(0, "127.0.0.1", r))
      return { port: server.address().port, url: `http://127.0.0.1:${server.address().port}` }
    },
    async close() {
      await new Promise((r) => server.close(r))
    },
  }
}

function read(req) {
  return new Promise((resolve) => {
    let s = ""
    req.on("data", (c) => (s += c))
    req.on("end", () => resolve(s))
  })
}

/** point every host the plugin knows at a local server. */
export function routeFetchTo(port, realFetch = globalThis.fetch) {
  return (input, init) => {
    const u = new URL(String(input))
    u.protocol = "http:"
    u.host = `127.0.0.1:${port}`
    return realFetch(u, init)
  }
}
