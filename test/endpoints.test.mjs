import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PackyAPI, inferBase, consoleBase } from "../src/packyapi.mjs"
import { World } from "../src/world.mjs"
import { PackycodeAuthPlugin } from "../index.mjs"
import { saveMade } from "../src/keys.mjs"

test("both sign-in methods keep two independent endpoint choices", async () => {
  const plugin = await PackycodeAuthPlugin({})
  for (const method of plugin.auth.methods) {
    for (const key of ["endpoint", "consoleEndpoint"]) {
      const prompt = method.prompts.find((p) => p.key === key)
      assert.equal(prompt.type, "select")
      assert.deepEqual(prompt.options.map((o) => o.value).sort(), ["ai", "cf", "slb"])
      if (key === "consoleEndpoint") assert.match(prompt.options.find((o) => o.value === "cf").label, /不建议选择/)
    }
    const signed = await method.authorize({ userID: "12345", endpoint: "cf", consoleEndpoint: "ai" })
    assert.equal(signed.metadata.endpoint, "cf")
    assert.equal(signed.metadata.consoleEndpoint, "ai")
    const defaults = await method.authorize({ userID: "12345" })
    assert.equal(defaults.metadata.consoleEndpoint, "ai")
  }
})

test("the provider config and loader agree with the selected model endpoint", async () => {
  const plugin = await PackycodeAuthPlugin({}, { model_endpoint: "https://cf.api.fan", config_endpoint: "https://www.packyapi.ai" })
  const config = { provider: { packycode: { api: "https://slb-v1.api.fan/v1" } } }
  await plugin.config(config)
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "test-key", metadata: { endpoint: "slb" } }))
  assert.equal(config.provider.packycode.api, "https://cf.api.fan/v1")
  assert.equal(loader.baseURL, config.provider.packycode.api)
})

for (const endpoint of ["ai", "cf", "slb"]) {
  for (const consoleEndpoint of ["ai", "cf", "slb"]) {
    test(`relay ${endpoint} and console ${consoleEndpoint} route their own API calls`, async () => {
      const seen = []
      const api = new PackyAPI({
        endpoint, consoleEndpoint, accessToken: "test-system-token", userID: "12345",
        fetchImpl: async (url, init) => {
          const u = new URL(url)
          seen.push({ url: u, headers: new Headers(init.headers), method: init.method })
          let data = { success: true, data: { id: 1, key: "test-created-token-key", items: [], total: 0 } }
          if (u.pathname === "/v1/models") data = { data: [{ id: "claude-x", supported_endpoint_types: ["anthropic"] }] }
          if (u.pathname === "/v1/messages") data = { error: { message: "已选分组=[cheap]" } }
          return new Response(JSON.stringify(data), { status: 200 })
        },
      })
      await api.status()
      await api.pricing()
      await api.perf("claude-x")
      await api.self()
      await api.tokens()
      await api.createToken({ name: "test", group: "cheap" })
      await api.deleteToken(1)
      await api.logs(1, 2)
      await api.usageByToken(1, 2)
      assert.deepEqual(await api.keyModels("test-relay-key"), [{ id: "claude-x", endpoints: ["anthropic"] }])
      await api.keyUsage("test-relay-key", new Date(0), new Date())
      assert.deepEqual(await api.probeGroups("test-relay-key"), ["cheap"])

      const consoleCalls = seen.filter((r) => r.url.pathname.startsWith("/api/"))
      const relayCalls = seen.filter((r) => r.url.pathname.startsWith("/v1/"))
      assert.equal(consoleCalls.length, 9)
      assert.equal(relayCalls.length, 3)
      assert.ok(consoleCalls.every((r) => r.url.origin === inferBase(consoleEndpoint)))
      assert.ok(relayCalls.every((r) => r.url.origin === inferBase(endpoint)))
      assert.ok(relayCalls.every((r) => r.headers.get("authorization") === "Bearer test-relay-key"))
      for (const r of consoleCalls.filter((r) => r.headers.has("authorization"))) {
        assert.equal(r.headers.get("authorization"), "Bearer test-system-token")
        assert.equal(r.headers.get("new-api-user"), "12345")
      }
    })
  }
}

test("older sign-ins retain their routing until the user chooses endpoints", () => {
  for (const [endpoint, host] of [["slb", "slb-v1.api.fan"], ["cf", "slb-v1.api.fan"], ["www", "www.packyapi.com"]]) {
    const api = new PackyAPI({ endpoint })
    assert.equal(api.console, `https://${host}`)
    assert.equal(api.infer, inferBase(endpoint) + "/v1")
  }
  for (const value of ["https://elsewhere.example", "__proto__", "constructor"]) {
    assert.equal(inferBase(value), "https://slb-v1.api.fan")
    assert.equal(consoleBase(value), "https://slb-v1.api.fan")
  }
})

test("the Options editor accepts only known full origins or short ids", () => {
  for (const [id, origin] of [["ai", "https://www.packyapi.ai"], ["cf", "https://cf.api.fan"], ["slb", "https://slb-v1.api.fan"]]) {
    assert.equal(inferBase(id), origin)
    assert.equal(inferBase(origin), origin)
    assert.equal(inferBase(origin + "/"), origin)
    assert.equal(consoleBase(origin), origin)
  }
  for (const endpoint of ["https://cf.api.fan.evil.example", "https://www.packyapi.ai@evil.example", "http://cf.api.fan", "https://cf.api.fan/v1", "https://cf.api.fan?host=elsewhere"]) {
    assert.equal(inferBase(endpoint), "https://slb-v1.api.fan")
    assert.equal(consoleBase(endpoint), "https://slb-v1.api.fan")
  }
  assert.equal(consoleBase(undefined, "https://cf.api.fan"), "https://slb-v1.api.fan")
})

test("an unavailable console reports the selected host, path and setting to change", async () => {
  for (const [body, status, why] of [["", 200, /200 with an empty body/], ["not found", 404, /404/]]) {
    const api = new PackyAPI({ endpoint: "cf", consoleEndpoint: "slb", fetchImpl: async () => new Response(body, { status }) })
    await assert.rejects(() => api.pricing(), (e) => {
      assert.match(e.message, /slb-v1\.api\.fan/)
      assert.match(e.message, why)
      assert.match(e.message, /\/api\/pricing/)
      assert.match(e.message, /配置调用接口/)
      return true
    })
  }
})

test("a failed token-list read preserves the saved keys", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "packycode-endpoints-"))
  try {
    const made = { cheap: { id: 1, key: "test-saved-relay-key", name: "magpie-cheap" } }
    saveMade(dir, made)
    const before = fs.readFileSync(path.join(dir, "packycode-keys.json"), "utf8")
    const urls = []
    const world = new World({ type: "api", key: "test-system-token", metadata: { mode: "token", userID: "12345", endpoint: "cf", consoleEndpoint: "ai" } }, { manage_keys: false }, async (url) => {
      urls.push(url)
      return new Response("", { status: 200 })
    }, dir)
    await assert.rejects(() => world.keys(), /200 with an empty body/)
    assert.deepEqual(world.made, made)
    assert.equal(fs.readFileSync(path.join(dir, "packycode-keys.json"), "utf8"), before)
    assert.equal(urls.length, 1)
    assert.match(urls[0], /^https:\/\/www\.packyapi\.ai\/api\/token\/search/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
