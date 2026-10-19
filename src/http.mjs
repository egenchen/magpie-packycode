// Small helpers shared by the plugin: HTTP with a timeout, money, and the
// clock of the peak-pricing windows.

/**
 * fetch JSON, failing with the status and a slice of the body. A 429 or a
 * 5xx is tried again a moment later (the relay rate-limits bursts, and a
 * plugin listing twenty groups is a burst), honouring Retry-After.
 */
export async function json(url, { method = "GET", headers = {}, body, timeout = 20000, signal, fetchImpl, tries = 3 } = {}) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    const out = await onceJSON(url, { method, headers, body, timeout, signal, fetchImpl })
    if (!out.retry || i === tries - 1) {
      if (out.error) throw out.error
      return out.value
    }
    await new Promise((ok) => setTimeout(ok, out.wait ?? 400 * Math.pow(2, i)))
    lastErr = out.error
  }
  throw lastErr
}

async function onceJSON(url, { method, headers, body, timeout, signal, fetchImpl }) {
  const f = fetchImpl ?? globalThis.fetch
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error("timed out")), timeout)
  const onAbort = () => ctl.abort(signal?.reason)
  if (signal) signal.addEventListener("abort", onAbort, { once: true })
  let res
  try {
    res = await f(url, {
      method,
      headers: { accept: "application/json", "user-agent": "magpie-packycode/0.1", ...headers },
      body,
      signal: ctl.signal,
    })
  } catch (e) {
    return { error: new Error(`${hostOf(url)}: ${e?.message ?? e}`) }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener("abort", onAbort)
  }
  let text
  try {
    text = await readText(res, 8 << 20)
  } catch (e) {
    return { error: new Error(`${hostOf(url)}: ${e?.message ?? e}`) }
  }
  if (!res.ok) {
    const err = new Error(`${hostOf(url)} answered ${res.status}${text ? ": " + clip(text, 200) : ""}`)
    const retry = res.status === 429 || res.status >= 500
    const wait = res.status === 429 ? Math.min(retryAfter(res.headers) || 600, 5000) : undefined
    return { error: err, retry, wait }
  }
  try {
    return { value: JSON.parse(text) }
  } catch {
    return { error: new Error(`${hostOf(url)} answered something that is not JSON: ${clip(text, 120)}`) }
  }
}

function retryAfter(headers) {
  const h = headers?.get?.("retry-after")
  if (!h) return 0
  const s = Number(h)
  if (Number.isFinite(s) && s > 0) return s * 1000
  const d = Date.parse(h)
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : 0
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return String(url)
  }
}

/**
 * the body of a response, but no more than max bytes: a vendor's error page,
 * or an answer that never ends, must not fill the plugin's memory or be read
 * a second time just to say what went wrong.
 */
export async function readText(res, max = 8 << 20) {
  const len = Number(res?.headers?.get?.("content-length") ?? 0)
  if (len > max) throw new Error(`the answer says ${len} bytes, past the ${max} a plugin reads`)
  if (!res?.body) return res?.text?.() ?? ""
  const reader = res.body.getReader()
  const chunks = []
  let n = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      n += value?.length ?? 0
      if (n > max) throw new Error(`the answer is past the ${max} bytes a plugin reads`)
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already done */
    }
  }
  const all = new Uint8Array(n)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.length
  }
  return new TextDecoder().decode(all)
}

export function clip(s, n) {
  s = String(s ?? "").replace(/\s+/g, " ").trim()
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

/** run `fn` over items, at most `n` at a time, keeping the order. */
export async function pooled(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const at = i++
      out[at] = await fn(items[at], at)
    }
  })
  await Promise.all(workers)
  return out
}

/** A promise memo that starts one load at a time and keeps its answer. */
function once(fn) {
  let p
  return (...args) => {
    if (!p) {
      p = Promise.resolve().then(() => fn(...args))
      p.catch(() => {
        p = undefined
      })
    }
    return p
  }
}

/** Cache with a deadline; `get` answers at once, `fresh` after a while. */
export class Cache {
  constructor(ttl, load) {
    this.ttl = ttl
    this.load = load
    this.at = 0
    this.value = undefined
    this.inflight = undefined
    this.error = undefined
  }

  stale() {
    return !this.at || Date.now() - this.at > this.ttl
  }

  /** the value, loaded when there is none or it is stale; throws its error. */
  async get() {
    if (!this.stale() && this.value !== undefined) return this.value
    return this.reload()
  }

  /** the value if there is one, however old, and reload in the background when stale. */
  async soft() {
    if (this.value !== undefined) {
      if (this.stale()) this.reload().catch(() => {})
      return this.value
    }
    return this.reload()
  }

  async reload() {
    if (!this.inflight) {
      this.inflight = Promise.resolve()
        .then(() => this.load())
        .then(
          (v) => {
            this.value = v
            this.at = Date.now()
            this.error = undefined
            return v
          },
          (e) => {
            // keep what we had: a relay having a bad minute is no reason to
            // forget every price
            this.error = e
            if (this.value !== undefined) return this.value
            throw e
          },
        )
        .finally(() => {
          this.inflight = undefined
        })
    }
    return this.inflight
  }
}

/** USD from a quota count, New API's 500000 units a dollar by default. */
export function usdOf(quota, perUnit = 500000, price = 1) {
  if (!Number.isFinite(quota) || !perUnit) return 0
  return (quota / perUnit) * price
}

export function money(n) {
  if (!Number.isFinite(n)) return "$0"
  if (n !== 0 && Math.abs(n) < 0.01) return "$" + n.toFixed(4)
  if (Math.abs(n) < 10) return "$" + n.toFixed(2)
  return "$" + n.toFixed(2)
}

/** hour and minute in a zone, plus the ISO weekday (1 = Monday). */
function zonedClock(date, timeZone) {
  let parts
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date)
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit" }).formatToParts(date)
  }
  const get = (t) => parts.find((p) => p.type === t)?.value
  const names = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
  return {
    weekday: names[get("weekday")] ?? date.getDay(),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  }
}

/** "09:00-12:00" in minutes, [start, end). */
function windowSpan(s) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(s).trim())
  if (!m) return null
  return [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])]
}

/** whether a peak rule runs at date: weekdays (1 = Monday) and windows. */
export function peakOn(rule, date) {
  if (!rule?.enabled) return false
  const { weekday, minutes } = zonedClock(date, rule.timezone || "Asia/Shanghai")
  if (Array.isArray(rule.weekdays) && rule.weekdays.length && !rule.weekdays.includes(weekday)) return false
  const spans = (rule.windows ?? []).map(windowSpan).filter(Boolean)
  if (!spans.length) return true
  return spans.some(([a, b]) => minutes >= a && minutes < b)
}
