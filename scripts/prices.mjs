// What every model costs on the cheapest group a third party may use, and
// where it is — the table this plugin's routing is trying to hit.
//
//   node scripts/prices.mjs            # 现在
//   node scripts/prices.mjs claude     # 只看 id 含 claude 的

import os from "node:os"
import path from "node:path"
import { PackyAPI } from "../src/packyapi.mjs"
import { applyKnown, loadKnown } from "../src/known.mjs"
import { parsePricing, groupsByPrice, priceOf } from "../src/pricing.mjs"
import { RESTRICTED, NON_CHAT } from "../src/groups.mjs"

const filter = (process.argv[2] || "").toLowerCase()
const api = new PackyAPI({ endpoint: process.env.PACKY_ENDPOINT || "slb" })
const known = loadKnown(process.env.MAGPIE_DIR || path.join(os.homedir(), ".config", "magpie"))
const pricing = applyKnown(parsePricing(await api.pricing()), known)

const rows = []
for (const m of pricing.models.values()) {
  if (m.quotaType === 1 || !(m.ratio > 0)) continue
  if (!m.endpoints.some((e) => e === "anthropic" || e === "openai" || e === "openai-response")) continue
  if (filter && !m.id.toLowerCase().includes(filter)) continue
  const allowed = m.groups.filter((g) => !RESTRICTED[g] && !NON_CHAT.has(g))
  const restricted = m.groups.filter((g) => RESTRICTED[g])
  const cheapest = allowed.length ? groupsByPrice(pricing, m, allowed)[0] : null
  const p = cheapest ? priceOf(pricing, m, cheapest) : null
  rows.push({ id: m.id, group: cheapest, mult: p?.multiplier ?? null, input: p?.input ?? 0, output: p?.output ?? 0, restricted: !allowed.length ? restricted.join(",") : "" })
}

rows.sort((a, b) => (a.input || 1e9) - (b.input || 1e9))
const pad = (s, n) => String(s).padEnd(n)
console.log(pad("model", 30), pad("cheapest group", 20), pad("x", 6), pad("in $/1M", 10), "out $/1M", "  (受限分组)")
for (const r of rows) {
  console.log(
    pad(r.id, 30),
    pad(r.group ?? "—", 20),
    pad(r.mult ?? "—", 6),
    pad(r.input ? r.input.toFixed(2) : "—", 10),
    pad(r.output ? r.output.toFixed(2) : "—", 8),
    r.restricted ? "  only " + r.restricted : "",
  )
}
console.log(`\n${rows.length} models · 倍率 <1 是折扣，>1 是加价 · 高峰时段 DeepSeek 系按 peak_active 翻倍`)
