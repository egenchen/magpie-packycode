import { test } from "node:test"
import assert from "node:assert/strict"

import { parsePricing } from "../src/pricing.mjs"
import { orderFor, explain, MIN_SUCCESS } from "../src/router.mjs"
import { PRICING } from "./fake.mjs"

const pricing = parsePricing(PRICING)
const key = (k, groups, live) => ({ key: k, groups, groupMode: groups.length > 1 ? "multi" : "single", live })
const down = () => ({ keyed: new Map(), whole: new Map() })

const keys = [key("sk-pricey", ["pricey"]), key("sk-cheap", ["cheap"]), key("sk-mid", ["mid"])]

test("the cheapest group goes first, the dearest last", () => {
  const c = orderFor({ model: "claude-x", keys, pricing, perf: null, down: down() })
  assert.deepEqual(
    c.map((x) => x.group),
    ["cheap", "mid", "pricey"],
  )
  assert.equal(c[0].multiplier, 0.5)
})

test("a group PackyAPI saw failing is left out while a healthy one is left", () => {
  const perf = new Map([
    ["cheap", { success: 40, ttft: 100 }],
    ["mid", { success: 99, ttft: 900 }],
  ])
  const c = orderFor({ model: "claude-x", keys, pricing, perf, down: down() })
  assert.deepEqual(
    c.map((x) => x.group),
    ["mid", "pricey", "cheap"],
  )
  assert.ok(MIN_SUCCESS > 40)
  // checking off: the cheap one leads again
  const off = orderFor({ model: "claude-x", keys, pricing, perf, down: down(), opts: { check_performance: false } })
  assert.equal(off[0].group, "cheap")
})

test("a restricted pool is only used when the user says so", () => {
  const cc = [key("sk-cc", ["cc"])]
  const c = orderFor({ model: "claude-x", keys: cc, pricing, perf: null, down: down() })
  assert.equal(c.length, 1)
  assert.equal(c[0].skip, "restricted")
  assert.match(explain("claude-x", c, pricing, cc), /forbids third-party/)

  const yes = orderFor({ model: "claude-x", keys: cc, pricing, perf: null, down: down(), opts: { include_restricted: true } })
  assert.equal(yes[0].group, "cc")
})

test("a multi-group key is priced at its dearest group, after a pinned one", () => {
  const mixed = [key("sk-multi", ["mid", "pricey"]), key("sk-mid", ["mid"])]
  const c = orderFor({ model: "claude-x", keys: mixed, pricing, perf: null, down: down() })
  assert.equal(c[0].multiplier, 1)
  assert.equal(c[0].multi, false)
  assert.equal(c[1].multiplier, 2) // pricey may answer it
  assert.equal(c[1].multi, true)
})

test("a key that does not list the model now is not asked", () => {
  const live = [key("sk-cheap", ["cheap"], new Map()), key("sk-mid", ["mid"], new Map([["claude-x", []]]))]
  const c = orderFor({ model: "claude-x", keys: live, pricing, perf: null, down: down() })
  assert.deepEqual(
    c.map((x) => x.key.key),
    ["sk-mid"],
  )
})

test("a cooled key goes after the open ones but is still offered", () => {
  const d = down()
  d.keyed.set("sk-cheap|claude-x", Date.now() + 60_000)
  const c = orderFor({ model: "claude-x", keys, pricing, perf: null, down: d })
  assert.equal(c[0].group, "mid")
  assert.equal(c.at(-1).group, "cheap")
})

test("a delisted pool still competes at the price it had", () => {
  const p = parsePricing(PRICING)
  p.knownGroups = { "cc-sale": 0.8 }
  p.models.get("claude-x").groups = ["cheap", "mid", "cc-sale"]
  const keys = [key("sk-cheap", ["cheap"]), key("sk-sale", ["cc-sale"]), key("sk-mid", ["mid"])]
  const c = orderFor({ model: "claude-x", keys, pricing: p, perf: null, down: down() })
  assert.deepEqual(
    c.map((x) => x.group),
    ["cheap", "cc-sale", "mid"],
  )
})

test("prefer_speed puts the healthier group first", () => {
  const perf = new Map([
    ["cheap", { success: 95, ttft: 5000 }],
    ["mid", { success: 99.9, ttft: 400 }],
  ])
  const c = orderFor({ model: "claude-x", keys, pricing, perf, down: down(), opts: { prefer_speed: true } })
  assert.equal(c[0].group, "mid")
})

test("a model no group of ours serves says so", () => {
  const none = [key("sk-cheap", ["cheap"])]
  const c = orderFor({ model: "gpt-x", keys: none, pricing, perf: null, down: down() })
  assert.equal(c.length, 0)
  assert.match(explain("gpt-x", c, pricing, none), /no PackyAPI key serves/)
})
