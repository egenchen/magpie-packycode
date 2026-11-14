// What the plugin does when the console is rate limited by Cloudflare (1015):
// the last price list on disk keeps routing, and the keys already made keep
// working without asking the token list whether they are still there.

import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { PRICING } from "./fake.mjs"
import { World } from "../src/world.mjs"
import { saveMade } from "../src/keys.mjs"
import { saveSnapshot } from "../src/snapshot.mjs"

const dirs = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const dir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "packycode-resilience-"))
  dirs.push(d)
  return d
}

const auth = { type: "api", key: "tok-0123456789abcdef", metadata: { mode: "token", userID: "12345", endpoint: "slb" } }
const offline = async () => {
  const e = new Error("www.packyapi.com answered 429: error code: 1015")
  e.status = 429
  throw e
}

test("a rate-limited console still prices from the last list it answered", async () => {
  const d = dir()
  saveSnapshot(d, PRICING, { data: { quota_per_unit: 500000, price: 1 } })
  const w = new World(auth, {}, offline, d)
  const pricing = await w.pricing()
  assert.ok(pricing.models.size > 0, "models came from the snapshot")
  assert.ok(pricing.models.has("claude-x"))
})

test("the keys already made keep working when the token list cannot be read", async () => {
  const d = dir()
  saveMade(d, { cheap: { id: 7, key: "sk-cheap-aaaaaaaaaaaaaaaaa", name: "magpie-cheap" } })
  const w = new World(auth, {}, offline, d)
  const keys = await w.keys()
  assert.equal(keys.length, 1)
  assert.equal(keys[0].key, "sk-cheap-aaaaaaaaaaaaaaaaa")
  assert.deepEqual(keys[0].groups, ["cheap"])
})

test("no price list anywhere is an error, not an empty picker", async () => {
  const d = dir()
  const w = new World(auth, {}, offline, d)
  await assert.rejects(() => w.pricing(), /429|1015/)
})
