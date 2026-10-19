// The plugin itself against the real PackyAPI: the hooks magpie calls, in
// order, with a real sign-in. LIVE_CALL names the model to send one tiny
// request through the plugin's own fetch.
//
//   PACKY_TOKEN=… PACKY_USER=1234 LIVE_CALL=qwen3.7-flash node scripts/live-plugin.mjs

import { PackycodeAuthPlugin } from "../index.mjs"

const accessToken = process.env.PACKY_TOKEN
const userID = process.env.PACKY_USER
const endpoint = process.env.PACKY_ENDPOINT || "slb"
const model = process.env.LIVE_CALL || ""

if (!accessToken || !userID) {
  console.error("set PACKY_TOKEN and PACKY_USER")
  process.exit(1)
}

const used = []
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const auth = init?.headers?.get?.("authorization") ?? ""
  if (auth) used.push(auth.replace(/^Bearer\s+/, "").slice(0, 12))
  return realFetch(input, init)
}

const plugin = await PackycodeAuthPlugin({
  magpie: { options: () => ({ manage_keys: process.env.MANAGE === "1" }) },
  client: { app: { log: ({ body }) => console.log(`[plugin ${body.level}] ${body.message}`) } },
})

const auth = {
  type: "api",
  key: accessToken,
  metadata: {
    accessToken,
    userID,
    endpoint,
    accountId: `packyapi-${userID}`,
    email: `packyapi-${userID}`,
    uid: Number(userID),
  },
}

const started = Date.now()
const models = await plugin.provider.models({ models: {} }, { auth })
const ids = Object.keys(models).sort()
console.log(`models: ${ids.length} in ${Date.now() - started}ms`)
for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "qwen3.7-flash", "deepseek-v4-flash", "glm-5.3", "gemini-3-flash-preview", "grok-4.7", "gpt-5.6-sol"]) {
  const m = models[id]
  console.log(`  ${id.padEnd(24)} ${m ? `$${m.cost.input.toFixed(2)}/$${m.cost.output.toFixed(2)}  ${m.api.npm}` : "—"}`)
}

const usage = await plugin.auth.usage(async () => auth)
console.log("usage:", JSON.stringify(usage).slice(0, 400))

if (model) {
  const loader = await plugin.auth.loader(async () => auth)
  console.log(`fetch base ${loader.baseURL}`)
  used.length = 0
  const t = Date.now()
  const res = await loader.fetch(loader.baseURL + "/messages", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", "anthropic-version": "2023-06-01" }),
    body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "reply with one word" }] }),
  })
  const text = await res.text()
  console.log(`→ ${res.status} in ${Date.now() - t}ms, keys tried: ${used.join(" → ")}`)
  console.log("  " + text.slice(0, 400))
}

globalThis.fetch = realFetch
