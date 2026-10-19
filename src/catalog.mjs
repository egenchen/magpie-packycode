// The provider's model list: every chat model PackyAPI sells that a key of
// ours can reach, priced at the group the router would actually send it to.
//
// magpie calls this once per account and keeps the answer for an hour, so it
// may wait for the relay: the price list and each group's live models
// (GET /v1/models is a token's groups with a channel up now). A model no key
// of ours can call right now is left out, so an agent's picker holds what
// works rather than what the relay advertises. With no key at all (nobody
// signed in yet) the list is the price list's, unpriced by a key.

import { allowedGroup } from "./groups.mjs"
import { groupsByPrice, npmOf, priceOf, reasons, takesImages } from "./pricing.mjs"
import { orderFor } from "./router.mjs"

const CHAT_ENDPOINTS = new Set(["anthropic", "openai", "openai-response"])
const NO_DOWN = { keyed: new Map(), whole: new Map() }

// magpie shows an agent the first 24 models a plugin lists (manyModels), and
// takes them in this order: ours leads with the families most pickers look
// for, each newest model first, so a flagship doesn't fall off the end of the
// vendor's own price list — that list is ordered by neither family nor date.
const FAMILY_ORDER = ["claude", "gpt", "gemini", "grok", "deepseek", "kimi", "qwen", "glm", "mimo", "minimax", "jev", "openai", "other"]
const FAMILY_RANK = new Map(FAMILY_ORDER.map((f, i) => [f, i]))

// 5.5 out of "claude-opus-5-5", 6.1 out of "gpt-6.1-sol", 3 out of "kimi-k3":
// the first version in an id, read as numbers so 5.5 sorts above 4.10.
function versionOf(id, family) {
  const s = String(id).toLowerCase()
  const rest = family && s.startsWith(family) ? s.slice(family.length) : s
  const hit = rest.match(/\d+(?:[.-]\d+)*/)
  return hit ? hit[0].split(/[.-]/).map((n) => Number(n)) : []
}

function byVersion(a, b) {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? -1
    const y = b[i] ?? -1
    if (x !== y) return y - x
  }
  return 0
}

/**
 * the order models go to a picker in: family groups (Claude, GPT, Gemini,
 * then the rest), each family's newest models first, its flagship ahead of
 * its smaller siblings at one version, then the vendor's order.
 */
export function pickerOrder(models) {
  return models
    .slice()
    .sort((a, b) => {
      const fa = FAMILY_RANK.get(a.family) ?? FAMILY_ORDER.length
      const fb = FAMILY_RANK.get(b.family) ?? FAMILY_ORDER.length
      if (fa !== fb) return fa - fb
      const v = byVersion(versionOf(a.id, a.family), versionOf(b.id, b.family))
      if (v) return v
      const ra = a.ratio ?? 0
      const rb = b.ratio ?? 0
      if (ra !== rb) return rb - ra
      return String(a.id).localeCompare(String(b.id))
    })
}

export function buildCatalog({ pricing, keys = [], opts = {}, liveKnown = false, base = "" }) {
  const fits = []
  for (const m of pricing.models.values()) {
    if (m.quotaType === 1) continue // per call: an image or a video, not a chat
    if (!(m.ratio > 0)) continue
    if (!m.endpoints.some((e) => CHAT_ENDPOINTS.has(e))) continue
    const npm = npmOf(m, m.family)
    if (!npm) continue

    let group = null
    if (keys.length) {
      // the group the router would pick: cheapest group of a key that can
      // call it now, a key spanning several groups priced at its dearest
      const cands = orderFor({ model: m.id, keys, pricing, perf: null, down: NO_DOWN, opts })
      const top = cands.find((c) => !c.skip)
      if (!top) continue
      group = top.group
    } else {
      if (liveKnown) continue
      const groups = m.groups.filter((g) => allowedGroup(g, opts))
      if (!groups.length) continue
      group = groupsByPrice(pricing, m, groups)[0]
    }

    const price = group ? priceOf(pricing, m, group) : null
    const images = takesImages(m.family, m.id)
    fits.push({ m, npm, price, images })
  }

  const out = {}
  const byID = new Map(fits.map((f) => [f.m.id, f]))
  for (const m of pickerOrder(fits.map((f) => f.m))) {
    const { npm, price, images } = byID.get(m.id)
    out[m.id] = runtimeModel(m, { npm, price, images, base, name: prettyName(m.id, m.family) })
  }
  return out
}

// The vendor's ids as a picker reads them: claude-sonnet-5-5 is Claude
// Sonnet 5.5, gpt-5.6-sol is GPT-5.6 Sol, qwen3.7-flash is Qwen3.7 Flash.
const MAKERS = {
  claude: "Claude",
  gpt: "GPT",
  gemini: "Gemini",
  grok: "Grok",
  glm: "GLM",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  qwen: "Qwen",
  mimo: "MiMo",
  minimax: "MiniMax",
  jev: "Jev",
  omni: "Omni",
}

// how a maker's id reads with the version after it
const GLUE = { GPT: "-", GLM: "-", Qwen: "" }
const ACRONYMS = { vl: "VL", ai: "AI", id: "ID", xl: "XL" }

const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w)
const titleWord = (w) => {
  const lower = w.toLowerCase()
  if (ACRONYMS[lower]) return ACRONYMS[lower]
  if (/^v\d/.test(lower)) return "V" + w.slice(1)
  return cap(w)
}

export function prettyName(id, family) {
  const parts = String(id)
    .replace(/-\d{8}$/, "") // a trailing -20251101 date is noise in a picker
    .split("-")
    .filter(Boolean)
  if (!parts.length) return String(id)

  let maker = ""
  const lower = parts[0].toLowerCase()
  const key = Object.keys(MAKERS).find((k) => lower === k || lower.startsWith(k))
  if (key) {
    maker = MAKERS[key]
    const tail = parts[0].slice(key.length) // qwen3.7 → 3.7
    parts.shift()
    if (tail) parts.unshift(tail)
  }

  // two number tokens are one version: 5, 5 → 5.5
  const words = []
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i]
    const b = parts[i + 1]
    if (/^\d+$/.test(a) && /^\d+$/.test(b ?? "")) {
      words.push(`${a}.${b}`)
      i++
      continue
    }
    words.push(a)
  }

  const versionAt = words.findIndex((w) => /^v?\d/.test(w))
  const titled = words.map(titleWord)
  const body = titled.join(" ")
  if (!maker) return body
  const glue = GLUE[maker]
  if (versionAt === 0 && glue != null) return `${maker}${glue}${body}`
  return `${maker} ${body}`
}

function runtimeModel(m, { npm, price, images, base, name }) {
  return {
    id: m.id,
    providerID: "packycode",
    name: name || m.id,
    api: { id: m.id, url: base, npm },
    status: "active",
    headers: {},
    options: {},
    cost: {
      input: price?.input ?? 0,
      output: price?.output ?? 0,
      cache: { read: price?.cacheRead ?? 0, write: price?.cacheWrite ?? 0 },
    },
    // 0: magpie fills the window from its own catalog where it knows the
    // model; elsewhere an agent just gets no hint rather than a wrong one
    limit: { context: 0, output: 0 },
    capabilities: {
      temperature: true,
      reasoning: reasons(m.family, m.id),
      attachment: images,
      toolcall: true,
      input: { text: true, image: images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}
