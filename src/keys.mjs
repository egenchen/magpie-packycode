// The keys of the tokens this plugin makes for itself.
//
// PackyAPI used to hand every token's key back with the list (`/api/token/search`
// and `/api/token/{id}`); since late October it returns only key_prefix and
// key_hint, so a key is readable once, in the create answer, and never again.
// What the plugin makes it therefore keeps here, one entry per group, or the
// next start would have tokens nobody can use.

import fs from "node:fs"
import path from "node:path"

export const MADE_FILE = "packycode-keys.json"

export function loadMade(dir) {
  if (!dir) return {}
  const file = path.join(dir, MADE_FILE)
  try {
    const st = fs.lstatSync(file, { throwIfNoEntry: false })
    if (!st || st.isSymbolicLink()) return {}
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    const out = {}
    for (const [group, rec] of Object.entries(raw ?? {})) {
      if (typeof rec?.key === "string" && rec.key.length >= 16) {
        out[group] = { id: rec.id, key: rec.key, name: typeof rec.name === "string" ? rec.name : "" }
      }
    }
    return out
  } catch {
    return {}
  }
}

export function saveMade(dir, made) {
  if (!dir) return
  const file = path.join(dir, MADE_FILE)
  try {
    const st = fs.lstatSync(file, { throwIfNoEntry: false })
    if (st?.isSymbolicLink()) return
    const body = {}
    for (const [group, rec] of Object.entries(made ?? {})) body[group] = { id: rec.id, key: rec.key, name: rec.name ?? "" }
    fs.writeFileSync(file, JSON.stringify(body, null, 1), { mode: 0o600 })
  } catch {
    /* a read-only folder: the keys still last this run */
  }
}
