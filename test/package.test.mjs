// The package's shape is part of how magpie finds it: the GitHub topic
// magpie-plugin, npm's opencode search, the icon on its card, and a plugin
// module that exports one function. These are the checks that keep those
// true — and the ones that keep a sign-in's credential where it belongs.

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readText } from "../src/http.mjs"
import { inferBase, consoleBase } from "../src/packyapi.mjs"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))

test("the package is shaped for magpie's plugin listing", () => {
  assert.equal(pkg.name, "magpie-packycode")
  assert.equal(pkg.type, "module")
  assert.equal(pkg.main, "./index.mjs")
  assert.equal(pkg.exports, "./index.mjs")
  assert.equal(pkg.license, "MIT")
  // the card's picture: a data URI or an https URL
  assert.match(pkg.magpie?.icon ?? "", /^(data:image\/|https:\/\/)/)
  // npm search asks for "<query> opencode" and wants opencode plus a keyword
  for (const k of ["opencode", "opencode-plugin", "magpie", "magpie-plugin"]) {
    assert.ok(pkg.keywords.includes(k), `keywords must hold ${k}`)
  }
  // what npm's tarball carries, and what the docs expect at the repo root
  for (const f of ["index.mjs", "src", "README.md"]) assert.ok(pkg.files.includes(f), `files must hold ${f}`)
  assert.ok(fs.existsSync(path.join(root, "index.mjs")))
  assert.ok(fs.existsSync(path.join(root, "README.md")))
  assert.ok(fs.existsSync(path.join(root, "LICENSE")))
  assert.ok(fs.existsSync(path.join(root, "icon.svg")), "the mark the registry entry points at")
})

test("the provider card's icon is the package's", async () => {
  const { PackycodeAuthPlugin } = await import("../index.mjs")
  const hooks = await PackycodeAuthPlugin({ magpie: { options: () => ({}) } })
  assert.equal(hooks.auth.icon, pkg.magpie.icon)
  assert.match(hooks.auth.icon, /^data:image\/svg\+xml;base64,/)
})

test("the loader hands out no credential", async () => {
  // magpie shows loader options to every plugin's chat.headers hook, and
  // fills apiKey from the stored sign-in when the loader leaves it empty
  const { PackycodeAuthPlugin } = await import("../index.mjs")
  const hooks = await PackycodeAuthPlugin({ magpie: { options: () => ({}) } })
  const auth = { type: "api", key: "sk-the-sign-in-key-0123456789abcdef", metadata: { mode: "keys", endpoint: "slb" } }
  const loader = await hooks.auth.loader(async () => auth)
  assert.equal(typeof loader.apiKey, "string")
  assert.ok(loader.apiKey.length > 0, "an empty one is filled with the stored key by magpie")
  assert.ok(!loader.apiKey.includes("the-sign-in-key"), "the sign-in's key stays out of the loader")
  assert.ok(!JSON.stringify(loader.headers ?? {}).includes("the-sign-in-key"))
})

test("only PackyAPI's hosts are ever contacted", () => {
  const allowed = new Set(["slb-v1.api.fan", "cf.api.fan", "www.packyapi.com"])
  const files = ["index.mjs", ...fs.readdirSync(path.join(root, "src")).filter((f) => f.endsWith(".mjs")).map((f) => path.join("src", f))]
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), "utf8")
    for (const url of text.match(/https?:\/\/[^\s"'`)]+/g) ?? []) {
      const host = new URL(url).host
      assert.ok(allowed.has(host), `${f} talks to ${host}`)
    }
  }
  // anything else falls back to the default host rather than being fetched
  assert.equal(inferBase("elsewhere.example"), "https://slb-v1.api.fan")
  assert.equal(consoleBase("cf"), "https://slb-v1.api.fan")
  assert.equal(consoleBase("nonsense"), "https://slb-v1.api.fan")
})

test("nothing in the package looks like a real credential or a personal path", () => {
  const files = [
    "index.mjs",
    "package.json",
    "README.md",
    "SECURITY.md",
    "icon.svg",
    ...fs.readdirSync(path.join(root, "src")).filter((f) => f.endsWith(".mjs")).map((f) => path.join("src", f)),
  ]
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), "utf8")
    assert.ok(!/\/Users\/[A-Za-z0-9._-]+/.test(text), `${f} names a home folder`)
    for (const m of text.match(/sk-[A-Za-z0-9]{40,}/g) ?? []) assert.fail(`${f} holds what looks like a key: ${m.slice(0, 6)}…`)
  }
})

test("an answer is read up to a limit, not however much it is", async () => {
  assert.equal(await readText(new Response("hello"), 1024), "hello")
  const big = new Response("x".repeat(500), { headers: { "content-length": "500" } })
  await assert.rejects(() => readText(big, 100), /past the 100/)
  const streamed = new Response("y".repeat(500))
  await assert.rejects(() => readText(streamed, 100), /past the 100/)
})

test("index.mjs exports one function, the plugin factory", async () => {
  // magpie runs every exported function as a plugin factory, so a helper
  // exported here would be called with the host's input and fail the load
  const mod = await import("../index.mjs")
  const fns = Object.entries(mod)
    .filter(([, v]) => typeof v === "function")
    .map(([k]) => k)
  assert.deepEqual(fns, ["PackycodeAuthPlugin"])
})

test("the option keys are the ones magpie keeps", async () => {
  // auth.options drops a key outside [a-z0-9_-] silently, and then the
  // provider's editor shows nothing at all
  const { PackycodeAuthPlugin } = await import("../index.mjs")
  const hooks = await PackycodeAuthPlugin({ magpie: { options: () => ({}) } })
  const keys = hooks.auth.options.map((o) => o.key)
  assert.ok(keys.length > 0)
  assert.ok(keys.length <= 16)
  for (const k of keys) assert.match(k, /^[a-z0-9_-]{1,40}$/, k)
  assert.equal(new Set(keys).size, keys.length)
  for (const o of hooks.auth.options) {
    assert.ok(o.label && o.label.length <= 60, o.key)
    assert.ok(!o.description || o.description.length <= 300, o.key)
    assert.ok(!o.confirm || o.confirm.length <= 300, o.key)
  }
})

test("the plugin returns the hooks magpie calls", async () => {
  const { PackycodeAuthPlugin } = await import("../index.mjs")
  const hooks = await PackycodeAuthPlugin({ magpie: { options: () => ({}) } })
  assert.equal(typeof hooks.config, "function")
  assert.equal(hooks.provider.id, "packycode")
  assert.equal(typeof hooks.provider.models, "function")
  assert.equal(hooks.auth.provider, "packycode")
  assert.equal(typeof hooks.auth.loader, "function")
  assert.equal(typeof hooks.auth.usage, "function")
  assert.ok(hooks.auth.methods.length >= 1)
  // a key field titled by the method's label, questions before it
  for (const m of hooks.auth.methods) {
    assert.equal(m.type, "api")
    assert.ok(m.label)
    assert.ok(Array.isArray(m.prompts))
    assert.equal(typeof m.authorize, "function")
  }
})
