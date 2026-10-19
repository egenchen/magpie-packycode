// PackyAPI (packyapi.com / packycode) as a magpie provider.
//
// PackyAPI sells one model through several token groups, each with its own
// multiplier on the model's rate, and a token may span several groups. A
// token that spans groups cannot pin a price: the relay picks the channel
// among them. So this plugin signs in to the account once, keeps (or makes)
// one token per group, and sends each request on the cheapest group that is
// working, falling back to the next when a group is down.
//
//   provider id   packycode
//   requests      /v1/messages, /v1/responses, /v1/chat/completions
//   sign-in       a system access token + numeric user id (full control),
//                 or one or more API keys (no console access)
//   usage         balance, today's spend, each group's share of the week
//
// Only PackycodeAuthPlugin is exported: magpie runs every exported function
// as a plugin factory, so a helper exported here would be called with the
// host's input and fail the load.

import { pooled, readText } from "./src/http.mjs"
import { ENDPOINTS, inferBase } from "./src/packyapi.mjs"
import { buildCatalog } from "./src/catalog.mjs"
import { orderFor, explain } from "./src/router.mjs"
import { World } from "./src/world.mjs"
import { classify, modelOf, signInError } from "./src/request.mjs"
import { usageOf } from "./src/usage.mjs"
import { log, optionsOf } from "./src/options.mjs"
import { noteFailure } from "./src/diag.mjs"

const ID = "packycode"
const CHAT = "@ai-sdk/openai-compatible"

// how many keys one request may try before the agent hears about it
const MAX_TRIES = 4

// what the loader's apiKey says: a placeholder, never the sign-in's key (see
// the loader below — magpie shows loader options to other plugins)
const PLACEHOLDER = "magpie-packycode"

const ICON =
  "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyBpZD0iX+WbvuWxgl8yIiBkYXRhLW5hbWU9IuWbvuWxgiAyIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNDUuNTUgMTEzLjI5Ij4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLmNscy0xIHsKICAgICAgICBmaWxsOiAjMTY3N0ZGOwogICAgICAgIHN0cm9rZTogIzE2NzdGRjsKICAgICAgICBzdHJva2UtbWl0ZXJsaW1pdDogMTA7CiAgICAgIH0KICAgIDwvc3R5bGU+CiAgPC9kZWZzPgogIDxnIGlkPSJf5Zu+5bGCXzEtMiIgZGF0YS1uYW1lPSLlm77lsYIgMSI+CiAgICA8Zz4KICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTQ0LjY4LDM4LjQ5bC0uMDYtLjIzYy0uODgtMy4yOC0yLjUtNS45NC00LjU4LTguMDYuMTQsNS42NS0yLjk2LDExLjAyLTYuMjIsMTYuNjZsLS4zOS42OGMtMi4yNiwzLjkxLTQuNjYsNy45NC02LjU3LDExLjFsLS44NiwxLjM4Yy0zLjM2LDUuNDQtNi4yNywxMC4xNC0xMi4xOCwxNC4xOC04LjM0LDUuODctMTguMiw1LjgxLTI2LjkyLDUuNzYtMi44MS0uMDItNS40OC0uMDMtNy45NS4xNGwtLjM1LjAyYy0zLjIyLjA2LTUuOTYsMS41Ny04LjE3LDQuNDlsLS4xNC4xOGMtLjg2LDEuMDYtMS43LDIuMjYtMi41OCwzLjU0LTMuNDMsNC45Mi03LjY5LDExLjA0LTE2LjE3LDEyLjQyLTQuMzcuODYtOS45OC44NC0xNC45NC44M2gtMS45NWMtLjUyLDAtMS4wNiwwLTEuNjEsMC02Ljk1LDAtMTYuMDgtLjg5LTIxLjk0LTYuNTUtLjE1LS4xNS0uMy0uMy0uNDQtLjQ1LjUsNC43MywyLjMzLDguNjQsNS40NCwxMS42NSw1Ljg2LDUuNjYsMTQuOTgsNi41NSwyMS45NCw2LjU1LjU1LDAsMS4wOSwwLDEuNjEtLjAxaDEuOTNjNC45Ni4wMiwxMC41OC4wNCwxNC45Ni0uODMsOC40OC0xLjM3LDEyLjc0LTcuNSwxNi4xNy0xMi40Mi44OC0xLjI3LDEuNzItMi40OCwyLjU4LTMuNTRsLjE0LS4xOGMyLjIxLTIuOTIsNC45NS00LjQzLDguMTctNC40OWwuMzUtLjAyYzIuNDctLjE3LDUuMTMtLjE2LDcuOTUtLjE0LDguNzIuMDUsMTguNTguMTEsMjYuOTEtNS43Niw1LjkyLTQuMDMsOC44Mi04LjczLDEyLjE5LTE0LjE3bC44Ni0xLjM5YzEuOTEtMy4xNSw0LjMtNy4xOCw2LjU3LTExLjA5bC4zOS0uNjljMy44MS02LjYsNy40MS0xMi44NCw1Ljg2LTE5LjU3Wk0xMjAuOSwyMy4wMmMtLjI4LDAtLjU2LDAtLjgzLDAtOS42OC0uMTktMjQuMDMtLjA5LTM1LjU3LS4wMWwtMi4wNC4wMmMtLjkzLjAxLTEuODIuMDItMi42Ny4wMy04LjM2LjA4LTE0LjQuMTMtMjMuMzMsMy44MmwtLjI3LjEyYy0xMC43Niw0LjY4LTE2LjkxLDEyLjE2LTIyLjgzLDIxLjk1LTUuNTMsOC43Ni0xMi42MiwyMC41Ny0xNi4zMiwyNi43OS0uNDEuNjktLjc3LDEuMy0xLjA5LDEuODRsLS40OS44NGMtMS40OSwyLjUzLTMuMjMsNS40OS00LjIxLDguOTUsMy45OCwxLjksOC41MiwyLjY1LDEyLjcxLDIuOTEuMjctLjc3LjY0LTEuNTYsMS4wNy0yLjM4LjQ4LS45NCwxLjA1LTEuOSwxLjYzLTIuODlsLjQ5LS44NGMuOTYtMS42MiwyLjM4LTMuOTksNC4wNS02Ljc4LDMuODItNi4zNiw4Ljk4LTE0Ljg4LDEzLjE5LTIxLjU1bC4wNy0uMTFjNS4wMi04LjMxLDkuMi0xMy40NSwxNi45MS0xNi44MWwuMTEtLjA1YzYuNTctMi43LDEwLjU0LTIuNzQsMTguNDMtMi44MS44Ny0uMDEsMS43OC0uMDIsMi42OS0uMDNsMS45OS0uMDJjOS4xNy0uMDYsMjAuMTMtLjE0LDI5LjAxLS4wNywyLjI2LjAxLDQuMzkuMDQsNi4zMi4wOGguMTJzLjExLDAsLjExLDBjMS4yNS0uMDEsMi45MS4xMSw0LjYxLjQ2LDEuMDMuMjIsMi4wOC41MiwzLjA1LjkzLjIxLS4zNS40MS0uNzEuNjItMS4wNmwuMzktLjY4YzEuOTItMy4zMywzLjc5LTYuNTcsNC45Ny05LjgyLTQuMDgtMS45Mi04LjctMi43Ni0xMi44OS0yLjgyWiIvPgogICAgICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xMTUuMDcsMTEuODFjLTkuNy0uMTktMjQuMDctLjA5LTM1LjYyLS4wMWgtMS45OWMtLjkzLjAzLTEuODIuMDQtMi42Ny4wNC04LjM2LjA4LTE0LjQuMTQtMjMuMzMsMy44M2wtLjI3LjEyYy0xMC43Niw0LjY3LTE2LjkxLDEyLjE2LTIyLjgzLDIxLjk1LTYuMTMsOS43MS0xNC4xOSwyMy4yMS0xNy40MSwyOC42M2wtLjUuODRjLTIuMDgsMy41NS00LjY4LDcuOTctNC45NCwxMy4zOXYuMnMwLC4yMSwwLC4yMWMuMDEuODEuMDYsMS42MS4xNSwyLjM4LjE0LjE1LjI5LjMuNDQuNDUsMS41MywxLjQ3LDMuMjgsMi42Myw1LjE1LDMuNTIsMy45OCwxLjksOC41MiwyLjY1LDEyLjcxLDIuOTEsMS40MS4wOSwyLjc4LjEyLDQuMDguMTIuNTUsMCwxLjA5LS4wMSwxLjYxLS4wMWgxLjk1YzQuOTUuMDEsMTAuNTcuMDMsMTQuOTQtLjgzLDguNDgtMS4zOCwxMi43NC03LjUsMTYuMTctMTIuNDIuODgtMS4yOCwxLjcyLTIuNDgsMi41OC0zLjU0bC4xNC0uMThjMi4yMS0yLjkyLDQuOTUtNC40NCw4LjE3LTQuNDlsLjM1LS4wMmMyLjQ3LS4xNyw1LjE0LS4xNiw3Ljk1LS4xNCw4LjcxLjA1LDE4LjU4LjEsMjYuOTItNS43Niw1LjkxLTQuMDQsOC44Mi04Ljc0LDEyLjE4LTE0LjE4bC44Ni0xLjM5YzEuNzQtMi44NiwzLjg3LTYuNDUsNS45NS0xMC4wMy4yMS0uMzUuNDEtLjcxLjYyLTEuMDZsLjM5LS42OGMxLjkyLTMuMzMsMy43OS02LjU3LDQuOTctOS44Mi44Mi0yLjI2LDEuMzEtNC41MywxLjI1LTYuODQtNS4xOC01LjI5LTEzLjIyLTcuMjUtMTkuOTctNy4xOVpNMTIyLjU2LDQwLjM3bC0uMzkuNjdjLTIuMjEsMy44MS00LjU1LDcuNzctNi4zOSwxMC43OWwtLjg0LDEuMzZjLTMuMDEsNC44Ny00LjgzLDcuODEtOC40OCwxMC4yOWwtLjEuMDdjLTQuOTQsMy40OS0xMS45NSwzLjQ1LTE5LjM4LDMuNDEtMi44OC0uMDItNS44Ny0uMDQtOC43OS4xNi03LjEuMTktMTMuNTEsMy41OC0xOC4wNyw5LjU3LTEuMTMsMS40LTIuMTIsMi44My0zLjA4LDQuMjEtMi45Miw0LjE4LTQuNzEsNi41Ny03LjY0LDcuMDJsLS4zMS4wNmMtMy4wOS42My04LjI4LjYxLTEyLjQ1LjZoLTIuMTZjLTMuODUuMDctNy4wMS0uMTYtOS40NS0uNjktMi4yNC0uNDgtMy44Ny0xLjIyLTQuODktMi4yLS42Ni0uNjQtMS41NC0xLjgxLTEuNjMtNC42NS4xMS0xLjM1LjcxLTIuODIsMS41Mi00LjM1LjQ4LS45NCwxLjA1LTEuOSwxLjYzLTIuODlsLjQ5LS44NGMzLjE3LTUuMzMsMTEuMTktMTguNzUsMTcuMjQtMjguMzNsLjA3LS4xMWM1LjAyLTguMzIsOS4yLTEzLjQ1LDE2LjkyLTE2LjgxbC4xLS4wNWM2LjU3LTIuNywxMC41NC0yLjc0LDE4LjQzLTIuODIuODcsMCwxLjc4LDAsMi42OS0uMDNoMS45NGMxMS41Mi0uMDksMjUuODYtLjE5LDM1LjM4LDBoLjIzYzEuMjUtLjAxLDIuOTIuMTEsNC42MS40NiwzLjE1LjY2LDYuNCwyLjEyLDcuMjcsNS4wMi4yLDEuMi0uODksMy42Mi0yLjI3LDYuMTgtLjcsMS4zMS0xLjQ4LDIuNjUtMi4yLDMuOVpNMTIwLjA3LDIzLjAxYy05LjY4LS4xOS0yNC4wMy0uMDktMzUuNTctLjAxbC0yLjA0LjAyYy0uOTMuMDEtMS44Mi4wMi0yLjY3LjAzLTguMzYuMDgtMTQuNC4xMy0yMy4zMywzLjgybC0uMjcuMTJjLTEwLjc2LDQuNjgtMTYuOTEsMTIuMTYtMjIuODMsMjEuOTUtNS41Myw4Ljc2LTEyLjYyLDIwLjU3LTE2LjMyLDI2Ljc5LS43OC0uMzUtMS40MS0uNzctMS45LTEuMjQtLjY2LS42NC0xLjU0LTEuODEtMS42My00LjY1LjE4LTIuMTgsMS42Mi00LjY0LDMuMTUtNy4yNWwuNDktLjgzYzMuMTctNS4zMiwxMS4xOC0xOC43MywxNy4yNC0yOC4zM2wuMDctLjEyYzUuMDItOC4zMSw5LjItMTMuNDUsMTYuOTItMTYuODFsLjEtLjA0YzYuNTctMi43LDEwLjU0LTIuNzQsMTguNDMtMi44Mi44Ny0uMDEsMS43OC0uMDEsMi42OS0uMDNoMS45OWMxMS41LS4wOSwyNS44Mi0uMTksMzUuMzMsMGguMjNjMy41Ny0uMDQsMTAuNTUsMS4wMiwxMS44OCw1LjQ4LjE0Ljg0LS4zNSwyLjI3LTEuMTMsMy45My0uMjgsMC0uNTYsMC0uODMsMFoiLz4KICAgICAgPHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTM0LjY4LDE2LjA5bC0uMDYtLjIzYy0zLjA3LTExLjQ1LTE1LjA4LTE1LjMzLTI0LjU1LTE1LjI1LTkuNjgtLjE5LTI0LjAzLS4wOS0zNS41Ny0uMDFoLTIuMDRjLS45My4wMy0xLjgyLjA0LTIuNjcuMDQtOC4zNi4wOC0xNC40LjE0LTIzLjMzLDMuODNsLS4yNy4xMmMtMTAuNzYsNC42Ny0xNi45MSwxMi4xNi0yMi44MywyMS45NS02LjE0LDkuNzMtMTQuMiwyMy4yMi0xNy40MSwyOC42MmwtLjQ5Ljg1Yy0yLjA5LDMuNTUtNC42OSw3Ljk2LTQuOTUsMTMuMzl2LjJzMCwuMjEsMCwuMjFjLjA5LDUuNTcsMS44MiwxMC4xMyw1LjE1LDEzLjU4LjE0LjE1LjI5LjMuNDQuNDUsMS41MywxLjQ3LDMuMjgsMi42Myw1LjE1LDMuNTIsMy45OCwxLjksOC41MiwyLjY1LDEyLjcxLDIuOTEsMS40MS4wOSwyLjc4LjEyLDQuMDguMTIuNTUsMCwxLjA5LS4wMSwxLjYxLS4wMWgxLjk1YzQuOTUuMDEsMTAuNTcuMDMsMTQuOTQtLjgzLDguNDgtMS4zOCwxMi43NC03LjUsMTYuMTctMTIuNDIuODgtMS4yOCwxLjcyLTIuNDgsMi41OC0zLjU0bC4xNC0uMThjMi4yMS0yLjkyLDQuOTUtNC40NCw4LjE3LTQuNDlsLjM1LS4wMmMyLjQ3LS4xNyw1LjE0LS4xNiw3Ljk1LS4xNCw4LjcxLjA1LDE4LjU4LjEsMjYuOTItNS43Niw1LjkxLTQuMDQsOC44Mi04Ljc0LDEyLjE4LTE0LjE4bC44Ni0xLjM5YzEuNzQtMi44NiwzLjg3LTYuNDUsNS45NS0xMC4wMy4yMS0uMzUuNDEtLjcxLjYyLTEuMDZsLjM5LS42OGMxLjkyLTMuMzMsMy43OS02LjU3LDQuOTctOS44Mi44Mi0yLjI2LDEuMzEtNC41MywxLjI1LTYuODQtLjAyLS45Ni0uMTQtMS45My0uMzYtMi45MVpNMTE5Ljc2LDI1LjI3Yy0uNywxLjMxLTEuNDgsMi42NS0yLjIsMy45bC0uMzkuNjdjLTEuMTksMi4wNC0yLjQxLDQuMTMtMy41Nyw2LjA5LTEuMDEsMS43LTEuOTcsMy4zMS0yLjgyLDQuN2wtLjg0LDEuMzZjLTMuMDEsNC44Ny00LjgzLDcuODEtOC40OCwxMC4yOWwtLjEuMDdjLTQuOTQsMy40OS0xMS45NiwzLjQ1LTE5LjM4LDMuNDEtMi44OS0uMDItNS44Ny0uMDQtOC43OS4xNi03LjEuMTgtMTMuNTEsMy41OC0xOC4wNyw5LjU3LTEuMTMsMS40LTIuMTIsMi44My0zLjA4LDQuMjEtMi45Miw0LjE4LTQuNzEsNi41Ny03LjY0LDcuMDJsLS4zMS4wNmMtMy4wOS42My04LjI3LjYxLTEyLjQ1LjZoLTIuMTZjLTMuODUuMDctNy4wMS0uMTYtOS40NS0uNjktMS4xNi0uMjUtMi4xNi0uNTctMi45OS0uOTYtLjc4LS4zNS0xLjQxLS43Ny0xLjktMS4yNC0uNjYtLjY0LTEuNTQtMS44MS0xLjYzLTQuNjUuMTgtMi4xOCwxLjYyLTQuNjQsMy4xNS03LjI1bC40OS0uODNjMy4xNy01LjMyLDExLjE4LTE4LjczLDE3LjI0LTI4LjMzbC4wNy0uMTJjNS4wMi04LjMxLDkuMi0xMy40NSwxNi45Mi0xNi44MWwuMS0uMDRjNi41Ny0yLjcsMTAuNTQtMi43NCwxOC40My0yLjgyLjg3LS4wMSwxLjc4LS4wMSwyLjY5LS4wM2gxLjk5YzExLjUtLjA5LDI1LjgyLS4xOSwzNS4zMywwaC4yM2MzLjU3LS4wNCwxMC41NSwxLjAyLDExLjg4LDUuNDguMTQuODQtLjM1LDIuMjctMS4xMywzLjkzLS4zNC43Mi0uNzMsMS40OC0xLjE0LDIuMjVaIi8+CiAgICA8L2c+CiAgPC9nPgo8L3N2Zz4="

/** the plugin, in OpenCode's shape: an async function of inputs, hooks back. */
export async function PackycodeAuthPlugin(input) {
  const worlds = new Map() // account → World

  const opts = () => optionsOf(input, ID)

  const worldOf = (auth) => {
    const md = auth?.metadata ?? {}
    const key = md.email || auth?.key || "anonymous"
    const sig = JSON.stringify([auth?.key ?? "", md.mode ?? "", md.userID ?? "", md.endpoint ?? "", md.keys ?? [], md.groups ?? {}])
    let w = worlds.get(key)
    if (!w || w.sig !== sig) {
      w = new World(auth, opts(), undefined, input?.directory || "")
      w.sig = sig
      worlds.set(key, w)
    } else {
      w.options = opts()
    }
    return w
  }

  return {
    // a provider card even before anyone signs in
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[ID] ?? {}
      cfg.provider[ID] = {
        name: "PackyAPI",
        npm: CHAT,
        api: inferBase(was.endpoint || "slb") + "/v1",
        ...was,
      }
    },

    provider: {
      id: ID,
      // per account: the models its keys can call now, priced at the
      // cheapest group a request would go to
      async models(provider, { auth } = {}) {
        const w = worldOf(auth)
        const pricing = await w.pricing()
        let keys = []
        try {
          keys = await w.keys()
        } catch (e) {
          // signed in with a system access token, a console that turns it
          // away is the sign-in's own failure: say so, and magpie marks the
          // account to sign in again
          if (w.signedIn) throw signInError(e)
          keys = await w.manualKeys()
          log(input, "warn", `keys: ${e?.message ?? e}`)
        }
        await attachLive(w, keys)
        const liveKnown = keys.some((k) => k.live)
        return buildCatalog({ pricing, keys, opts: opts(), liveKnown, base: base(w) })
      },
    },

    auth: {
      provider: ID,
      icon: ICON,

      // the switches the provider's editor shows (magpie's own field)
      options: [
        {
          key: "manage_keys",
          label: "每个分组建一个令牌",
          description: "给「最便宜/次便宜分组」自动建 magpie-<分组> 令牌，锁定每个分组的价格。关掉后只用你已有的令牌。",
          default: false,
          confirm: "会在你的 PackyAPI 账号里创建 magpie-<分组> 令牌（每个分组一个）。令牌免费创建，可随时在控制台删除。",
        },
        {
          key: "include_restricted",
          label: "允许使用受限分组",
          description: "cc / codex / codex-sale 只允许官方客户端，站方明确说第三方接入会封号。开启后更便宜，但风险自负。",
          default: false,
        },
        {
          key: "prefer_speed",
          label: "速度优先",
          description: "关：最便宜优先。开：先比 24 小时成功率和首字延迟，再看价格。",
          default: false,
        },
        {
          key: "check_performance",
          label: "跳过故障分组",
          description: "用站方 24 小时成功率，加上插件自己遇到的失败，在有别的分组可选时跳过正在故障的分组。",
          default: true,
        },
      ],

      methods: [
        {
          type: "api",
          // an "api" method's key field is titled by its label, so this is
          // where the system access token goes
          label: "PackyAPI 系统访问令牌（推荐）",
          placeholder: "个人设置 → 安全设置 → 生成系统访问令牌",
          prompts: [
            {
              type: "text",
              key: "userID",
              message: "PackyAPI 用户 ID（个人设置页顶部的数字，例如 1234）",
              placeholder: "1234",
              validate: (v) => (/^\d{2,20}$/.test(String(v ?? "").trim().replace(/^oidc_/, "")) ? undefined : "用户 ID 是数字"),
            },
            { type: "select", key: "endpoint", message: "接口线路", options: ENDPOINTS },
          ],
          // the token itself arrives as the key, after the questions, so it
          // is checked on the first listing rather than here
          async authorize(inputs) {
            const userID = String(inputs.userID ?? "").trim().replace(/^oidc_/, "")
            // the token itself is the sign-in's key (auth.key); metadata
            // keeps only what is not secret, so it is not stored twice
            return {
              type: "success",
              metadata: {
                mode: "token",
                userID,
                endpoint: inputs.endpoint || "slb",
                email: `packyapi-${userID}`,
              },
            }
          },
        },
        {
          type: "api",
          label: "PackyAPI API Key（一个或多个）",
          placeholder: "sk-… 多个用空格或逗号分隔",
          prompts: [{ type: "select", key: "endpoint", message: "接口线路", options: ENDPOINTS }],
          async authorize(inputs) {
            return { type: "success", metadata: { mode: "keys", endpoint: inputs.endpoint || "slb" } }
          },
        },
      ],

      // every request goes through here, so the key is chosen per request
      async loader(getAuth) {
        const auth = await getAuth()
        const md = auth?.metadata ?? {}
        // magpie hands a plugin's loader options to every plugin's
        // chat.headers hook, and fills apiKey from the stored sign-in when
        // it is empty — so the real key must never be here. fetchOn sets the
        // header per request from the account's tokens instead.
        return {
          baseURL: inferBase(md.endpoint || "slb") + "/v1",
          apiKey: PLACEHOLDER,
          headers: {},
          fetch: async (url, init) => fetchOn(input, worldOf(await getAuth()), url, init),
        }
      },

      // the Usage card: balance, today, each group's share of the week
      async usage(getAuth) {
        const w = worldOf(await getAuth())
        try {
          return await usageOf(w)
        } catch (e) {
          return { error: e?.message ?? String(e), signIn: "kept" }
        }
      },
    },
  }
}

// ── requests ──────────────────────────────────────────────────────────────

async function fetchOn(input, world, url, init) {
  // the host hands this same fetch to other plugins as
  // provider.options.fetch, so it must only ever send an account's key to
  // the relay it belongs to — never to whatever URL a caller names
  const base = new URL(inferBase(world.endpoint || "slb") + "/v1/")
  let target
  try {
    target = new URL(String(url))
  } catch {
    throw new Error("PackyAPI: refusing to send a request to a URL that is not one")
  }
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
    throw new Error(`PackyAPI: refusing to send a key to ${target.origin}${target.pathname}`)
  }

  const opts = optionsOf(input, ID)
  world.options = opts
  const body = init?.body
  const model = modelOf(url, body)

  let pricing
  let keys
  try {
    ;[pricing, keys] = await Promise.all([world.pricing(), world.keys()])
  } catch (e) {
    throw new Error(`PackyAPI: ${e?.message ?? e}`)
  }
  if (!keys.length) throw new Error("PackyAPI: no key is set — sign in to PackyAPI (or paste API keys) in Providers")
  // only the keys that could serve this model need their live list: the
  // price list already says which groups the model is sold in
  const fits = pricing?.models?.get(model)?.groups
  await attachLive(world, fits ? keys.filter((k) => k.groups.some((g) => fits.includes(g))) : keys)

  const perf = await world.perfOf(model)
  const state = stateOfAccount(world)
  const candidates = orderFor({ model, keys, pricing, perf, down: state.down, opts })
  const usable = candidates.filter((c) => !c.skip)
  if (!usable.length) throw new Error("PackyAPI: " + explain(model, candidates, pricing, keys))

  const tries = usable.slice(0, Math.max(1, opts.maxTries ?? MAX_TRIES))
  let last = null
  let sawAuth = false
  let lastWhy = ""

  const send = (cand) => {
    const headers = new Headers(init?.headers ?? {})
    // the account's own key sits in the header the host filled in; this
    // request's group is the one that goes out
    headers.delete("x-api-key")
    headers.delete("x-goog-api-key")
    headers.set("authorization", `Bearer ${cand.key.key}`)
    return fetch(url, { method: init?.method ?? "POST", headers, body, signal: init?.signal })
  }
  const label = (cand) => cand.group || cand.key.name || "a group"

  ask: for (let i = 0; i < tries.length; i++) {
    const cand = tries[i]
    // a blip on the cheapest group costs a moment's wait, not a request on a
    // group several times dearer: that one is asked once more before the
    // next group is
    const attempts = i === 0 ? 2 : 1
    for (let a = 0; a < attempts; a++) {
      if (init?.signal?.aborted) break ask
      if (a > 0) await new Promise((ok) => setTimeout(ok, 500))

      let res
      try {
        res = await send(cand)
      } catch (e) {
        if (init?.signal?.aborted) break ask
        lastWhy = e?.message ?? String(e)
        if (a < attempts - 1) continue
        note(state, cand, model, 20_000)
        noteFailure(world.dir, { model, group: label(cand), key: cand.key.name || "manual", error: lastWhy })
        log(input, "warn", `PackyAPI: ${label(cand)} could not be reached for ${model} (${lastWhy}); resting it 20s and asking the next group`)
        continue ask
      }

      if (res.ok) {
        clear(state, cand, model)
        return res
      }

      const text = await readText(res.clone(), 64 * 1024).catch(() => "")
      const verdict = classify(res.status, text, res.headers)
      lastWhy = verdict.why || `HTTP ${res.status}`
      note(state, cand, model, verdict.cool || 30_000, verdict.whole)
      if (res.status === 401) sawAuth = true
      if (!verdict.retry) return res
      last = res
      if (a < attempts - 1) continue
      // the fallback to a dearer group must be visible: a minute of it, not
      // five, and a line in magpie's log saying why
      const rest = Math.round((verdict.cool || 30_000) / 1000)
      noteFailure(world.dir, { model, group: label(cand), key: cand.key.name || "manual", status: res.status, why: lastWhy, rest })
      log(input, "warn", `PackyAPI: ${label(cand)} answered ${res.status} for ${model} (${lastWhy}); resting it ${rest}s and asking the next group`)
      continue ask
    }
  }

  if (last) return last
  const err = new Error(`PackyAPI: every key failed for ${model}${lastWhy ? " — " + lastWhy : ""}`)
  if (sawAuth) err.signIn = "expired"
  throw err
}

const accountStates = new Map()
function stateOfAccount(world) {
  const k = world.sig || world.auth?.key || "default"
  let s = accountStates.get(k)
  if (!s) {
    s = { down: { keyed: new Map(), whole: new Map() } }
    accountStates.set(k, s)
  }
  if (s.down.keyed.size > 800) {
    const now = Date.now()
    for (const [key, until] of s.down.keyed) if (until < now) s.down.keyed.delete(key)
  }
  return s
}

function note(state, cand, model, ms, whole = false) {
  const until = Date.now() + ms
  state.down.keyed.set(cand.key.key + "|" + model, until)
  if (whole) state.down.whole.set(cand.key.key, until)
}

function clear(state, cand, model) {
  state.down.keyed.delete(cand.key.key + "|" + model)
  state.down.whole.delete(cand.key.key)
}

/** the live model list of every key, a few at a time; a failure leaves it unknown. */
async function attachLive(world, keys) {
  await pooled(keys, 4, async (k) => {
    try {
      const live = await world.liveOf(k)
      if (live) k.live = live
    } catch {
      /* unknown: the price list decides */
    }
  })
}

function base(world) {
  return inferBase(world.endpoint || "slb") + "/v1"
}

// for tests: an object, not a function, so magpie never calls it as a plugin
export const _internal = { ID, reset: () => accountStates.clear() }
