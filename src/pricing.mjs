// PackyAPI's price list: what each token group charges for each model.
//
// GET /api/pricing answers, and needs no sign-in:
//
//   group_ratio          { "cc-sale": 0.8, "claude-officially": 7, … }
//   model_group_ratio    { "glm-sale": { "glm-5.3-flash": 0.5 }, … }
//   usable_group         { "cc-sale": "便宜的 claude code 分组…", … }
//   peak_active          { "deepseek-v4-pro": 2, … }   the factor now in force
//   data[]               a model: model_ratio, completion_ratio, cache_ratio,
//                        cache_creation_ratio_5m, quota_type, enable_groups,
//                        supported_endpoint_types
//
// The peak factor comes from `peak_active`, which the relay keeps current;
// the rule list is the fallback for a deployment that only sends that.
//
// A model's price in a group is
//
//   input  $/1M = model_ratio × 2 × group multiplier × peak factor
//   output $/1M = input × completion_ratio
//   cache read  = input × cache_ratio
//
// (New API counts 500000 quota units to the dollar; ratio 1 is $2 a million
// input tokens.) Every price in a group scales by that group's one
// multiplier, so the cheapest group for a model is simply the one with the
// smallest effective multiplier — no arithmetic needed to pick it.

import { peakOn } from "./http.mjs"

/** the multiplier a group charges for a model: its override, else the group's. */
export function multiplierOf(pricing, modelID, group) {
  const own = pricing.modelGroupRatio?.[group]?.[modelID]
  if (typeof own === "number" && isFinite(own)) return own
  const g = pricing.groupRatio?.get(group)
  if (typeof g === "number" && isFinite(g)) return g
  // a pool the price list no longer carries, whose multiplier we saw before
  const remembered = pricing.knownModels?.[group]?.[modelID]
  if (typeof remembered === "number" && isFinite(remembered)) return remembered
  const was = pricing.knownGroups?.[group]
  return typeof was === "number" && isFinite(was) ? was : null
}

/** what a model costs at a group, in USD per million tokens; null when unpriced. */
function peakFactorOf(pricing, modelID, at = Date.now()) {
  const live = pricing.peakActive?.[modelID]
  if (typeof live === "number" && live > 0) return live
  for (const rule of pricing.peakPricing?.rules ?? []) {
    if (!rule?.enabled) continue
    if (Array.isArray(rule.models) && rule.models.length && !rule.models.includes(modelID)) continue
    if (peakOn(rule, new Date(at))) return Number(rule.factor) > 0 ? Number(rule.factor) : 2
  }
  return 1
}

export function priceOf(pricing, model, group, at = Date.now()) {
  if (!model) return null
  const mult = multiplierOf(pricing, model.id, group)
  if (mult == null) return null
  if (model.quotaType === 1) {
    // per call (images, video): a fixed price each time
    const perCall = (model.price || 0) * mult
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, perCall, multiplier: mult, peak: 1, group, perCallOnly: true }
  }
  if (!(model.ratio > 0)) return null
  const peak = peakFactorOf(pricing, model.id, at)
  const input = model.ratio * 2 * mult * peak
  const output = input * (model.completion || 0)
  const cacheRead = model.cacheRead != null ? input * model.cacheRead : 0
  const cacheWrite = model.cacheWrite != null ? input * model.cacheWrite : 0
  return { input, output, cacheRead, cacheWrite, multiplier: mult, peak, group }
}

/** the groups a model may be called in, cheapest first (unpriced groups last). */
export function groupsByPrice(pricing, model, groups = model.groups) {
  return [...groups].sort((a, b) => {
    const ma = multiplierOf(pricing, model.id, a)
    const mb = multiplierOf(pricing, model.id, b)
    if (ma == null && mb == null) return a.localeCompare(b)
    if (ma == null) return 1
    if (mb == null) return -1
    return ma - mb || a.localeCompare(b)
  })
}

/** a model's endpoints as AI SDK packages magpie speaks. */
export function npmOf(model, family) {
  const eps = new Set(model.endpoints)
  // Claude is best spoken to on Anthropic's own API: thinking blocks, cache
  // controls and the rest survive a translated client that way.
  if (family === "claude" && eps.has("anthropic")) return "@ai-sdk/anthropic"
  if (family === "gpt" && eps.has("openai-response")) return "@ai-sdk/openai"
  if (eps.has("openai")) return "@ai-sdk/openai-compatible"
  if (eps.has("anthropic")) return "@ai-sdk/anthropic"
  if (eps.has("openai-response")) return "@ai-sdk/openai"
  // Gemini's protocol is not one a plugin model can name without the Code
  // Assist envelope, so a gemini-only model is left out (see catalog.mjs).
  return ""
}

/** the model family, for the API to speak and for what it can take. */
export function familyOf(id) {
  const s = String(id).toLowerCase()
  if (s.startsWith("claude")) return "claude"
  if (s.startsWith("gpt") || s.startsWith("o1") || s.startsWith("o3") || s.startsWith("o4") || s.includes("codex")) return "gpt"
  if (s.startsWith("gemini")) return "gemini"
  if (s.startsWith("grok")) return "grok"
  if (s.startsWith("glm")) return "glm"
  if (s.startsWith("deepseek")) return "deepseek"
  if (s.startsWith("kimi")) return "kimi"
  if (s.startsWith("qwen")) return "qwen"
  if (s.startsWith("mimo")) return "mimo"
  if (s.startsWith("minimax")) return "minimax"
  if (s.startsWith("jev")) return "jev"
  if (s.startsWith("omni")) return "openai"
  return "other"
}

/** whether a family's models reason (magpie offers thinking levels then). */
export function reasons(family, id) {
  if (family === "claude" || family === "gemini" || family === "gpt" || family === "grok") return true
  if (family === "glm" && /5|4\.7/.test(id)) return true
  if (family === "deepseek" && /v4|r1/i.test(id)) return true
  if (family === "kimi" && /k3|k2\.7|thinking/i.test(id)) return true
  if (family === "qwen" && /3/.test(id)) return true
  if (family === "mimo" && /2\.6|pro/.test(id)) return true
  if (family === "minimax" && /m3|m2\.7/.test(id)) return true
  return false
}

/** whether a model takes images. */
export function takesImages(family, id) {
  const s = String(id).toLowerCase()
  if (family === "claude" || family === "gemini" || family === "gpt" || family === "grok") return true
  if (family === "qwen") return /vl|omni/.test(s)
  if (family === "glm") return /v|vision/.test(s)
  if (family === "mimo") return /pro|vision|vl/.test(s)
  if (family === "kimi") return /vl|vision/.test(s)
  if (family === "minimax") return /vl/.test(s)
  return false
}

/**
 * parsePricing turns /api/pricing's answer into the shape the rest of the
 * plugin uses: groups, their multipliers, and models with the groups each
 * one is served in.
 */
export function parsePricing(raw, { quotaPerUnit = 500000, usdPerUnit = 1, at = Date.now() } = {}) {
  const groupRatio = new Map()
  for (const [g, r] of Object.entries(raw?.group_ratio ?? {})) {
    if (typeof r === "number" && isFinite(r)) groupRatio.set(g, r)
  }
  const usable = new Map(Object.entries(raw?.usable_group ?? {}))
  const models = new Map()
  for (const m of raw?.data ?? []) {
    if (!m?.model_name) continue
    const groups = (m.enable_groups ?? []).filter((g) => typeof g === "string")
    const endpoints = (m.supported_endpoint_types ?? []).filter((e) => typeof e === "string")
    models.set(m.model_name, {
      id: m.model_name,
      vendor: m.vendor_id,
      quotaType: m.quota_type ?? 0,
      ratio: Number(m.model_ratio) || 0,
      completion: Number(m.completion_ratio) || 0,
      cacheRead: typeof m.cache_ratio === "number" ? m.cache_ratio : null,
      cacheWrite: typeof m.cache_creation_ratio_5m === "number" ? m.cache_creation_ratio_5m : null,
      cacheWrite1h: typeof m.cache_creation_ratio_1h === "number" ? m.cache_creation_ratio_1h : null,
      price: Number(m.model_price) || 0,
      priceMin: Number(m.model_price_min) || 0,
      priceMax: Number(m.model_price_max) || 0,
      groups,
      endpoints,
      family: familyOf(m.model_name),
    })
  }
  return {
    at,
    quotaPerUnit,
    usdPerUnit,
    groupRatio,
    usable,
    modelGroupRatio: raw?.model_group_ratio ?? {},
    peakActive: raw?.peak_active ?? {},
    peakPricing: raw?.peak_pricing ?? { enabled: false, rules: [] },
    endpoints: raw?.supported_endpoint ?? {},
    autoGroups: raw?.auto_groups ?? [],
    models,
    // what a group charges in its own right (for showing a group's multiplier)
    groupMultiplier: (g) => groupRatio.get(g) ?? null,
  }
}
