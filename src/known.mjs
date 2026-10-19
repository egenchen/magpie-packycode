// What a group's multiplier was, for groups the price list stops carrying.
//
// PackyAPI removes a pool from /api/pricing now and then while its tokens
// keep working (cc-sale: 0.8, delisted for a while, still served and still
// charged at 0.8). Without remembering it, the cheapest pool becomes
// "unpriced" and the next one — four times dearer — is used instead.
//
// The file lives in magpie's config folder (the plugin is given it as
// `directory`), so a restart keeps what the last price list taught.

import fs from "node:fs"
import path from "node:path"

const FILE = "packycode-groups.json"

function knownFile(dir) {
  return dir ? path.join(dir, FILE) : ""
}

/** the multipliers last seen, per group and per group's model override. */
export function loadKnown(dir) {
  const out = { groups: {}, models: {} }
  const file = knownFile(dir)
  if (!file) return out
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"))
    for (const [g, v] of Object.entries(j?.groups ?? {})) if (typeof v === "number" && isFinite(v)) out.groups[g] = v
    for (const [g, ms] of Object.entries(j?.models ?? {})) {
      if (!ms || typeof ms !== "object") continue
      out.models[g] = {}
      for (const [m, v] of Object.entries(ms)) if (typeof v === "number" && isFinite(v)) out.models[g][m] = v
    }
  } catch {
    /* no file yet, or one this version can't read: start empty */
  }
  return out
}

export function saveKnown(dir, known) {
  const file = knownFile(dir)
  if (!file) return
  try {
    // never write through a link someone else put there: this is the one
    // file the plugin writes, so it is the one to keep to its own name
    const st = fs.lstatSync(file, { throwIfNoEntry: false })
    if (st?.isSymbolicLink()) return
    fs.writeFileSync(file, JSON.stringify({ ...known, at: Date.now() }, null, 1), { mode: 0o600 })
  } catch {
    /* a read-only folder: the memory still lasts this run */
  }
}

/** add what a price list says now to what is known; answers whether it changed. */
export function rememberPricing(known, pricing) {
  let changed = false
  for (const [g, mult] of pricing.groupRatio ?? []) {
    if (known.groups[g] !== mult) {
      known.groups[g] = mult
      changed = true
    }
  }
  for (const [g, ms] of Object.entries(pricing.modelGroupRatio ?? {})) {
    if (!ms || typeof ms !== "object") continue
    const row = (known.models[g] ??= {})
    for (const [m, v] of Object.entries(ms)) {
      if (typeof v !== "number" || !isFinite(v)) continue
      if (row[m] !== v) {
        row[m] = v
        changed = true
      }
    }
  }
  return changed
}

/**
 * Learn multipliers from the account's own request log: each row names the
 * group that served it and carries `group_ratio` in `other`, so a pool the
 * price list no longer carries still gets the price it was charged at
 * (cc-sale at 0.8 while delisted). Only pools the price list lacks are
 * written, so a stale log can't override the live list.
 */
export function learnFromLogs(known, rows, pricing) {
  let changed = false
  for (const row of rows) {
    const group = row?.group
    if (!group) continue
    let other = row.other
    if (typeof other === "string") {
      try {
        other = JSON.parse(other)
      } catch {
        continue
      }
    }
    const ratio = Number(other?.group_ratio)
    if (!Number.isFinite(ratio) || ratio <= 0) continue
    const inList = pricing.groupRatio?.has(group)
    if (!inList && known.groups[group] !== ratio) {
      known.groups[group] = ratio
      changed = true
    }
    const model = row.model_name
    const modelRatio = Number(other?.model_ratio)
    // a pool whose model carries its own multiplier: the log's ratio is
    // the one that was used for this model
    if (model && !pricing.modelGroupRatio?.[group]?.[model] && Number.isFinite(modelRatio)) {
      const asGroup = pricing.groupRatio?.get(group)
      if (!inList || (asGroup != null && Math.abs(asGroup - ratio) > 1e-9)) {
        const row2 = (known.models[group] ??= {})
        if (row2[model] !== ratio) {
          row2[model] = ratio
          changed = true
        }
      }
    }
  }
  return changed
}

/** attach the remembered multipliers to a parsed price list, as fallbacks. */
export function applyKnown(pricing, known) {
  pricing.knownGroups = known.groups ?? {}
  pricing.knownModels = known.models ?? {}
  return pricing
}
