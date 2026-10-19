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

export function buildCatalog({ pricing, keys = [], opts = {}, liveKnown = false, base = "" }) {
  const out = {}
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
