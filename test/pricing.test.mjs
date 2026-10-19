import { test } from "node:test"
import assert from "node:assert/strict"

import { parsePricing, multiplierOf, priceOf, groupsByPrice, npmOf, familyOf } from "../src/pricing.mjs"
import { buildCatalog, prettyName } from "../src/catalog.mjs"
import { applyKnown, learnFromLogs, rememberPricing } from "../src/known.mjs"
import { PRICING } from "./fake.mjs"

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

const pricing = parsePricing(PRICING)
const claude = pricing.models.get("claude-x")

test("a group's multiplier is its own, else the group's", () => {
  assert.equal(multiplierOf(pricing, "claude-x", "cheap"), 0.5)
  assert.equal(multiplierOf(pricing, "claude-x", "nope"), null)
  const withOverride = parsePricing({ ...PRICING, model_group_ratio: { cheap: { "claude-x": 0.25 } } })
  assert.equal(multiplierOf(withOverride, "claude-x", "cheap"), 0.25)
})

test("a model's price follows New API's arithmetic", () => {
  // 3 × 2 × 0.5 = $3 a million input, output × 5, cache read a tenth
  const p = priceOf(pricing, claude, "cheap")
  assert.equal(p.input, 3)
  assert.equal(p.output, 15)
  near(p.cacheRead, 0.3)
  assert.equal(priceOf(pricing, claude, "nope"), null)
})

test("a pool the price list dropped keeps the multiplier it had", () => {
  const delisted = parsePricing({ ...PRICING, group_ratio: { cheap: 0.5, mid: 1, pricey: 2, cc: 2.5, codex: 0.8 } })
  delisted.knownGroups = { pricey: 2, gone: 0.8 }
  delisted.knownModels = { gone: { "claude-x": 0.4 } }
  assert.equal(multiplierOf(delisted, "claude-x", "pricey"), 2)
  assert.equal(multiplierOf(delisted, "claude-x", "gone"), 0.4) // its own model override
  assert.equal(multiplierOf(delisted, "claude-x", "unknown"), null)
  // and it sorts first when it is cheapest, as cc-sale did while delisted
  assert.deepEqual(groupsByPrice(delisted, delisted.models.get("claude-x"), ["pricey", "gone"]), ["gone", "pricey"])
})

test("the request log teaches a dropped pool's multiplier", () => {
  const p = parsePricing({ ...PRICING, group_ratio: { cheap: 0.5, mid: 1 } })
  const known = { groups: {}, models: {} }
  const rows = [
    { group: "cc-sale", model_name: "claude-x", other: JSON.stringify({ group_ratio: 0.8, model_ratio: 3 }) },
    { group: "cheap", model_name: "claude-x", other: JSON.stringify({ group_ratio: 0.5, model_ratio: 3 }) },
    { group: "broken", model_name: "claude-x", other: "not json" },
  ]
  assert.equal(learnFromLogs(known, rows, p), true)
  assert.equal(known.groups["cc-sale"], 0.8)
  assert.equal(known.groups["cheap"], undefined, "a listed pool is not overwritten by a log")
  applyKnown(p, known)
  assert.equal(multiplierOf(p, "claude-x", "cc-sale"), 0.8)
  assert.equal(groupsByPrice(p, p.models.get("claude-x"), ["mid", "cc-sale"])[0], "cc-sale")
})

test("a price list refreshes what was remembered", () => {
  const p = parsePricing({ ...PRICING, group_ratio: { cheap: 0.75 } })
  const known = { groups: { cheap: 0.5 }, models: {} }
  assert.equal(rememberPricing(known, p), true)
  assert.equal(known.groups.cheap, 0.75)
})

test("the peak factor doubles what it names", () => {
  const peak = parsePricing({ ...PRICING, peak_active: { "claude-x": 2 } })
  assert.equal(priceOf(peak, peak.models.get("claude-x"), "cheap").input, 6)
})

test("without peak_active the rule list still finds the peak", () => {
  const rules = {
    enabled: true,
    rules: [
      {
        enabled: true,
        timezone: "Asia/Shanghai",
        windows: ["09:00-12:00"],
        weekdays: [1, 2, 3, 4, 5],
        models: ["claude-x"],
        factor: 2,
      },
    ],
  }
  const p = parsePricing({ ...PRICING, peak_active: {}, peak_pricing: rules })
  const m = p.models.get("claude-x")
  // Monday 10:00 in Beijing is inside the window; Saturday is not
  assert.equal(priceOf(p, m, "cheap", Date.parse("2026-10-19T02:00:00Z")).input, 6)
  assert.equal(priceOf(p, m, "cheap", Date.parse("2026-10-17T02:00:00Z")).input, 3)
})

test("groups sort cheapest first, unpriced last", () => {
  const order = groupsByPrice(pricing, claude, ["pricey", "cheap", "unpriced", "mid"])
  assert.deepEqual(order, ["cheap", "mid", "pricey", "unpriced"])
})

test("endpoints choose the AI SDK package, Gemini's protocol is left out", () => {
  assert.equal(npmOf(claude, "claude"), "@ai-sdk/anthropic")
  assert.equal(npmOf(pricing.models.get("gpt-x"), "gpt"), "@ai-sdk/openai")
  assert.equal(npmOf(pricing.models.get("gem-only"), "gemini"), "")
  assert.equal(familyOf("claude-sonnet-5-5"), "claude")
})

test("a vendor id reads like a model's name", () => {
  const names = {
    "claude-sonnet-5-5": "Claude Sonnet 5.5",
    "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "qwen3.7-flash": "Qwen3.7 Flash",
    "deepseek-v4-pro": "DeepSeek V4 Pro",
    "glm-5.3-flashx": "GLM-5.3 Flashx",
    "kimi-k2.6": "Kimi K2.6",
    "MiniMax-M3": "MiniMax M3",
    "mimo-v2.6-pro-ultraspeed": "MiMo V2.6 Pro Ultraspeed",
    "grok-4.7": "Grok 4.7",
  }
  for (const [id, want] of Object.entries(names)) assert.equal(prettyName(id, ""), want, id)
})

test("with no key the catalog is the price list's, priced at the cheapest pool", () => {
  const cat = buildCatalog({ pricing, keys: [], opts: {} })
  assert.ok(cat["claude-x"])
  near(cat["claude-x"].cost.input, 3)
  assert.equal(cat["claude-x"].api.npm, "@ai-sdk/anthropic")
  assert.equal(cat["gpt-x"].api.npm, "@ai-sdk/openai")
  near(cat["gpt-x"].cost.input, 4) // pricey, the cheapest pool a third party may use
  assert.ok(!cat["img-x"], "per-call image models are not chat")
  assert.ok(!cat["gem-only"], "a Gemini-only endpoint is not one a plugin model can name")
  assert.ok(!cat["claude-only-cc"], "cc alone is restricted")
})

test("include_restricted opens the restricted pools", () => {
  const cat = buildCatalog({ pricing, keys: [], opts: { include_restricted: true } })
  assert.ok(cat["claude-only-cc"])
  near(cat["claude-only-cc"].cost.input, 5)
  near(cat["gpt-x"].cost.input, 1.6) // codex x0.8 is cheaper than pricey x2
})

test("a key's catalog is what it can call now, priced at its own group", () => {
  const keys = [{ key: "sk-a", groups: ["pricey"], live: new Map([["claude-x", []], ["gpt-x", []]]) }]
  const cat = buildCatalog({ pricing, keys, opts: {}, liveKnown: true })
  assert.deepEqual(Object.keys(cat).sort(), ["claude-x", "gpt-x"])
  near(cat["claude-x"].cost.input, 12) // pricey x2 × ratio 3 × 2
  near(cat["gpt-x"].cost.input, 4)

  const cheap = buildCatalog({ pricing, keys: [{ key: "sk-b", groups: ["cheap"], live: new Map([["claude-x", []]]) }], opts: {}, liveKnown: true })
  assert.deepEqual(Object.keys(cheap), ["claude-x"])
  near(cheap["claude-x"].cost.input, 3)
})
