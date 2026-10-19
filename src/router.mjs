// Which key a request goes out on.
//
// Every key is a PackyAPI token bound to one or more groups, and a group is
// a price multiplier on the model's own rate. The order is:
//
//   1. keys whose group actually serves the model right now (GET /v1/models
//      is the token's groups' live models),
//   2. keys on a group that is not one of the restricted pools (unless the
//      user opted in) — a restricted group in a multi-group key counts,
//      because the relay may route to it whatever we meant,
//   3. keys whose group is not known to be failing (PackyAPI's own 24-hour
//      success rate, and what this plugin saw recently),
//   4. cheapest first; when the price is equal, the key that pins a single
//      group, then the healthier and faster one.

import { multiplierOf, priceOf } from "./pricing.mjs"
import { RESTRICTED } from "./groups.mjs"

/** below this 24-hour success rate a group is skipped while another is left. */
export const MIN_SUCCESS = 88

/**
 * orderFor returns the keys to try, best first. It changes nothing; the
 * caller sends and records what came of it.
 *
 *   keys      [{ key, groups, groupMode }]   with `live` optional: a Map of
 *                model → endpoints from GET /v1/models
 *   pricing   parsePricing's answer
 *   perf      Map<group, {success, ttft}> or null
 *   down      { keyed: Map<"key|model", until>, whole: Map<key, until> }
 */
export function orderFor({ model, keys, pricing, perf, down, opts = {}, now = Date.now() }) {
  const info = pricing?.models?.get(model)
  const wanted = new Set(info?.groups ?? [])
  const out = []

  for (const k of keys ?? []) {
    if (!k?.key) continue
    if (k.live && !k.live.has(model)) continue
    const serving = k.groups.filter((g) => !info || wanted.has(g))
    if (!serving.length) continue

    // A key whose groups include a restricted pool cannot be pinned away
    // from it: the relay picks the channel among all of them.
    const restricted = serving.filter((g) => RESTRICTED[g])
    if (restricted.length && !opts.include_restricted) {
      out.push({ key: k, serving, group: null, multiplier: Infinity, price: null, multi: serving.length > 1, success: null, skip: "restricted", why: RESTRICTED[restricted[0]] })
      continue
    }

    const priced = serving
      .map((g) => ({ g, mult: multiplierOf(pricing, model, g) }))
      .filter((x) => x.mult != null)
      .sort((a, b) => a.mult - b.mult)

    // A multi-group key is charged at whatever group's channel answered, so
    // its price is the dearest of its groups, not the cheapest.
    const cheapest = priced[0]
    const dearest = priced[priced.length - 1]
    const multi = serving.length > 1
    const chosen = cheapest?.g ?? null
    const multiplier = priced.length ? (multi ? dearest.mult : cheapest.mult) : Infinity
    // what the cheapest serving group charges, for showing; the multiplier
    // (dearest for a multi-group key) is what the order uses
    const price = info && chosen ? priceOf(pricing, info, chosen) : null
    const stats = perf?.get(chosen) ?? null
    const keyed = down?.keyed?.get(k.key + "|" + model) ?? 0
    const whole = down?.whole?.get(k.key) ?? 0
    const cooling = Math.max(keyed, whole)

    out.push({
      key: k,
      serving,
      group: chosen,
      groups: priced.map((x) => x.g),
      multiplier,
      price: price ?? null,
      multi,
      success: stats?.success ?? null,
      ttft: stats?.ttft ?? null,
      cooling: cooling > now,
      why: "",
    })
  }

  const usable = out.filter((c) => !c.skip)
  // every candidate restricted: the answer says why rather than pretend
  if (!usable.length) return out

  // a group known to be failing is left out while anything else is left
  let pool = usable
  if (opts.check_performance !== false) {
    const healthy = pool.filter((c) => c.success == null || c.success >= MIN_SUCCESS)
    if (healthy.length) pool = healthy
  }
  const open = pool.filter((c) => !c.cooling)
  if (open.length) pool = open

  const byPrice = (a, b) => {
    if (a.multiplier !== b.multiplier) return a.multiplier - b.multiplier
    if (a.multi !== b.multi) return a.multi ? 1 : -1 // a pinned price first
    return health(b) - health(a)
  }
  const bySpeed = (a, b) => health(b) - health(a) || (a.ttft ?? 1e9) - (b.ttft ?? 1e9) || byPrice(a, b)

  pool.sort(opts.prefer_speed ? bySpeed : byPrice)
  // what was left out follows, worst first, so a caller may still ask it
  const rest = usable.filter((c) => !pool.includes(c)).sort(byPrice)
  return [...pool, ...rest]
}

function health(c) {
  if (c.success == null) return 50 // unknown: neither good nor bad
  return c.success
}

/** what to tell the user when no key can serve a model. */
export function explain(model, candidates, pricing, keys) {
  const restricted = candidates.filter((c) => c.skip === "restricted")
  if (restricted.length) {
    const groups = [...new Set(restricted.flatMap((c) => c.serving).filter((g) => RESTRICTED[g]))]
    return `${model} is only on ${groups.join(", ")} — PackyAPI forbids third-party clients there. Turn on "include_restricted" in the provider's options to use it anyway, at your own risk.`
  }
  const known = pricing?.models?.get(model)
  if (!known) return `${model} is not in PackyAPI's price list`
  if (!keys.length) return `no PackyAPI key yet: sign in to PackyAPI, or paste keys`
  return `no PackyAPI key serves ${model} right now (its groups: ${known.groups.join(", ")})`
}
