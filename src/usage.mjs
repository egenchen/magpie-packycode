// The account's Usage card: balance, today's spend, and each group's share
// of the week, read from PackyAPI's own numbers rather than guessed from
// token counts.

import { money, usdOf } from "./http.mjs"

const cache = new Map() // account → { at, value }

/** the card for a world, at most a minute old. */
export async function usageOf(world) {
  const key = world.sig || world.auth?.key || "default"
  const had = cache.get(key)
  if (had && Date.now() - had.at < 60_000) return had.value
  const value = await readUsage(world)
  cache.set(key, { at: Date.now(), value })
  return value
}

export async function readUsage(world) {
  const pricing = await world.pricing()
  const perUnit = pricing.quotaPerUnit || 500000
  const now = Date.now()
  const dayStart = startOfDay(now, "Asia/Shanghai")
  const week = now - 7 * 86_400_000

  if (world.signedIn) {
    const [me, week7, keys] = await Promise.all([world.balance(), world.api.usageByToken(week, now).catch(() => []), world.keys().catch(() => [])])
    const today = await world.api.usageByToken(dayStart, now).catch(() => [])
    // a token is named after its group when the plugin made it; one the user
    // made is named by the groups it may use, so the card reads in groups
    const groupOf = new Map(keys.map((k) => [k.key, k.groups.join("+") || k.name || "other"]))
    const spentToday = today.reduce((s, x) => s + (Number(x.cost) || 0), 0)
    const spent7 = week7.reduce((s, x) => s + (Number(x.cost) || 0), 0)
    const byGroup = new Map()
    for (const x of week7) {
      const made = /^magpie-(.+)$/.exec(String(x.name ?? ""))?.[1]
      const label = made || groupOf.get(x.key) || x.name || "other"
      byGroup.set(label, (byGroup.get(label) ?? 0) + (Number(x.cost) || 0))
    }
    const total = spent7 || 1
    const windows = [...byGroup.entries()]
      .filter(([, cost]) => cost > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, cost]) => ({
        name,
        used: Math.round((cost / total) * 1000) / 10,
        amount: round(usdOf(cost, perUnit)),
        limit: round(usdOf(total, perUnit)),
        unit: "USD",
      }))
    return {
      plan: `PackyAPI · ${money(usdOf(spentToday, perUnit))} today`,
      user: me?.email || "",
      balance: money(me?.usd ?? 0),
      windows,
      signIn: "kept",
    }
  }

  // keys only: the relay's OpenAI-shaped billing endpoint answers for the
  // account behind a key (every key of one account says the same), so it is
  // asked once rather than added up per key
  const keys = await world.manualKeys()
  const cents = keys.length ? await world.api.keyUsage(keys[0].key, new Date(dayStart), new Date(now)).catch(() => 0) : 0
  return {
    plan: `PackyAPI · ${money(cents / 100)} today`,
    user: `${keys.length} key${keys.length === 1 ? "" : "s"}`,
    windows: [],
    signIn: "kept",
  }
}

function round(n) {
  return Math.round(n * 10000) / 10000
}

/** the unix ms a day starts at in a zone. */
export function startOfDay(ms, timeZone = "Asia/Shanghai") {
  const d = new Date(Number(ms) || Date.now())
  const { year, month, day } = ymdOf(d, timeZone)
  const offset = offsetMinutes(d, timeZone)
  const sign = offset < 0 ? "-" : "+"
  const abs = Math.abs(offset)
  const zone = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`
  return Date.parse(`${year}-${month}-${day}T00:00:00${zone}`)
}

/** the date in a zone, read part by part (en-CA's order is not every engine's). */
function ymdOf(d, timeZone) {
  let parts
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d)
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d)
  }
  const get = (t) => parts.find((p) => p.type === t)?.value ?? ""
  const year = get("year")
  const month = get("month").padStart(2, "0")
  const day = get("day").padStart(2, "0")
  if (year && month && day) return { year, month, day }
  return { year: String(d.getUTCFullYear()), month: String(d.getUTCMonth() + 1).padStart(2, "0"), day: String(d.getUTCDate()).padStart(2, "0") }
}

function offsetMinutes(date, timeZone) {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? "")
    if (!m) return 0
    return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
  } catch {
    return 0
  }
}
