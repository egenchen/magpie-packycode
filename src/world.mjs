// Everything the plugin knows about one signed-in PackyAPI account: the
// price list, the tokens that are its keys, what each key may call right
// now, and how each group has been behaving.
//
// The price list and the live metrics are public, so a provider with no
// key still lists its models. Tokens need the system access token; without
// one the keys pasted at sign-in are used as they are.

import { Cache } from "./http.mjs"
import { PackyAPI } from "./packyapi.mjs"
import { parsePricing, multiplierOf, groupsByPrice } from "./pricing.mjs"
import { allowedGroup, NON_CHAT } from "./groups.mjs"
import { applyKnown, learnFromLogs, loadKnown, rememberPricing, saveKnown } from "./known.mjs"

const PREFIX = "magpie-"

// how many tokens this plugin will make for an account
const MAX_MADE_KEYS = 16

export class World {
  constructor(auth, options = {}, fetchImpl, dir = "") {
    this.auth = auth ?? {}
    const md = this.auth.metadata ?? {}
    this.mode = md.mode || (md.accessToken ? "token" : "keys")
    this.endpoint = md.endpoint || "slb"
    // the sign-in's key is what magpie asked for: the system access token
    // in token mode, one or more API keys in keys mode
    // the sign-in's key is the system access token in token mode; metadata
    // from older signs-in may hold a copy, which is read but no longer made
    this.accessToken = this.mode === "token" ? this.auth.key || md.accessToken || "" : ""
    this.userID = md.userID || ""
    this.manual = this.mode === "keys" ? splitKeys(this.auth.key) : []
    this.manualGroups = md.groups ?? {}
    this.probed = new Map() // key → groups when metadata has none
    this.options = options ?? {}
    this.dir = dir || ""
    this.known = loadKnown(this.dir)
    this.knownAt = 0
    this.learnedAt = 0
    this.api = new PackyAPI({ endpoint: this.endpoint, accessToken: this.accessToken, userID: this.userID, fetchImpl })

    this.pricingCache = new Cache(10 * 60_000, () => this.loadPricing())
    this.statusCache = new Cache(60 * 60_000, () => this.api.status())
    this.tokensCache = new Cache(5 * 60_000, () => (this.api.signedIn ? this.api.tokens() : []))
    this.liveCache = new Map() // group signature → Cache
    this.perfCache = new Map() // model → Cache
    this.created = new Map() // group → when a token was made, to not ask twice
    this.createFailed = new Map() // group → { until, why }
    this.keysCache = new Cache(5 * 60_000, () => this.ensureKeys())
    this.provisionEvery = 30 * 60_000
    this.provisionedAt = 0
  }

  get signedIn() {
    return this.api.signedIn
  }

  /** tokens are only made when the user turned that on (magpie asks them first). */
  get managesKeys() {
    return this.options.manage_keys === true && this.signedIn
  }

  // ── the price list ────────────────────────────────────────────────────

  async loadPricing() {
    const [raw, status] = await Promise.all([this.api.pricing(), this.statusCache.soft().catch(() => null)])
    const d = status?.data ?? {}
    const pricing = parsePricing(raw, {
      quotaPerUnit: Number(d.quota_per_unit) || 500000,
      usdPerUnit: Number(d.price) || 1,
    })
    const learned = rememberPricing(this.known, pricing)
    if (learned && Date.now() - this.knownAt > 60 * 60_000) {
      this.knownAt = Date.now()
      saveKnown(this.dir, this.known)
    }
    // the log knows the multipliers of pools the price list has dropped:
    // learning one is worth a second's query, once in a while
    if (this.signedIn && Date.now() - this.learnedAt > 30 * 60_000) {
      this.learnedAt = Date.now()
      this.learn(pricing).catch(() => {})
    }
    return applyKnown(pricing, this.known)
  }

  pricing() {
    return this.pricingCache.soft()
  }

  /** read the last week of the account's requests for the ratios used. */
  async learn(pricing) {
    const now = Date.now()
    const rows = await this.api.logs(now - 7 * 86_400_000, now, 200)
    if (!rows.length) return
    if (learnFromLogs(this.known, rows, pricing)) saveKnown(this.dir, this.known)
  }

  status() {
    return this.statusCache.soft()
  }

  /** the models a group serves, cheapest group first, from the price list alone. */
  async groupsFor(modelID) {
    const p = await this.pricing()
    const m = p.models.get(modelID)
    if (!m) return []
    return groupsByPrice(
      p,
      m,
      m.groups.filter((g) => !NON_CHAT.has(g)),
    )
  }

  // ── keys ──────────────────────────────────────────────────────────────

  /**
   * The keys this account may use: its tokens when signed in with an access
   * token, the keys pasted at sign-in otherwise. `create` lets the plugin
   * make a token per needed group (see ensureKeys).
   */
  async keys() {
    if (this.signedIn) return this.keysCache.soft()
    return this.manualKeys()
  }

  /** the keys pasted at sign-in, their groups read from the relay once. */
  async manualKeys() {
    return Promise.all(
      this.manual.map(async (key) => {
        let groups = this.manualGroups[key] ?? this.probed.get(key) ?? null
        if (!groups) {
          groups = (await this.api.probeGroups(key).catch(() => null)) ?? []
          this.probed.set(key, groups)
        }
        return { key, groups, groupMode: groups.length > 1 ? "multi" : "single", source: "manual", name: "" }
      }),
    )
  }

  async ensureKeys() {
    const tokens = await this.tokensCache.get()
    let keys = tokens
      .filter((t) => (t.status ?? 1) === 1 && !expired(t))
      .map((t) => tokenKey(t))
      .filter((k) => k.groups.length > 0)
    if (this.managesKeys && Date.now() - this.provisionedAt > this.provisionEvery) {
      this.provisionedAt = Date.now()
      const need = (await this.neededGroups()).slice(0, MAX_MADE_KEYS)
      const missing = need.filter((n) => !keys.some((k) => k.groupMode === "single" && k.groups[0] === n.group))
      // a few at a time: PackyAPI makes one token a call, and a burst of
      // sixteen is a good way to meet its rate limit
      for (let i = 0; i < missing.length; i += 4) {
        const made = await Promise.all(
          missing.slice(i, i + 4).map((n) =>
            this.makeKeyFor(n.group).catch((e) => {
              this.createFailed.set(n.group, { until: Date.now() + 30 * 60_000, why: e?.message ?? String(e) })
              return null
            }),
          ),
        )
        keys = [...keys, ...made.filter(Boolean)]
      }
      if (missing.length) this.tokensCache.reload().catch(() => {})
    }
    return keys
  }

  async makeKeyFor(group) {
    const failed = this.createFailed.get(group)
    if (failed && failed.until > Date.now()) return null
    const made = await this.api.createToken({ name: PREFIX + group, group })
    this.created.set(group, Date.now())
    this.tokensCache.reload().catch(() => {})
    return tokenKey(made)
  }

  /**
   * The groups worth holding a single-group key for: every group that is
   * one of the two cheapest a model is sold in, among the pools a third
   * party may use. One per model would leave it stranded while its cheapest
   * pool is in maintenance (cc-sale has been); two means the next cheapest
   * answers. They come busiest first, so a cap keeps the pools that cover
   * the most models.
   */
  async neededGroups() {
    const p = await this.pricing()
    const score = new Map()
    for (const m of p.models.values()) {
      if (m.quotaType === 1 || !(m.ratio > 0)) continue
      if (!m.endpoints.some((e) => e === "anthropic" || e === "openai" || e === "openai-response")) continue
      const groups = m.groups
        .filter((g) => this.allowed(g))
        .map((g) => ({ g, mult: multiplierOf(p, m.id, g) }))
        .filter((x) => x.mult != null)
        .sort((a, b) => a.mult - b.mult)
      for (const { g } of groups.slice(0, 2)) score.set(g, (score.get(g) ?? 0) + 1)
    }
    return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([group, models]) => ({ group, models }))
  }

  /** whether the user's options allow a group at all. */
  allowed(group) {
    return allowedGroup(group, this.options)
  }

  /**
   * What a key may call now: GET /v1/models is the token's groups' models
   * that have a live channel. Cached by group, since every key of one group
   * answers the same.
   */
  async liveOf(key) {
    const sig = key.groupMode === "single" ? "g:" + key.groups.join(",") : "k:" + key.key
    let c = this.liveCache.get(sig)
    if (!c) {
      c = new Cache(10 * 60_000, async () => {
        const list = await this.api.keyModels(key.key)
        const map = new Map()
        for (const m of list) map.set(m.id, m.endpoints ?? [])
        return map
      })
      this.liveCache.set(sig, c)
    }
    try {
      return await c.soft()
    } catch {
      return null // unknown: let the price list decide
    }
  }

  // ── how a group is doing ──────────────────────────────────────────────

  /** PackyAPI's own 24-hour numbers for a model, per group. */
  async perfOf(model) {
    let c = this.perfCache.get(model)
    if (!c) {
      c = new Cache(10 * 60_000, async () => {
        const r = await this.api.perf(model, 24)
        const map = new Map()
        for (const g of r?.data?.groups ?? []) {
          map.set(g.group, {
            success: Number(g.success_rate),
            ttft: Number(g.avg_ttft_ms),
            latency: Number(g.avg_latency_ms),
            tps: Number(g.avg_tps),
            points: (g.series ?? []).length,
          })
        }
        return map
      })
      this.perfCache.set(model, c)
    }
    try {
      return await c.soft()
    } catch {
      return null
    }
  }

  // ── money ─────────────────────────────────────────────────────────────

  async balance() {
    if (!this.signedIn) return null
    const me = await this.api.self()
    const p = await this.pricing()
    const quota = Number(me.quota) || 0
    return { quota, usd: (quota / p.quotaPerUnit) * p.usdPerUnit, usedQuota: Number(me.used_quota) || 0, email: me.email, username: me.username, id: me.id }
  }
}

/** a token record as a key: its groups in the order PackyAPI keeps them. */
function tokenKey(t) {
  const groups = groupsOfToken(t)
  return {
    key: t.key,
    id: t.id,
    name: t.name ?? "",
    groups,
    groupMode: groups.length > 1 ? "multi" : "single",
    source: "token",
  }
}

function groupsOfToken(t) {
  if (t.group_mode === "multi" && t.groups) {
    try {
      const arr = JSON.parse(t.groups)
      if (Array.isArray(arr)) return arr.filter((x) => typeof x === "string" && x)
    } catch {
      /* a plain string below */
    }
  }
  if (t.group && typeof t.group === "string") return t.group.split(/[\s,]+/).filter(Boolean)
  return []
}

/** one or more API keys pasted into the key field. */
function splitKeys(text) {
  return String(text ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 16)
    .map((s) => (s.startsWith("sk-") ? s : "sk-" + s))
}

function expired(t) {
  return typeof t.expired_time === "number" && t.expired_time > 0 && t.expired_time * 1000 < Date.now()
}


