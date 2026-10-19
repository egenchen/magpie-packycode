# 设计说明：把 PackyAPI 接进 magpie

这份文档记录调研结论和取舍，方便以后改插件时不用重新摸一遍。

## 1. PackyAPI 是什么

`packyapi.com / packyapi.ai`（PackyCode）是 **New API v1.0.220 的深度定制分支**，
不是 one-api 原版。对插件有影响的定制点：

| 定制 | 说明 |
| --- | --- |
| 令牌多分组 | 令牌有 `group_mode: single/multi`，`groups` 是 JSON 数组串；多分组时站方在组间自选渠道 |
| 分组倍率 | `/api/pricing` 的 `group_ratio`；模型级覆盖在 `model_group_ratio` |
| 高峰计价 | `peak_active`（当前生效倍数）+ `peak_pricing`（规则，仅供展示） |
| 实时性能 | `/api/perf-metrics` 公开给出每个模型每个分组的 24h 成功率/TTFT/TPS |
| 请求日志 | `/api/log/self` 每条记录带 `group`、`channel`、`quota`，`other` 里是本次使用的 `group_ratio`/`model_ratio`/`completion_ratio` |
| 登录 | 邮箱密码登录带腾讯滑块验证码，脚本过不了；第三方集成用「系统访问令牌 + 用户 ID」 |

### 关键接口（都已实测）

```
POST /api/user/login                      需要滑块，插件不用
GET  /api/user/self                       Authorization: Bearer <系统令牌> + New-Api-User: <数字 ID>
GET  /api/token/search?p=0&size=100       返回完整 key、group、group_mode、groups
POST /api/token/                          {name, group, unlimited_quota, expired_time:-1, ...}
                                          groups 若传必须是 JSON *字符串*；多分组模式要求 ≥2 组
DELETE /api/token/{id}
GET  /api/token/usage_detail?p=1&page_size=100&start_timestamp&end_timestamp   每个令牌的 cost（quota）
GET  /api/log/self?p=0&page_size=200&type=2&start_timestamp&end_timestamp     每次请求的 group/ratio
GET  /api/pricing                         公开；价目表、倍率、enable_groups、端点类型、高峰
GET  /api/perf-metrics?model=X&hours=24   公开；分组健康度
GET  /v1/models                           需要 API key；返回该令牌分组当前「有渠道」的模型
GET  /v1/dashboard/billing/usage          需要 API key；账号级花费（美分）
```

### 端点选择（很容易踩坑）

| 主机 | `/v1` 推理 | `/api` 控制台 | 备注 |
| --- | --- | --- | --- |
| `cf.api.fan` | ✅ | ❌ 404 | 全球推理 |
| `slb-v1.api.fan` | ✅ | ✅ | 优化线路，插件默认 |
| `www.packyapi.com` | ✅ | ✅ | 主站，可用 |
| `www.packyapi.ai` | ✅ | ❌ Cloudflare 403 | 主站的 `/api/user/*` 会被 WAF 挡 |

插件默认 `slb-v1.api.fan`，可在登录时切换。

### 计费公式（与站方前端逐字一致）

```
input  $/1M = model_ratio × 2 × 分组倍率 × 高峰系数
output $/1M = input × completion_ratio
cache read  = input × cache_ratio
quota 单位 = 500000 / 美元
```

实测核对：`claude-sonnet-5-5` 66 输入 + 15 输出，`cc-sale` 0.8 倍：
`66×1.6/1e6 + 15×8/1e6 = $0.0002256 → 112.8 quota`，站方日志记 `quota=112`。

### 价格不可控的根源

同一模型在多个分组时，**令牌本身决定不了用哪个分组**，站方按渠道优先级/权重挑。
所以「价格最优」必须 **一个分组一个令牌**；多分组令牌只能当可用性兜底，且价格按最贵分组估算。

### 分组的地雷

- `cc`、`codex`、`codex-sale`：站方文档明确「只允许官方客户端，第三方接入会封号」。
  插件默认排除；`include_restricted` 才启用。
- 分组会随时上下架：`cc-sale`（0.8）在 2026-10 中旬从价目表消失，但令牌仍可用、仍按 0.8 计费。
  → 插件从 `/api/log/self` 的 `other.group_ratio` **学习**这类已下架分组的倍率并持久化，
  否则会退回 3.5 倍的 `cc-expensive`。

## 2. magpie 的插件契约（读源码 + 实机验证）

| 事实 | 影响 |
| --- | --- |
| 插件是 OpenCode 形状：`async (input) => {config, provider:{id,models}, auth:{methods,loader,usage,options}}` | 一个 provider id、多账号 |
| **magpie 会把模块里每一个导出函数当插件工厂调用** | 除 `PackycodeAuthPlugin` 外不能导出函数（本项目踩过：`startOfDay` 被当工厂调用导致加载失败） |
| `provider.models(provider, {auth})` 每个账号调用一次，结果缓存 1 小时；失败保留旧表 | 模型/价格刷新频率 = 1h，够用 |
| `loader(getAuth)` 返回 `baseURL/apiKey/headers/fetch`，`fetch(url, init)` 可任意改写 URL 与头 | 这是「按请求选分组」的关键：可以替换 `Authorization` |
| `init.headers` 已含账号 key（`x-api-key` 或 `Bearer`），请求体是字符串 | 必须删掉 `x-api-key` 再写自己的 Bearer |
| `auth.methods[].type = "api"` 时，key 输入框的标题取 **label**；`prompts` 在 key 之前问 | 系统访问令牌就放在 key 框里，用户 ID/线路用 prompts |
| `authorize(inputs)` **拿不到 key**（key 在之后的 save 里合并） | 登录时无法校验令牌，只能等第一次 `provider.models` 校验并 `signIn:"expired"` 标记 |
| `auth.options` 是开关（boolean），`input.magpie.options(id)` 实时读 | 四个开关：自动建 key / 受限分组 / 速度优先 / 健康检查 |
| 插件 provider 的模型超过 24 个时，只默认暴露前 24 个给 agent | 插件按「家族 + 同族新模型在前」排序，让主力模型默认在这 24 个里；其余文档提示用户去 Providers 勾选 |
| 模型 `limit` 留 0 时，magpie 会用自己 catalog 里的窗口补齐 | 实测 Claude/GPT/Qwen 窗口都对 |
| 插件 id 与用户已有自定义 provider 重名时，插件变成 `<id>-plugin` | 删掉同名的自定义 provider 后，模型 id 就是 `packycode/...` |
| 插件跑在 Bun 里，`process.cwd()` 是 magpie 配置目录；`input.directory` 也是它 | 学习结果写 `~/.config/magpie/packycode-groups.json` |
| 网关会把 Anthropic/Chat/Responses 互相翻译后交给插件 `fetch` | 上游协议按模型端点类型选 npm：Claude→anthropic，GPT→responses，其余→chat |

## 3. 备选方案与取舍

| 方案 | 为什么没选 |
| --- | --- |
| 每个分组一个 magpie provider（`packycode-cc-sale`…） | 23 个分组 = 23 个 provider 卡、23 次登录；跨 provider 的「按价格排序」还要自写 magpie 路由组，且网关进程里的 `strategies` 拿不到价格数据 |
| 一个多分组令牌，靠站方自动挑渠道 | 可用性最好但价格不可控（可能按 7 倍计费），与第二目标冲突 |
| 中间件插件（`onRequest`/`onProvider`）+ 自定义 `strategies` | 只能改请求体、不能换凭据；`strategies` 在 moejs 里没有网络/文件，拿不到实时价格与健康度 |
| 浏览器自动化登录 + 建 key | 腾讯滑块 + Cloudflare，不稳定也不合规 |
| 邮箱密码存插件里 | 登录必过验证码，不可行；系统访问令牌是站方给第三方的正规路径 |

最终选的是 **一个 provider + 插件内部令牌池**：所有判断（价目表、分组健康、令牌可用性、冷却）
都在 `fetch` 里一次完成，magpie 只负责协议翻译、流式、用量记录和账号展示。

## 4. 数据流

```
magpie 启动 / 每小时
  └─ provider.models(auth)
       ├─ GET /api/pricing            价目表（10 分钟缓存）
       ├─ GET /api/status             quota_per_unit
       ├─ GET /api/token/search       令牌 → 分组
       ├─ （可选）POST /api/token/    补齐 magpie-<分组>
       ├─ GET /v1/models × 分组       当前可用模型（10 分钟缓存，4 并发）
       ├─ GET /api/log/self           学习已下架分组的倍率（30 分钟一次）
       └─ buildCatalog()              每个模型：最便宜可达分组的价格 → magpie 模型表

一次请求
  └─ fetch(url, init)
       ├─ 取 model
       ├─ 候选 = 令牌 ∩ 分组 ∩ /v1/models ∩ 非受限
       ├─ GET /api/perf-metrics?model=X   分组健康（10 分钟缓存）
       ├─ 排序：健康过滤 → 价格 → 单分组优先 → 成功率
       ├─ 依次尝试（≤4）：替换 Authorization，失败按原因冷却后换下一个
       └─ 返回第一个 2xx（流式原样）
```

## 5. 验证记录

- 真实账号（2026-10）：`claude-sonnet-5-5` 由 `cc-sale`(0.8) 服务，`qwen3.7-flash` 由 `bailian`(0.5)，
  `claude-haiku-5-5` 因只在 `cc`(受限)/`claude-officially` 而走后者——与路由预期一致。
- 站方日志 `other.group_ratio` 与插件选择的分组逐条吻合。
- 流式、Anthropic→Chat 翻译、Responses 路径均跑通。
- 单元/端到端测试 28 个：价格公式、路由排序、受限分组、多分组令牌、故障切换、自动建 key、
  usage 卡片、错误分类、跨时区日界、下架分组学习。

## 6. 发布与命名（magpie 插件生态的约定）

调研自 magpie 文档的 “Publishing and listing”、`magpie-community/plugins` 仓库和 registry.json：

| 位置 | 约定 | 本仓库 |
| --- | --- | --- |
| 仓库名 | 第三方插件惯用 `magpie-<vendor>`（如 `DylanLIiii/magpie-zenmux`） | `magpie-packycode` |
| 包名 | 独立插件可自由命名；社区库用 `@magpie-community/opencode-<name>-auth` | `magpie-packycode` |
| 位置 | `package.json` 在仓库根目录（Discover 直接按仓库现状安装） | 根目录 |
| keywords | 需含 `opencode` 与 `opencode-plugin`，最好带 `magpie`/`magpie-plugin`（npm 搜索 `<query> opencode`） | 见 package.json |
| GitHub topic | `magpie-plugin` → Plugins → Discover → Unofficial | 发布后在仓库设置里加 |
| 卡片图标 | `package.json` 的 `magpie.icon`（data URI 或 https 图片） | `magpie.icon` + 根目录 `icon.svg` |
| 官方列表 | 给 magpie-community/plugins 的 `registry.json` 提 PR（bilingual summary） | README 里有模板 |
| 导出 | 插件的**每个导出函数都会被当工厂调用**，所以只导出插件工厂 | `test/package.test.mjs` 守住这条 |

`test/package.test.mjs` 把这些形状写成了测试，发版前能挡住“改了包名/关键词/导出”这类回归。

## 7. 可以继续做的

1. **校准探针**：给从未用过的已下架分组发一个已知长度的最小请求，从 `quota` 反推倍率（目前只能从历史日志学）。
2. **按会话亲和**：同一对话尽量留在同一分组，吃缓存（Claude 的 prompt cache 在切换分组后会失效）。
3. **发布到 npm / magpie-community**，让 `magpie plugin add magpie-packycode` 一步安装。
4. **mid-stream 错误重试**：目前只在响应头之前换分组（流已开始就不能换，这是 magpie 的约束）。
5. **把分组健康显示在 Usage 卡片**（需要 magpie 支持自定义字段；现在只放了花费）。
