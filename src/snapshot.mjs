// The last price list that answered, on disk.
//
// The console (www.packyapi.com) sits behind Cloudflare, which answers 1015
// "rate limited" in bursts. Prices move rarely, so a plugin that already
// priced its groups can keep routing through such a burst; without this it
// would go blank the moment the cache aged out.

import fs from "node:fs"
import path from "node:path"

export const SNAPSHOT_FILE = "packycode-pricing.json"

export function loadSnapshot(dir) {
  if (!dir) return null
  const file = path.join(dir, SNAPSHOT_FILE)
  try {
    const st = fs.lstatSync(file, { throwIfNoEntry: false })
    if (!st || st.isSymbolicLink() || !st.size) return null
    const j = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!j || typeof j.raw !== "object" || !Array.isArray(j.raw?.data)) return null
    return { raw: j.raw, status: j.status ?? null, at: Number(j.at) || 0 }
  } catch {
    return null
  }
}

export function saveSnapshot(dir, raw, status) {
  if (!dir) return
  const file = path.join(dir, SNAPSHOT_FILE)
  try {
    const st = fs.lstatSync(file, { throwIfNoEntry: false })
    if (st?.isSymbolicLink()) return
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), raw, status: status ?? null }), { mode: 0o600 })
  } catch {
    /* a read-only folder: the memory still lasts this run */
  }
}
