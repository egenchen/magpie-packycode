// A real-PackyAPI smoke test, read-only unless LIVE_CALL names a model.
//
//   PACKY_TOKEN=… PACKY_USER=1234 node scripts/live.mjs
//
// It prints what the plugin sees: groups, tokens, the catalog, and — with
// LIVE_CALL=<model> — one tiny request through the real gateway path.

import { PackyAPI } from "../src/packyapi.mjs"
import { World } from "../src/world.mjs"
import { buildCatalog } from "../src/catalog.mjs"
import { orderFor } from "../src/router.mjs"
import { money, usdOf } from "../src/http.mjs"

const accessToken = process.env.PACKY_TOKEN
const userID = process.env.PACKY_USER
const endpoint = process.env.PACKY_ENDPOINT || "slb"
const call = process.env.LIVE_CALL || ""

if (!accessToken || !userID) {
  console.error("set PACKY_TOKEN and PACKY_USER")
  process.exit(1)
}

const auth = { type: "api", key: accessToken, metadata: { accessToken, userID, endpoint, accountId: "packyapi-live" } }
const world = new World(auth, { manage_keys: process.env.MANAGE === "1" })
const api = new PackyAPI({ endpoint, accessToken, userID })

const t0 = Date.now()
const pricing = await world.pricing()
console.log(`pricing: ${pricing.models.size} models, ${pricing.groupRatio.size} groups in ${Date.now() - t0}ms`)
console.log(
  "groups:",
  [...pricing.groupRatio.entries()].sort((a, b) => a[1] - b[1]).map(([g, r]) => `${g} x${r}`).join(", "),
)

const me = await api.self()
console.log(`account: ${me.email} quota=${money(usdOf(me.quota, pricing.quotaPerUnit))} used=${money(usdOf(me.used_quota, pricing.quotaPerUnit))}`)

const tokens = await api.tokens()
console.log(`tokens: ${tokens.length}`)
for (const t of tokens) {
  console.log(`  ${t.name.padEnd(22)} ${String(t.group || t.groups || "default").padEnd(24)} ${t.key.slice(0, 10)}…`)
}

const keys = await world.keys()
console.log(`keys: ${keys.length}`)
for (const k of keys) {
  const live = await world.liveOf(k).catch(() => null)
  console.log(`  ${(k.name || k.key.slice(0, 8)).padEnd(22)} groups=[${k.groups.join(",")}] live=${live ? live.size : "?"}`)
  k.live = live
}

const cat = buildCatalog({ pricing, keys, opts: { check_performance: true }, liveKnown: keys.some((k) => k.live) })
console.log(`catalog: ${Object.keys(cat).length} models`)
for (const id of Object.keys(cat).slice(0, 40)) {
  const c = cat[id]
  console.log(`  ${id.padEnd(34)} $${c.cost.input.toFixed(2)}/$${c.cost.output.toFixed(2)} per 1M  ${c.api.npm}`)
}

if (call) {
  const perf = await world.perfOf(call)
  const cands = orderFor({ model: call, keys, pricing, perf, down: { keyed: new Map(), whole: new Map() }, opts: {} })
  console.log(`\nroute ${call}:`)
  for (const c of cands) console.log(`  ${c.group ?? c.skip} x${c.multiplier} ${c.key.name || c.key.key.slice(0, 8)}${c.cooling ? " (cooling)" : ""}`)
  const first = cands.find((c) => !c.skip)
  if (!first) process.exit(2)
  const started = Date.now()
  const res = await fetch(inferUrl(endpoint) + "/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${first.key.key}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: call, max_tokens: 4, messages: [{ role: "user", content: "say hi" }] }),
  })
  const text = await res.text()
  console.log(`  → ${res.status} in ${Date.now() - started}ms via ${first.group}: ${text.slice(0, 300)}`)
}

function inferUrl(e) {
  return e === "cf" ? "https://cf.api.fan/v1" : e === "www" ? "https://www.packyapi.com/v1" : "https://slb-v1.api.fan/v1"
}
