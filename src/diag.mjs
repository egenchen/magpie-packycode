// What went wrong, for the question "why did this request go to a dearer
// group": one line per failed attempt, in a file under magpie's config dir.
// A line holds the model, the group, the status and the relay's words — no
// key, no header, no request body.

import fs from "node:fs"
import path from "node:path"

export const FAILURE_FILE = "packycode-failures.jsonl"

// enough for the last few hundred failures; the file is rewritten when past it
const MAX = 256 * 1024

export function noteFailure(dir, record) {
  if (!dir) return
  try {
    const file = path.join(dir, FAILURE_FILE)
    const st = fs.lstatSync(file, { throwIfNoEntry: false })
    if (st?.isSymbolicLink()) return
    if (st && st.size > MAX) fs.writeFileSync(file, "", { mode: 0o600 })
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n", { mode: 0o600 })
  } catch {
    /* diagnostics are a nicety: never fail a request over them */
  }
}
