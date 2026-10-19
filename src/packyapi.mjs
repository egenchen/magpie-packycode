// PackyAPI's two faces: the console under /api (needs a system access token
// and the numeric user id in New-Api-User) and the relay under /v1 (needs an
// API key, which is a token bound to one or more groups).
//
// cf.api.fan serves only /v1; slb-v1.api.fan and www.packyapi.com serve
// both. www.packyapi.ai answers /api with a Cloudflare block, so it is not
// a console host here.

import { json } from "./http.mjs"

const HOSTS = {
  slb: "https://slb-v1.api.fan",
  cf: "https://cf.api.fan",
  www: "https://www.packyapi.com",
}

export const ENDPOINTS = [
  { value: "slb", label: "优化线路 slb-v1.api.fan（推荐）" },
  { value: "cf", label: "全球 cf.api.fan" },
  { value: "www", label: "主站 www.packyapi.com" },
]

export function inferBase(endpoint) {
  return HOSTS[endpoint] ?? HOSTS.slb
}

/** where the console API is: the same host, but cf has no console. */
export function consoleBase(endpoint) {
  const e = endpoint === "cf" ? "slb" : endpoint
  return HOSTS[e] ?? HOSTS.slb
}

const ua = "magpie-packycode/0.1 (+magpie plugin)"

/** the console's headers: the access token and the numeric user id. */
function consoleHeaders(accessToken, userID) {
  return {
    authorization: `Bearer ${accessToken}`,
    "new-api-user": String(userID),
    "user-agent": ua,
  }
}

export class PackyAPI {
  constructor({ endpoint = "slb", accessToken = "", userID = "", fetchImpl } = {}) {
    this.endpoint = endpoint
    this.accessToken = accessToken
    this.userID = userID
    this.fetch = fetchImpl
  }

  /** the relay's base, ending where magpie's /v1 does. */
  get infer() {
    return inferBase(this.endpoint) + "/v1"
  }

  get console() {
    return consoleBase(this.endpoint)
  }

  get signedIn() {
    return Boolean(this.accessToken && this.userID)
  }

  #api(path, opts = {}) {
    if (!this.signedIn) throw new Error("PackyAPI: no system access token")
    return json(this.console + path, {
      ...opts,
      headers: consoleHeaders(this.accessToken, this.userID),
      fetchImpl: this.fetch,
    })
  }

  // ── public: no sign-in ────────────────────────────────────────────────

  status() {
    return json(`${this.console}/api/status`, { fetchImpl: this.fetch, timeout: 15000 })
  }

  pricing() {
    return json(`${this.console}/api/pricing`, { fetchImpl: this.fetch, timeout: 20000 })
  }

  /** one model's live numbers per group: success rate, TTFT, latency, TPS. */
  perf(model, hours = 24) {
    const q = new URLSearchParams({ model: String(model), hours: String(hours) })
    return json(`${this.console}/api/perf-metrics?${q}`, { fetchImpl: this.fetch, timeout: 15000 })
  }

  // ── the account ───────────────────────────────────────────────────────

  async self() {
    const r = await this.#api("/api/user/self")
    if (!r?.data) throw new Error("PackyAPI: no account in the answer")
    return r.data
  }

  /** every token of the account, newest first, with its full key. */
  async tokens() {
    const out = []
    for (let p = 0; p < 20; p++) {
      const r = await this.#api(`/api/token/search?p=${p}&size=100`)
      const items = r?.data?.items ?? []
      out.push(...items)
      if (items.length < 100 || out.length >= (r?.data?.total ?? 0)) break
    }
    return out
  }

  /** a token for one group, unlimited and never expiring; its key answers. */
  async createToken({ name, group }) {
    await this.#api("/api/token/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        group,
        unlimited_quota: true,
        expired_time: -1,
        remain_quota: 0,
        model_limits_enabled: false,
        model_limits: "",
        allow_ips: "",
      }),
    })
    // the list is written after the insert, so ask again until the token
    // it just made shows up
    for (let i = 0; i < 5; i++) {
      const r = await this.#api(`/api/token/search?p=0&size=20&keyword=${encodeURIComponent(name)}`)
      const found = (r?.data?.items ?? []).find((t) => t.name === name)
      if (found) return found
      await new Promise((ok) => setTimeout(ok, 150))
    }
    throw new Error(`PackyAPI made "${name}" but did not list it`)
  }

  async deleteToken(id) {
    await this.#api(`/api/token/${id}`, { method: "DELETE" })
  }

  /**
   * The account's own request log: one row a request, with the group that
   * served it, the tokens, the quota charged and — in `other` — the ratios
   * that made up the charge. It is a scan, so a time window is what keeps
   * it fast.
   */
  async logs(from, to, size = 200) {
    const q = new URLSearchParams({
      p: "0",
      page_size: String(size),
      type: "2",
      start_timestamp: String(secs(from)),
      end_timestamp: String(secs(to)),
    })
    const r = await this.#api(`/api/log/self?${q}`, { timeout: 30000 })
    return r?.data?.items ?? []
  }

  /** what each token cost between two times (unix seconds), in quota units. */
  async usageByToken(from, to, pageSize = 100) {
    const q = new URLSearchParams({
      p: "1",
      page_size: String(pageSize),
      start_timestamp: String(secs(from)),
      end_timestamp: String(secs(to)),
    })
    const r = await this.#api(`/api/token/usage_detail?${q}`)
    return r?.data?.items ?? []
  }

  // ── a key's own view ──────────────────────────────────────────────────

  /** the models a key may call now, with the endpoints each takes. */
  async keyModels(key) {
    const r = await json(this.infer + "/models", {
      headers: { authorization: `Bearer ${key}`, "user-agent": ua },
      fetchImpl: this.fetch,
      timeout: 20000,
    })
    const list = Array.isArray(r?.data) ? r.data : []
    return list.map((m) => ({ id: m.id, endpoints: m.supported_endpoint_types ?? [] }))
  }

  /** what a key spent between two dates, in US cents. */
  async keyUsage(key, from, to) {
    const q = new URLSearchParams({ start_date: day(from), end_date: day(to) })
    const r = await json(this.infer + `/dashboard/billing/usage?${q}`, {
      headers: { authorization: `Bearer ${key}`, "user-agent": ua },
      fetchImpl: this.fetch,
      timeout: 20000,
    })
    return Number(r?.total_usage) || 0
  }

  /**
   * The groups a key is bound to, for free: a model no group serves is
   * turned away with the token's own groups in the message
   * ("已选分组=[default claude-officially]"), and one another group serves
   * names the group it was routed to. Nothing is spent — the request is
   * refused before any channel is asked.
   */
  async probeGroups(key) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(new Error("timed out")), 15000)
    let text = ""
    try {
      const res = await (this.fetch ?? globalThis.fetch)(this.infer + "/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "user-agent": ua,
        },
        body: JSON.stringify({
          model: "magpie-group-probe-does-not-exist",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: ctl.signal,
      })
      text = await res.text()
    } finally {
      clearTimeout(timer)
    }
    const all = /已选分组\s*=\s*\[([^\]]*)\]/.exec(text)
    if (all) {
      const groups = all[1].split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
      if (groups.length) return groups
    }
    const one = /分组\s*([^\s，,]+)\s*下模型/.exec(text)
    if (one) return [one[1]]
    const upper = /selected groups?\s*[:=]\s*\[([^\]]*)\]/i.exec(text)
    if (upper) return upper[1].split(/[\s,]+/).filter(Boolean)
    return null
  }
}

/** unix seconds from either a Date, seconds, or milliseconds. */
export function secs(t) {
  if (t instanceof Date) return Math.floor(t.getTime() / 1000)
  const n = Number(t) || 0
  return Math.floor(n > 1e12 ? n / 1000 : n)
}

export function day(d) {
  const x = d instanceof Date ? d : new Date(d)
  return x.toISOString().slice(0, 10)
}
