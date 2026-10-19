// The order magpie shows models in: it exposes the first 24 a plugin lists
// (manyModels) and takes them in the order it got them, so the order is the
// plugin's way of keeping the models people look for inside that slice.

import test from "node:test"
import assert from "node:assert/strict"
import { PRICING } from "./fake.mjs"
import { parsePricing } from "../src/pricing.mjs"
import { buildCatalog, pickerOrder } from "../src/catalog.mjs"

const model = (id, family, ratio = 1) => ({ id, family, ratio })

test("a picker leads with the families it looks for, newest first", () => {
  const got = pickerOrder([
    model("qwen3.7-max", "qwen"),
    model("claude-opus-4-7", "claude", 2.5),
    model("claude-sonnet-5-5", "claude", 2),
    model("claude-opus-5-5", "claude", 3),
    model("gpt-6.1-sol", "gpt", 2),
    model("gemini-3-pro", "gemini"),
    model("grok-4.6", "grok"),
    model("deepseek-v4-pro", "deepseek"),
    model("kimi-k3", "kimi"),
    model("glm-5.3", "glm"),
    model("claude-haiku-5-5", "claude", 1),
    model("claude-opus-5", "claude", 2.5),
  ]).map((m) => m.id)

  assert.deepEqual(got, [
    "claude-opus-5-5", // 5.5 before 5
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-opus-5",
    "claude-opus-4-7",
    "gpt-6.1-sol",
    "gemini-3-pro",
    "grok-4.6",
    "deepseek-v4-pro",
    "kimi-k3",
    "qwen3.7-max",
    "glm-5.3",
  ])
})

test("a flagship cannot be pushed off the end of magpie's 24 by vendor order", () => {
  // the vendor's price list leads with unrelated ids; the first 24 magpie
  // exposes must still hold the models a Claude Code or Codex user wants
  const data = [
    ["qwen3.7-max", 1],
    ["glm-5.3-flashx", 0.5],
    ["gpt-6-astra", 2.5],
    ["kimi-k2.6", 1.2],
    ["claude-fable-5-1", 1],
    ["mimo-v2.6-flash", 0.3],
    ["gpt-6.1-sol", 3],
    ["claude-opus-5-5", 2],
    ["qwen3.8-max", 1.5],
    ["grok-4.6", 1.2],
    ["claude-sonnet-5-5", 1.5],
    ["mimo-v2.5-pro", 0.6],
    ["claude-opus-5", 2.5],
    ["kimi-k3", 1.2],
    ["gpt-5.6-sol", 2.5],
    ["claude-opus-4-8", 2.5],
    ["qwen3.6-max-preview", 1],
    ["claude-opus-4-7", 2.5],
    ["deepseek-v4-pro", 1],
    ["claude-sonnet-4-6", 1.5],
    ["glm-5.3", 1],
    ["claude-opus-4-6", 2.5],
    ["gpt-5.5", 2],
    ["claude-sonnet-4-5-20250929", 1.5],
    ["deepseek-v4-flash", 0.6],
    ["claude-haiku-4-5-20251001", 0.8],
  ]
  const pricing = parsePricing({
    ...PRICING,
    data: data.map(([model_name, model_ratio]) => ({
      model_name,
      quota_type: 0,
      model_ratio,
      completion_ratio: 4,
      cache_ratio: 0.1,
      enable_groups: ["cheap"],
      supported_endpoint_types: ["anthropic"],
    })),
  })
  const cat = buildCatalog({ pricing, keys: [], opts: {} })
  const ids = Object.keys(cat)

  assert.equal(ids[0], "claude-opus-5-5", "the newest flagship leads")
  assert.ok(ids.indexOf("claude-opus-5-5") < 24, "and is inside the 24 magpie exposes")
  assert.ok(ids.indexOf("claude-sonnet-5-5") < 24)
  assert.ok(ids.indexOf("gpt-6.1-sol") < 24)

  // families stay together: no claude model comes after a gpt one
  const firstGPT = ids.indexOf("gpt-6.1-sol")
  assert.ok(ids.slice(0, firstGPT).every((id) => id.startsWith("claude")))
  // the rest of the families come after the big two
  for (const id of ["grok-4.6", "deepseek-v4-pro", "kimi-k3", "qwen3.7-max", "glm-5.3"]) {
    assert.ok(ids.indexOf(id) > firstGPT, `${id} is after the Claude and GPT groups`)
  }
})

test("an image model stays out however the list is ordered", () => {
  const pricing = parsePricing({
    ...PRICING,
    data: [
      { model_name: "claude-opus-5-5", quota_type: 0, model_ratio: 2, completion_ratio: 4, enable_groups: ["cheap"], supported_endpoint_types: ["anthropic"] },
      { model_name: "img-x", quota_type: 1, model_price: 0.04, enable_groups: ["image"], supported_endpoint_types: ["image-generation"] },
    ],
  })
  const ids = Object.keys(buildCatalog({ pricing, keys: [], opts: {} }))
  assert.deepEqual(ids, ["claude-opus-5-5"])
})
