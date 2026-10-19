// How a request is read, and what its failure means for the next key.

/** the model a request names: in its body, else in its path. */
export function modelOf(url, body) {
  if (typeof body === "string") {
    try {
      const j = JSON.parse(body)
      if (typeof j?.model === "string" && j.model) return j.model
    } catch {
      /* not JSON: the path below */
    }
  }
  const m = /\/(?:models|model)\/([^/:?]+)/.exec(String(url))
  return m ? decodeURIComponent(m[1]) : ""
}

/**
 * classify says whether another key could answer: a group with no channel,
 * a rate limit, a key out of credit or a channel that is down are worth
 * asking elsewhere; a request the relay turned away for its own shape is
 * not.
 *
 * A rest is kept short: the cheapest group failing once must not hand the
 * next request to one several times dearer for minutes. A minute, or what
 * the relay's Retry-After asks up to a minute, is enough for a blip; a group
 * that is really down fails fast when it is asked again.
 */
export function classify(status, text, headers) {
  const t = String(text ?? "")
  const why = reasonOfText(t)
  const noChannel = /无可用渠道|no available channel|当前令牌未覆盖|not covered by|model_not_found|model not found|已选分组|无可用分组/i.test(t)
  const retryAfter = retryAfterMs(headers)
  if (status >= 200 && status < 300) return { retry: false, why }
  if (status === 401 || status === 403) return { retry: true, cool: 10 * 60_000, whole: true, why }
  if (status === 402) return { retry: true, cool: 30 * 60_000, whole: true, why }
  if (status === 404 || status === 410) return { retry: true, cool: 5 * 60_000, why }
  if (noChannel) return { retry: true, cool: 60_000, why }
  if (status === 408 || status === 409 || status === 425 || status === 429) {
    return { retry: true, cool: Math.min(retryAfter || 30_000, 60_000), why }
  }
  if (status >= 500) return { retry: true, cool: 30_000, why }
  // 400/422 and the rest: the request's own shape, every group would say no
  return { retry: false, why }
}

function reasonOfText(t) {
  const s = String(t ?? "")
  try {
    const j = JSON.parse(s)
    return String(j?.error?.message ?? j?.message ?? "").slice(0, 400)
  } catch {
    return s.replace(/\s+/g, " ").trim().slice(0, 300)
  }
}

function retryAfterMs(headers) {
  const h = headers?.get?.("retry-after")
  if (!h) return 0
  const s = Number(h)
  if (Number.isFinite(s) && s > 0) return s * 1000
  const d = Date.parse(h)
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : 0
}

/** an error magpie reads as the account's sign-in being refused. */
export function signInError(e) {
  const msg = String(e?.message ?? e)
  if (/\b(401|403)\b/.test(msg)) {
    const err = new Error(`PackyAPI refused the system access token: ${msg}`)
    err.signIn = "expired"
    return err
  }
  return e
}
