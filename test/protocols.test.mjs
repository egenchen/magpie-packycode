import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { parsePricing, endpointsOf } from "../src/pricing.mjs"
import { buildCatalog } from "../src/catalog.mjs"
import { orderFor, explain } from "../src/router.mjs"
import { endpointOf } from "../src/request.mjs"
import { PackycodeAuthPlugin, _internal } from "../index.mjs"
import { fakePackyAPI, routeFetchTo } from "./fake.mjs"

const MODEL = "grok-4.7"
const SALE = "sk-test-grok-sale-key"
const OFFICIAL = "sk-test-grok-official-key"
const raw = {
  success: true,
  group_ratio: { "grok-sale": 0.3, "grok-officially": 1 },
  model_group_endpoints: { "grok-sale": { [MODEL]: ["openai-response"] } },
  data: [{ model_name: MODEL, model_ratio: 1, completion_ratio: 3, enable_groups: ["grok-sale", "grok-officially"], supported_endpoint_types: ["openai", "openai-response"] }],
}
const pricing = parsePricing(raw)
const keys = [
  { key: SALE, groups: ["grok-sale"], groupMode: "single" },
  { key: OFFICIAL, groups: ["grok-officially"], groupMode: "single" },
]
const candidates = (extra = {}) => orderFor({ model: MODEL, keys, pricing, perf: null, ...extra })

test("group protocol overrides narrow the global model protocols", () => {
  const model = pricing.models.get(MODEL)
  assert.deepEqual(endpointsOf(pricing, model, "grok-sale"), ["openai-response"])
  assert.deepEqual(endpointsOf(pricing, model, "grok-officially"), ["openai", "openai-response"])
})

test("the cheapest Responses-only group makes the catalog advertise Responses", () => {
  for (const accountKeys of [[], keys]) {
    const catalog = buildCatalog({ pricing, keys: accountKeys })
    assert.equal(catalog[MODEL].api.npm, "@ai-sdk/openai")
    assert.equal(catalog[MODEL].cost.input, 0.6)
  }
})

test("an account with only the official key retains Chat Completions", () => {
  const catalog = buildCatalog({ pricing, keys: [keys[1]] })
  assert.equal(catalog[MODEL].api.npm, "@ai-sdk/openai-compatible")
  assert.equal(catalog[MODEL].cost.input, 2)
})

test("an unpriced group retains its supported protocol in the catalog", () => {
  const p = parsePricing({ ...raw, group_ratio: {} })
  const catalog = buildCatalog({ pricing: p, keys: [keys[0]] })
  assert.equal(catalog[MODEL].api.npm, "@ai-sdk/openai")
  assert.equal(catalog[MODEL].cost.input, 0)
})

test("Chat Completions never chooses the Responses-only key", () => {
  assert.deepEqual(candidates({ endpoint: "openai" }).map((v) => v.group), ["grok-officially"])
  assert.deepEqual(candidates({ endpoint: "openai-response" }).map((v) => v.group), ["grok-sale", "grok-officially"])
})

test("live key protocols narrow the catalog and request routing", () => {
  const accountKeys = [{ ...keys[1], live: new Map([[MODEL, ["openai-response"]]]) }]
  assert.equal(buildCatalog({ pricing, keys: accountKeys })[MODEL].api.npm, "@ai-sdk/openai")
  assert.deepEqual(candidates({ keys: accountKeys, endpoint: "openai" }), [])
})

test("an omitted live protocol list preserves the group protocol information", () => {
  const accountKeys = [{ ...keys[0], live: new Map([[MODEL, []]]) }]
  assert.equal(buildCatalog({ pricing, keys: accountKeys })[MODEL].api.npm, "@ai-sdk/openai")
})

test("an explicit empty group override is not treated as the model default", () => {
  const p = parsePricing({ ...raw, model_group_endpoints: { "grok-sale": { [MODEL]: [] } } })
  const catalog = buildCatalog({ pricing: p, keys })
  assert.equal(catalog[MODEL].api.npm, "@ai-sdk/openai-compatible")
  assert.equal(catalog[MODEL].cost.input, 2)
})

test("a multi-group key considers only its groups accepting the request protocol", () => {
  const p = parsePricing({ ...raw, model_group_endpoints: { ...raw.model_group_endpoints, "grok-officially": { [MODEL]: ["openai"] } } })
  const mixed = [{ key: SALE, groups: ["grok-sale", "grok-officially"], groupMode: "multi" }]
  const response = candidates({ pricing: p, keys: mixed, endpoint: "openai-response" })
  const chat = candidates({ pricing: p, keys: mixed, endpoint: "openai" })
  assert.deepEqual(response[0].groups, ["grok-sale"])
  assert.equal(response[0].multiplier, 0.3)
  assert.deepEqual(chat[0].groups, ["grok-officially"])
  assert.equal(chat[0].multiplier, 1)
})

test("an incompatible request names the missing protocol", () => {
  const c = candidates({ keys: [keys[0]], endpoint: "openai" })
  assert.deepEqual(c, [])
  assert.match(explain(MODEL, c, pricing, [keys[0]], "openai"), /over openai/)
  assert.equal(endpointOf("/v1/responses"), "openai-response")
  assert.equal(endpointOf("/v1/chat/completions"), "openai")
  assert.equal(endpointOf("/v1/messages"), "anthropic")
  assert.equal(endpointOf("/v1/unknown"), undefined)
})

test("Muse without group overrides keeps its existing Chat Completions protocol", () => {
  const p = parsePricing({ ...raw, data: [{ ...raw.data[0], model_name: "muse-spark-1.3" }] })
  assert.equal(buildCatalog({ pricing: p, keys })["muse-spark-1.3"].api.npm, "@ai-sdk/openai-compatible")
})

const realFetch = globalThis.fetch
const fakes = []
afterEach(async () => {
  globalThis.fetch = realFetch
  for (const fake of fakes.splice(0)) await fake.close()
  _internal.reset()
})

async function setup(price = raw) {
  const fake = fakePackyAPI({
    pricing: price,
    tokens: [{ key: SALE, group: "grok-sale" }, { key: OFFICIAL, group: "grok-officially" }],
    live: { "grok-sale": [MODEL], "grok-officially": [MODEL] },
    protocols: { [SALE]: ["/v1/responses"], [OFFICIAL]: ["/v1/chat/completions", "/v1/responses"] },
  })
  fakes.push(fake)
  const { port } = await fake.listen()
  globalThis.fetch = routeFetchTo(port, realFetch)
  const plugin = await PackycodeAuthPlugin({}, { config_endpoint: "ai", model_endpoint: "ai" })
  const auth = { type: "api", key: `${SALE} ${OFFICIAL}`, metadata: { mode: "keys", groups: { [SALE]: ["grok-sale"], [OFFICIAL]: ["grok-officially"] } } }
  return { fake, plugin, auth }
}

async function send(plugin, auth, endpoint) {
  const loader = await plugin.auth.loader(async () => auth)
  return loader.fetch(loader.baseURL + endpoint, { method: "POST", body: JSON.stringify({ model: MODEL }) })
}

test("the plugin catalog and fetch agree on the cheapest group's protocol", async () => {
  const { fake, plugin, auth } = await setup()
  const models = await plugin.provider.models({ models: {} }, { auth })
  assert.equal(models[MODEL].api.npm, "@ai-sdk/openai")
  assert.equal((await send(plugin, auth, "/responses")).status, 200)
  assert.equal(fake.state.requests.at(-1).key, SALE)
  assert.equal((await send(plugin, auth, "/chat/completions")).status, 200)
  assert.equal(fake.state.requests.at(-1).key, OFFICIAL)
  assert.equal(fake.state.requests.length, 2, "the incompatible sale group was never tried on chat")
})

test("a failing Responses group falls back to another Responses-compatible group", async () => {
  const { fake, plugin, auth } = await setup()
  fake.fail(SALE, { status: 503 })
  assert.equal((await send(plugin, auth, "/responses")).status, 200)
  assert.deepEqual(fake.state.requests.map((v) => v.key), [SALE, SALE, OFFICIAL])
})

test("a failing Responses group does not fall back to a Chat-only group", async () => {
  const p = { ...raw, model_group_endpoints: { ...raw.model_group_endpoints, "grok-officially": { [MODEL]: ["openai"] } } }
  const { fake, plugin, auth } = await setup(p)
  fake.fail(SALE, { status: 503 })
  assert.equal((await send(plugin, auth, "/responses")).status, 503)
  assert.deepEqual(fake.state.requests.map((v) => v.key), [SALE, SALE])
})
