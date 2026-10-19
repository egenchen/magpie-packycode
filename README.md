# magpie-packycode

[![license](https://img.shields.io/badge/license-MIT-111111)](LICENSE)
[![magpie plugin](https://img.shields.io/badge/magpie-plugin-5865F2)](https://github.com/yetone/magpie)

PackyAPI / PackyCode for [magpie](https://github.com/yetone/magpie): one model, several token
groups with different price multipliers — this plugin puts every request on the **cheapest group
that is working**, fails over when one is down, and shows balance, today's spend and each group's
share on the Usage card.

把 [PackyAPI / packycode](https://www.packyapi.com) 接进 [magpie](https://github.com/yetone/magpie)：
**同一个模型按“当前可用且最便宜的分组”发请求，某个分组挂了自动换下一个，并在 Usage 卡片里显示余额、今日花费和各分组占比。**

---

## English TL;DR

PackyAPI is a New API relay where a model is sold through several *token groups*, each with its
own multiplier on the model's rate (e.g. `claude-sonnet-5-5`: 0.8× in `cc-sale`, 3.5× in
`cc-expensive`, 7× in `claude-officially`). A token may span several groups, but then **the relay
picks the channel**, so you cannot control the price.

This plugin signs in to the account once with a **system access token + numeric user id** (the
credentials PackyAPI documents for third-party tools; its password login has a slider CAPTCHA),
keeps **one token per group** (created automatically as `magpie-<group>`), and on every request:

1. keeps only keys whose group serves the model **right now** (`GET /v1/models`, plus per-group
   24-hour success rates from `/api/perf-metrics`),
2. skips the groups PackyAPI forbids third-party clients in (`cc`, `codex`, `codex-sale`) unless
   you opt in,
3. orders the rest by price (model ratio × group multiplier) and tries up to four,
4. returns the first 2xx; a dead group is rested and the next request goes to the next cheapest.

It also remembers multipliers of groups PackyAPI dropped from the price list but still charges
(learned from your own `/api/log/self`), and reads balance, today's spend and per-group spend from
the console.

```sh
# GitHub (tag the repo with the topic "magpie-plugin" to be listed under Plugins → Discover)
magpie plugin add github:egenchen/magpie-packycode

# or a local checkout
magpie plugin add ~/code/magpie-packycode

# then sign in: the provider is "PackyAPI", its id is packycode
magpie plugin login packycode
```

Tested on magpie 0.1.1246. Not affiliated with PackyAPI or magpie.

---

## 它解决什么

PackyAPI 是 New API 系的中转站，一个模型会同时挂在多个 **令牌分组** 上，每个分组有自己的
**计费倍率**（比如 Claude Sonnet 5.5 在 `cc-sale` 是 0.8 倍，在 `claude-officially` 是 7 倍）。
一个令牌可以同时勾选多个分组——但**这时候用哪个分组是站方决定的，你控制不了价格**。

这个插件的做法：

1. 用你的**系统访问令牌**登录账号，读出所有令牌和价目表；
2. 打开「每个分组建一个令牌」后，**每个分组自动建一个独立令牌**（名字 `magpie-<分组>`），让每个分组的价格可以锁定（默认关，避免未经同意往账号里写东西）；
3. 每个请求按 **「可达 + 健康 + 最便宜」** 排序选令牌，失败自动换下一个；
   （分组临时下架时，插件会从你自己的请求日志里**学会**它原来的倍率并记住，
   比如 `cc-sale` 从价目表消失后仍按 0.8 计费——不学会就会退回 3.5 倍的 `cc-expensive`）
4. 用站方公开的 `/api/perf-metrics`（24 小时分组成功率/延迟）和插件自己看到的失败做健康检查；
5. Usage 卡片显示 **余额**、**今日花费**、**各分组近 7 天花费占比**。

### 实测效果（真实账号，2026-10）

| 模型 | 不选路（`claude-officially` 7×） | 插件选路（`cc-sale` 0.8×） |
| --- | --- | --- |
| `claude-sonnet-5-5` | 输入 $14.00 / 输出 $70.00 每 1M | 输入 **$1.60** / 输出 **$8.00** 每 1M |
| `claude-opus-5-5` | 输入 $28.00 / 输出 $140.00 每 1M | 输入 **$3.20** / 输出 **$16.00** 每 1M |

实测扣费与公式一致：一个 66 输入 / 15 输出的 `claude-sonnet-5-5` 请求，站方记 112 quota
（112 / 500000 = $0.000224），按 `cc-sale` 0.8 倍算应为 $0.0002256，吻合。

---

## 安装

插件就是一个 npm 包，仓库根目录即包根目录。

```sh
# 从 GitHub 装（把 <owner>/<repo> 换成你的仓库）
magpie plugin add github:<owner>/<repo>

# 或者本地开发/离线装
git clone https://github.com/<owner>/<repo>.git ~/code/magpie-packycode
magpie plugin add ~/code/magpie-packycode
```

装好后 Providers 里会出现 **PackyAPI**（provider id 是 `packycode`，模型名形如
`packycode/claude-sonnet-5-5`），或者用命令行登录：

```sh
magpie plugin login packycode
```

### 登录方式一（推荐）：系统访问令牌 + 用户 ID

- **系统访问令牌**：控制台 → 右上角头像 → **个人设置** → **安全设置** → **生成系统访问令牌**
  （这是 PackyAPI 官方给第三方工具用的凭据，CC Switch 的“用量查询”用的也是它）。
- **用户 ID**：个人设置页顶部的数字，例如 `1234`（既不是 `oidc_1234` 这种用户名，也不是页面上那串很长的 ID）。

> 为什么不用账号密码：PackyAPI 的密码登录有腾讯滑块验证码，脚本/插件无法通过；系统访问令牌就是为
> 这种场景准备的，而且可以随时在控制台撤销。

登录后插件会：

- 读价目表 `/api/pricing`（公开，不需要登录）；
- 读你的令牌列表 `/api/token/search`；
- 给「至少一个模型的最便宜/次便宜分组」补齐 `magpie-<分组>` 令牌（可在选项里一键关闭）；
- 用每个令牌的 `/v1/models` 确认该分组**当前**有哪些模型可用。

### 登录方式二：直接粘贴 API Key

不想给系统访问令牌时，可以只粘贴一个或多个 `sk-...`（空格/逗号分隔）。插件会用一个不存在的模型
去探测每个 key 绑定的分组（站方会回 `已选分组=[...]`，不花钱），然后照常选路。此模式**不能**自动建
令牌、也读不到余额，只能按 key 的额度跑。

---

## 选项

位置：**Providers → PackyAPI → 编辑（铅笔）→ 页面下方的 *Plugin options***。

> magpie 只保留 key 匹配 `[a-z0-9_-]` 的选项（camelCase 会被静默丢弃，界面上就一个都不显示）；
> 本插件用下划线 key，`test/package.test.mjs` 守着这条。

| 选项（key） | 默认 | 作用 |
| --- | --- | --- |
| **每个分组建一个令牌** (`manage_keys`) | 关 | 自动创建 `magpie-<分组>` 令牌，锁定每个分组的价格。默认关（建令牌属于账号写入），打开时 magpie 会先确认。 |
| **允许使用受限分组** (`include_restricted`) | 关 | `cc` / `codex` / `codex-sale` 只允许官方客户端，站方明确说第三方接入会封号。默认排除。 |
| **速度优先** (`prefer_speed`) | 关 | 关：最便宜优先；开：先看 24h 成功率和首字延迟，再看价格。 |
| **跳过故障分组** (`check_performance`) | 开 | 成功率低于 88% 的分组在有别的选择时先不用；插件自己遇到的 429/无渠道错误也会让该分组冷却。 |

选项值存在 magpie 的 `settings.json` 的 `pluginOptions.packycode` 下；改完不需要重启，插件每次用时现读。

---

## 它是怎么选路的

一次请求（用 `packycode/claude-sonnet-5-5` 举例）：

1. **候选**：所有「分组包含该模型」的令牌。
   - 分组里当前**没有可用模型**（`/v1/models` 为空，比如分组维护中）→ 跳过；
   - 令牌里只要含受限分组（`cc`/`codex`/`codex-sale`）→ 整个令牌跳过（站方可能在任意分组上路由）；
   - 多分组令牌：价格按**最贵的那个分组**算（因为站方可能挑贵的），并排在单分组令牌之后。
2. **健康**：`/api/perf-metrics?model=<模型>&hours=24` 给出每个分组 24h 成功率、TTFT、TPS；
   低于阈值的分组先不用，插件自己看到的失败按 `令牌|模型` 休息：无渠道/限流 **60 秒**
   （429 按 `Retry-After`，最多 60 秒）、5xx 30 秒、401/402 整个令牌冷却。
   休息时间刻意短：便宜分组一次抖动，不该让后面几分钟都落到贵几倍的分组上；
   而且**最便宜的分组失败会先原地重试一次**（等 500ms），一次瞬时失败不必马上切走。
   真的降级到更贵的分组时，magpie 日志里会有一条 `warn` 说明分组、状态码和休息时长。
3. **排序**：价格（= 模型倍率 × 分组倍率）升序，同价时单分组令牌优先、成功率高的优先。
4. **发送**：按顺序最多试 4 个令牌，只替换 `Authorization`，请求体原样（流式也原样）。
   - 无渠道 / 模型不存在 / 429 / 5xx / 401 → 换下一个；
   - 400/422 这类「请求本身有问题」→ 直接返回，不浪费别的分组。
5. 全部失败才把最后一个错误交给 agent，并让 magpie 标记该账号（该分组不会再被问）。

价格换算（与站方前端一致）：

```
输入 $/1M = model_ratio × 2 × 分组倍率 × 高峰系数
输出 $/1M = 输入 × completion_ratio
缓存读    = 输入 × cache_ratio
```

`高峰系数` 取 `/api/pricing` 的 `peak_active`（DeepSeek 工作日 09:00-12:00、14:00-18:00 为 2 倍）；
`peak_active` 缺失时退回 `peak_pricing` 规则自己算。

---

## 计费

- magpie 的 Usage 页按 **模型 token 数 × 当前选中分组的价格** 估算（价格每小时随模型列表刷新）；
- PackyAPI 账号卡片显示 **余额**、**今日花费**、**各分组近 7 天花费**（来自站方
  `/api/user/self` 与 `/api/token/usage_detail`，单位是 quota，500000 = $1）；
- **权威数字永远以 PackyAPI 控制台的用量明细为准**；插件的估算在“用最便宜分组”时通常吻合，
  但在故障切换用到了更贵分组的那几次会偏低。

---

## 注意与已知限制

1. **`cc` / `codex` / `codex-sale` 默认不用**。站方文档写明这三个分组只允许官方客户端，第三方接入
   会封号。要用请自己打开 `include_restricted`，风险自负。
2. **多分组令牌价格不可控**。要“锁价”必须一个分组一个令牌；插件自动建的就是这种。
3. **magpie 默认只向 agent 暴露前 24 个模型**（`manyModels`）。插件按
   **家族分组、家族内新模型在前**排（Claude → GPT → Gemini → Grok → DeepSeek → Kimi →
   Qwen → GLM → …），所以 Claude Opus 5.5、GPT-6.1-Sol 这类主力默认就在前 24 里；
   其余模型在 Providers → PackyAPI → 模型勾选里勾上即可（`magpie provider models packycode +<模型>`）。
4. **provider id 冲突**：如果本机已经有一个手写的 `packycode` 自定义 provider，插件会以
   `packycode-plugin` 出现（magpie 的规则：id 被占用的插件加 `-plugin` 后缀）。想让模型 id 统一成
   `packycode/...`，先在 Providers 里删掉旧的自定义 provider（`magpie provider rm packycode`），
   再把 agent 指到插件的模型上。
5. **自动建的令牌不会自动删除**。不想用了在控制台删 `magpie-*`，或先关掉 `manage_keys`（该开关默认就是关的）。
6. **未登录时**插件仍会列出价目表里的模型（方便看价格），但请求会报“没有 key”。
7. 系统访问令牌存在 magpie 的 `~/.config/magpie/plugin-auth.json` 里（和别的插件凭据一样）；
   控制台可以随时撤销它。

---

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 登录后显示 “PackyAPI refused the system access token” | 令牌或用户 ID 不对；用户 ID 是个人设置页顶部的数字（如 1234）。 |
| 模型列表比控制台少 | `magpie` 只暴露前 24 个（按家族排序的后半段）；或该模型所属分组当前无可用渠道（维护中）。 |
| 请求报 “only on cc, codex…” | 该模型只在受限分组里；确认风险后打开 `include_restricted`。 |
| 一直走贵的分组 | 便宜分组刚失败过、正在休息（60 秒内会自己回来，magpie 日志有 `warn` 记录原因）；或该分组的 key 还没建（看选项 `manage_keys`）；或分组从价目表下架且日志里还没出现过。 |
| 网关频繁 429 | 插件对 `/api/*` 有退避重试；仍频繁出现说明请求量超过了站方限制。 |

调试用的真实接口：

```sh
# 价目表（公开）
curl -s https://slb-v1.api.fan/api/pricing | jq '.group_ratio'
# 某模型各分组的 24h 健康度（公开）
curl -s 'https://slb-v1.api.fan/api/perf-metrics?model=claude-sonnet-5-5&hours=24' | jq '.data.groups'
# 你自己的请求日志：每条都带 group 和 group_ratio，可核对插件选的路由与价格（需要系统令牌）
curl -s "https://slb-v1.api.fan/api/log/self?p=0&page_size=10&type=2&start_timestamp=$(($(date +%s)-3600))&end_timestamp=$(date +%s)" \
  -H "authorization: Bearer <系统令牌>" -H "New-Api-User: <用户ID>" \
  | jq -r '.data.items[] | "\(.model_name) \(.group) x\(.other|fromjson|.group_ratio) quota=\(.quota)"'
# 每个模型现在最便宜的分组和价格（插件自带脚本）
npm run prices
# 某个 key 的分组（把 bogus 模型发过去，站方会把分组写在错误里，不花钱）
curl -s https://slb-v1.api.fan/v1/messages -H "authorization: Bearer sk-…" \
  -H 'content-type: application/json' -d '{"model":"zzz-bogus","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'
```

---

## 学习记录在哪

- `~/.config/magpie/packycode-groups.json`：见过的分组倍率（含已从价目表下架的分组），
  插件每次价格刷新时更新，重启不丢。
- 删掉它不会坏，只是已下架的分组要等下一次请求日志学习回来。

---

## 开发与测试

```sh
npm test                 # node --test，48 个用例，含一个假的 PackyAPI 服务器
npm run prices           # 打印每个模型当前最便宜的分组与价格（按 picker 顺序）
PACKY_TOKEN=… PACKY_USER=… npm run live          # 对真实 PackyAPI 的只读冒烟
PACKY_TOKEN=… PACKY_USER=… LIVE_CALL=qwen3.7-flash npm run live:plugin   # 走插件自己的 fetch
```

目录：

```
index.mjs            magpie 的钩子：config / provider.models / auth(loader, usage, options)
src/pricing.mjs      /api/pricing 解析与价格换算
src/packyapi.mjs     PackyAPI 客户端：控制台、令牌、/v1/models、/v1/messages
src/world.mjs        账号状态：价目表、令牌、分组健康、自动建 key
src/router.mjs       纯函数排序：可达 → 受限 → 健康 → 价格
src/catalog.mjs      给 magpie 的模型列表（含各模型当前价格、显示名与 picker 顺序）
src/request.mjs      从请求里取模型、判别错误是否值得换分组
src/usage.mjs        余额 / 今日花费 / 分组占比
src/known.mjs        记住/学习分组倍率（含已下架分组）
test/                node --test，含一个假的 PackyAPI 服务器
scripts/live*.mjs    对真实 PackyAPI 的只读/冒烟脚本
DESIGN.md            调研结论、magpie 插件契约、备选方案与取舍
```

---

### 维护者流程：让 magpie 只跑 GitHub 版

本地改完、`npm test` 通过后，先推 GitHub，再让 magpie 安装/更新 **GitHub 版**；不要保留本地路径安装，
否则两份插件会同时声明同一个 provider（magpie 只会让其中一份服务，行为难排查）：

```sh
npm test
git push origin main
magpie plugin rm /path/to/magpie-packycode 2>/dev/null   # 清掉本地路径安装（如果有）
magpie plugin update                                     # 拉 GitHub 上的最新提交
magpie plugin list                                       # 确认只剩 github:egenchen/magpie-packycode
```

## 让 magpie 发现它

三种入口，按投入从低到高：

1. **GitHub topic**（零成本）：给仓库打上 `magpie-plugin` topic，它就会出现在
   **Plugins → Discover → Unofficial, on GitHub**（按 star 排序，标注“未审核”）。要求
   `package.json` 在仓库根目录；发 npm 时 `repository` 指向该仓库，否则 magpie 直接按仓库现状安装
   （所以被加载的文件必须在仓库里，不能只在发布产物里）。
2. **npm 搜索**：keywords 里已有 `opencode`、`opencode-plugin`、`magpie`、`magpie-plugin`，
   发到 npm 后在 Plugins 的搜索框里搜 `packycode` 就能找到。
3. **官方社区列表**：给 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的
   `registry.json` 提 PR：

```json
{
  "package": "@magpie-community/opencode-packycode-auth",
  "name": "PackyAPI",
  "icon": "https://raw.githubusercontent.com/<owner>/<repo>/main/icon.svg",
  "providers": ["packycode"],
  "community": true,
  "summary": {
    "en": "PackyAPI / PackyCode: each request on the cheapest token group that is working.",
    "zh": "PackyAPI / PackyCode：每个请求走当前可用且最便宜的分组。"
  }
}
```

   （进社区库需要把包名改成 `@magpie-community/opencode-packycode-auth`、放到 `packages/<name>` 下，
   并接受仓库的审核与自动发布流程；本仓库保持独立也可以。）

## 发布

```sh
npm publish            # 包名 magpie-packycode；发版后 magpie plugin add magpie-packycode
```

npm 页面会显示本 README。

## 卸载

```sh
magpie plugin rm magpie-packycode      # 或安装时用的路径 / github: 名字
# 可选：删掉自动建的令牌（控制台里删 magpie-* ）
```

## 安全

凭据存放、出站域名白名单、为什么系统访问令牌不会出现在 loader/请求头里、以及撤销方式，见
[SECURITY.md](SECURITY.md)。插件没有遥测、没有运行时依赖、不会把密钥写进文件或日志。

## 图标与商标

插件图标用的是 PackyAPI 官网的 `/logo.svg`（官方标识），按官网主色 `#1677FF` 着色，
以便在浅色/深色主题里都看得清；仓库根目录的 `icon.svg` 是同一份文件，供注册表条目引用。
PackyAPI / PackyCode 的名称与标识归其所有者，这里仅用于标明所接入的服务。本项目与
PackyAPI、magpie 均无隶属关系。

## License

MIT，见 [LICENSE](LICENSE)。
