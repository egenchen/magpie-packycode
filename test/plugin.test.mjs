import { test, afterEach } from "node:test"
import assert from "node:assert/strict"

import { PackycodeAuthPlugin, _internal } from "../index.mjs"
import { classify, modelOf } from "../src/request.mjs"
import { startOfDay } from "../src/usage.mjs"
import { secs } from "../src/packyapi.mjs"
import { fakePackyAPI, routeFetchTo } from "./fake.mjs"

const realFetch = globalThis.fetch
const fakes = []

afterEach(async () => {
  globalThis.fetch = realFetch
  for (const f of fakes.splice(0)) await f.close().catch(() => {})
  _internal.reset() // group rests outlive a test's account otherwise
})

async function setup(opts = {}) {
  const fake = fakePackyAPI(opts)
  fakes.push(fake)
  const { port } = await fake.listen()
  const logs = []
  globalThis.fetch = routeFetchTo(port, realFetch)
  const plugin = await PackycodeAuthPlugin({
    magpie: { options: () => opts.options ?? {} },
    client: { app: { log: (m) => logs.push(m) } },
  })
  return { plugin, fake, logs }
}

const logText = (logs) => logs.map((m) => m?.body?.message ?? "").join("\n")

const call = async (hooks, auth, model) => {
  const loader = await hooks.auth.loader(async () => auth)
  const res = await loader.fetch(loader.baseURL + "/messages", {
    method: "POST",
    headers: new Headers({ "x-api-key": "magpie", "content-type": "application/json" }),
    body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
  })
  return res
}

test("keys sign-in learns each key's groups, and the cheapest one serves", async () => {
  const { plugin, fake } = await setup({
    tokens: [
      { key: "sk-cheap-aaaaaaaaaaaaaaaaa", name: "c", group: "cheap" },
      { key: "sk-mid-bbbbbbbbbbbbbbbbbbb", name: "m", group: "mid" },
      { key: "sk-pricey-cccccccccccccccc", name: "p", group: "pricey" },
    ],
  })
  // an "api" method's key field carries the keys; the plugin reads their
  // groups from the relay
  const auth = { type: "api", key: "sk-cheap-aaaaaaaaaaaaaaaaa sk-mid-bbbbbbbbbbbbbbbbbbb sk-pricey-cccccccccccccccc", metadata: { mode: "keys", endpoint: "slb" } }
  const models = await plugin.provider.models({ models: {} }, { auth })
  assert.ok(models["claude-x"])
  assert.equal(models["claude-x"].cost.input, 3)

  const res = await call(plugin, auth, "claude-x")
  assert.equal(res.status, 200)
  assert.equal(fake.state.requests.at(-1).key, "sk-cheap-aaaaaaaaaaaaaaaaa")
})

test("a group with no channel hands the request to the next one, and rests", async () => {
  const { plugin, fake, logs } = await setup({
    tokens: [
      { key: "sk-cheap-aaaaaaaaaaaaaaaaa", name: "c", group: "cheap" },
      { key: "sk-mid-bbbbbbbbbbbbbbbbbbb", name: "m", group: "mid" },
    ],
  })
  const auth = {
    type: "api",
    key: "sk-cheap-aaaaaaaaaaaaaaaaa sk-mid-bbbbbbbbbbbbbbbbbbb",
    metadata: { mode: "keys", endpoint: "slb" },
  }
  fake.fail("sk-cheap-aaaaaaaaaaaaaaaaa", { status: 503 })

  const res = await call(plugin, auth, "claude-x")
  assert.equal(res.status, 200)
  const used = fake.state.requests.map((r) => r.key)
  // the cheapest group gets one more try before a dearer group is asked
  assert.deepEqual(used, ["sk-cheap-aaaaaaaaaaaaaaaaa", "sk-cheap-aaaaaaaaaaaaaaaaa", "sk-mid-bbbbbbbbbbbbbbbbbbb"])

  // the failed group is resting: the next request starts on mid
  await call(plugin, auth, "claude-x")
  assert.equal(fake.state.requests.at(-1).key, "sk-mid-bbbbbbbbbbbbbbbbbbb")
  // and the fallback says so in magpie's log, with how long the rest is
  const said = logs.map((m) => m?.body?.message ?? "").join("\n")
  assert.match(said, /resting it 60s and asking the next group/)
})

test("a cheap group that fails once is asked again before the dear one", async () => {
  const { plugin, fake, logs } = await setup({
    tokens: [
      { key: "sk-cheap-aaaaaaaaaaaaaaaaa", name: "c", group: "cheap" },
      { key: "sk-mid-bbbbbbbbbbbbbbbbbbb", name: "m", group: "mid" },
    ],
  })
  const auth = { type: "api", key: "sk-cheap-aaaaaaaaaaaaaaaaa sk-mid-bbbbbbbbbbbbbbbbbbb", metadata: { mode: "keys", endpoint: "slb" } }
  fake.fail("sk-cheap-aaaaaaaaaaaaaaaaa", { status: 429, times: 1 })

  const res = await call(plugin, auth, "claude-x")
  assert.equal(res.status, 200)
  assert.deepEqual(
    fake.state.requests.map((r) => r.key),
    ["sk-cheap-aaaaaaaaaaaaaaaaa", "sk-cheap-aaaaaaaaaaaaaaaaa"],
    "no request went to the dearer group",
  )
  assert.ok(!logText(logs).includes("asking the next group"))
})

test("a token spanning two groups is not preferred over a pinned one", async () => {
  const { plugin, fake } = await setup({
    tokens: [
      { key: "sk-multi-aaaaaaaaaaaaaaaa", name: "m", group: "", group_mode: "multi", groups: '["mid","pricey"]' },
      { key: "sk-mid-bbbbbbbbbbbbbbbbbbbb", name: "p", group: "mid" },
    ],
  })
  const auth = {
    type: "api",
    key: "sk-multi-aaaaaaaaaaaaaaaa sk-mid-bbbbbbbbbbbbbbbbbbbb",
    metadata: { mode: "keys", endpoint: "slb" },
  }
  await call(plugin, auth, "claude-x")
  assert.equal(fake.state.requests.at(-1).key, "sk-mid-bbbbbbbbbbbbbbbbbbbb")
})

test("with an access token, a token per needed group is made and used", async () => {
  const { plugin, fake } = await setup({
    tokens: [{ key: "sk-pricey-cccccccccccccccc", name: "old", group: "pricey" }],
    usage: [],
    options: { manage_keys: true },
  })
  const auth = { type: "api", key: "tok-0123456789abcdef", metadata: { mode: "token", userID: "12345", endpoint: "slb" } }

  const models = await plugin.provider.models({ models: {} }, { auth })
  assert.deepEqual(Object.keys(models).sort(), ["claude-x", "gpt-x"])
  // the two cheapest pools claude-x is sold in, so a pool in maintenance
  // still leaves the next cheapest
  assert.deepEqual(
    fake.state.created.map((t) => t.name).sort(),
    ["magpie-cheap", "magpie-mid"],
  )

  const res = await call(plugin, auth, "claude-x")
  assert.equal(res.status, 200)
  const made = fake.state.created.find((t) => t.group === "cheap")
  assert.equal(fake.state.requests.at(-1).key, made.key)
})

test("a managed key is not made again on the next listing", async () => {
  const { plugin, fake } = await setup({
    tokens: [{ key: "sk-pricey-cccccccccccccccc", name: "old", group: "pricey" }],
    options: { manage_keys: true },
  })
  const auth = { type: "api", key: "tok-0123456789abcdef", metadata: { mode: "token", userID: "12345", endpoint: "slb" } }
  await plugin.provider.models({ models: {} }, { auth })
  const made = fake.state.created.length
  await plugin.provider.models({ models: {} }, { auth })
  assert.equal(fake.state.created.length, made)
  assert.equal(made, 2)
})

test("the restricted pools are off by default, and on with the switch", async () => {
  // the switches arrive as input.magpie.options(id), keyed by what auth.options declared
  const off = await setup({})
  const offModels = await off.plugin.provider.models({ models: {} }, {})
  assert.ok(!offModels["claude-only-cc"], "cc is not used unless asked")

  const on = await setup({ options: { include_restricted: true } })
  const onModels = await on.plugin.provider.models({ models: {} }, {})
  assert.ok(onModels["claude-only-cc"])
})

test("no token is made unless the user turns that on", async () => {
  // creating credentials in someone's account is theirs to ask for: the
  // switch is off by default and the editor asks before turning it on
  const { plugin, fake } = await setup({ tokens: [{ key: "sk-pricey-cccccccccccccccc", name: "old", group: "pricey" }] })
  const auth = { type: "api", key: "tok-0123456789abcdef", metadata: { mode: "token", userID: "12345", endpoint: "slb" } }
  await plugin.provider.models({ models: {} }, { auth })
  assert.equal(fake.state.created.length, 0)
})

test("the sign-in's key never reaches the model", async () => {
  const { plugin, fake } = await setup({
    tokens: [{ key: "sk-pricey-cccccccccccccccc", name: "old", group: "pricey" }],
    options: { manage_keys: true },
  })
  const auth = { type: "api", key: "tok-0123456789abcdef", metadata: { mode: "token", userID: "12345", endpoint: "slb" } }
  await call(plugin, auth, "claude-x")
  const sent = fake.state.requests.at(-1)
  // the request goes out with the chosen group's token, and nothing else
  assert.match(sent.headers.authorization, /^Bearer sk-/)
  assert.equal(sent.headers["x-api-key"], undefined)
  assert.ok(!JSON.stringify(sent.headers).includes("tok-0123456789abcdef"), "the access token is not forwarded")
})

test("the fetch sends a key only to the relay's own host", async () => {
  // magpie hands this fetch to other plugins as provider.options.fetch
  const { plugin, fake } = await setup({ tokens: [{ key: "sk-cheap-aaaaaaaaaaaaaaaaa", name: "c", group: "cheap" }] })
  const auth = { type: "api", key: "sk-cheap-aaaaaaaaaaaaaaaaa", metadata: { mode: "keys", endpoint: "slb" } }
  const loader = await plugin.auth.loader(async () => auth)
  const before = fake.state.requests.length
  await assert.rejects(
    () => loader.fetch("https://evil.example/v1/messages", { method: "POST", headers: new Headers(), body: JSON.stringify({ model: "claude-x" }) }),
    /refusing to send a key/,
  )
  assert.equal(fake.state.requests.length, before, "nothing went out")

  const ok = await loader.fetch(loader.baseURL + "/messages", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ model: "claude-x", max_tokens: 4, messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(ok.status, 200)
})

test("the usage card shows the balance, today and each group's share", async () => {
  const now = Date.now()
  const { plugin } = await setup({
    tokens: [
      { key: "sk-cheap-aaaaaaaaaaaaaaaaa", name: "magpie-cheap", group: "cheap" },
      { key: "sk-pricey-cccccccccccccccc", name: "old", group: "pricey" },
    ],
    usage: [
      { name: "magpie-cheap", key: "sk-cheap-aaaaaaaaaaaaaaaaa", cost: 1_000_000, at: now - 60_000 },
      { name: "old", key: "sk-pricey-cccccccccccccccc", cost: 500_000, at: now - 120_000 },
    ],
  })
  const auth = { type: "api", key: "tok-0123456789abcdef", metadata: { mode: "token", userID: "12345", endpoint: "slb" } }
  const usage = await plugin.auth.usage(async () => auth)
  assert.equal(usage.balance, "$100.00")
  assert.match(usage.plan, /today/)
  assert.equal(usage.windows.length, 2)
  assert.equal(usage.windows[0].name, "cheap")
  assert.ok(usage.windows[0].used > 60 && usage.windows[0].used < 70)
  assert.equal(usage.windows[0].limit, 3)
})

test("the failures that move on, and the ones that do not", () => {
  const noCh = classify(503, JSON.stringify({ error: { message: "分组 default 下模型 gpt-x 无可用渠道" } }))
  assert.equal(noCh.retry, true)
  assert.match(noCh.why, /无可用渠道/)
  assert.equal(noCh.cool, 60_000, "a blip rests a group a minute, not five")

  const rate = classify(429, "{}", new Headers({ "retry-after": "7" }))
  assert.equal(rate.retry, true)
  assert.equal(rate.cool, 7000)

  const longWait = classify(429, "{}", new Headers({ "retry-after": "3600" }))
  assert.equal(longWait.cool, 60_000, "a long Retry-After is capped at a minute")

  const shape = classify(400, JSON.stringify({ error: { message: "invalid params: max_tokens" } }))
  assert.equal(shape.retry, false)

  const auth = classify(401, "{}")
  assert.equal(auth.whole, true)

  const html = classify(403, "<html>Attention Required! | Cloudflare</html>")
  assert.equal(html.retry, true)
})

test("times reach the relay in seconds, however they were given", () => {
  assert.equal(secs(Date.parse("2026-10-19T05:00:00Z")), 1792386000)
  assert.equal(secs(1792386000000), 1792386000) // milliseconds
  assert.equal(secs(1792386000), 1792386000) // already seconds
})

test("the model is read from the body, and a day starts at Beijing midnight", () => {
  assert.equal(modelOf("http://x/v1/messages", JSON.stringify({ model: "claude-x" })), "claude-x")
  assert.equal(modelOf("http://x/v1beta/models/gemini-3:generateContent", ""), "gemini-3")
  const start = startOfDay(Date.parse("2026-10-19T04:30:00Z"), "Asia/Shanghai")
  assert.equal(new Date(start).toISOString(), "2026-10-18T16:00:00.000Z")
})
