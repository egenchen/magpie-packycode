# 安全说明

这个插件会用到你的 PackyAPI 凭据，所以把它的安全设计写在这里，方便安装前核对。

## 报告问题

发现安全问题请用 GitHub 的 **Security → Report a vulnerability**（Security Advisories），不要先开公开 issue。
请说明版本、复现步骤和影响；不涉及他人的账号数据。

## 凭据

| 凭据 | 存在哪 | 谁能读到 |
| --- | --- | --- |
| 系统访问令牌（推荐方式） | magpie 的 `~/.config/magpie/plugin-auth.json`，由 magpie 写入并掩码显示 | magpie 本身；插件通过 `getAuth()` 只在自身账号作用域内读取 |
| API Key（另一种登录方式） | 同上（作为 sign-in 的 key） | 同上 |

插件写入的磁盘文件只有三个，都在 magpie 配置目录，权限 `0600`，写入前都会检查不是符号链接：

| 文件 | 内容 |
| --- | --- |
| `packycode-groups.json` | 分组倍率（数字），无密钥 |
| `packycode-failures.jsonl` | 失败诊断（模型、分组、状态码、原因、令牌名），无密钥 |
| `packycode-keys.json` | **插件自己创建的令牌的 API key**（2026-10 起站方不再返回已有令牌的 key，只能在创建时拿到） |

`packycode-keys.json` 里的 key 与你在 magpie 里保存的 provider key 同级，只在本机可读；不要把它提交到
仓库或同步到公开位置。

## 网络

插件只访问下列 PackyAPI 域名，代码里没有其它出站地址，`test/package.test.mjs` 会扫描
运行时代码，出现别的 host 就测试失败：

- `https://slb-v1.api.fan`（默认：推理 + 控制台）
- `https://cf.api.fan`（推理，控制台接口不存在）
- `https://www.packyapi.ai`（可分别选择为推理或配置接口）
- `https://www.packyapi.com`（仅兼容已有登录的 `www` 配置）

“模型调用接口”和“配置调用接口”各有 `.ai` / CF / SLB 三个选项。插件 Options 也可独立设置
`model_endpoint` 和 `config_endpoint`，覆盖账号的登录设置；两者接受固定名单内的完整 HTTPS 根地址
（可带末尾 `/`）或短名。未知主机、带账号信息或附加路径/查询串的地址会回落 SLB，不会发送到任意 URL。
选择 CF 作配置接口仍按该选择调用，但界面标注“不建议选择”：它目前对 `/api` 返回 404。
插件不会自动把控制台凭据切换到另一条线路。

## 系统访问令牌不经过第三方

magpie 会把插件 `loader` 返回的选项交给**同一个 host 里所有插件**的 `chat.headers` 钩子
（`provider.options.apiKey`），而且当 `apiKey` 为空时 magpie 会用保存的 sign-in key 回填。
如果照直把系统访问令牌放进 `apiKey`，同机安装的其它插件就能拿到它。

所以本插件：

- `loader.apiKey` 永远是一个非秘密占位符（`magpie-packycode`）；
- `loader.fetch` 只接受指向 PackyAPI 主机的 URL（magpie 会把同一个 fetch 交给别的插件），
  传别的地址会直接拒绝，不会把分组令牌带出站；
- 每次请求时，从账号的令牌列表里选目标分组的令牌，替换 `Authorization`，并删掉
  `x-api-key` / `x-goog-api-key`；
- 测试 `the sign-in's key never reaches the model` 断言：发往模型服务的请求头里不含登录用的令牌。

## 插件用系统访问令牌做什么

- **只读**：价目表、令牌列表、用量明细、请求日志（只取分组/倍率字段用于学习价格）；
- **可选写入**：为「最便宜/次便宜分组」创建 `magpie-<分组>` 令牌。这个开关
  （`manage_keys`）**默认关闭**，在 Providers → PackyAPI → 编辑里打开时 magpie 会先要求确认。
  创建的令牌不设额度上限（仍受账号余额约束）、永不过期，名字带 `magpie-` 前缀，可在控制台随时删除。

## 插件不做什么

- 不把令牌、密钥或响应内容写入日志：错误信息只带主机、状态码和截断后的响应体；
- 失败诊断另存为 `~/.config/magpie/packycode-failures.jsonl`（模型、分组、状态码、原因、令牌名），
  不含密钥、请求头或请求体，权限 `0600`，上限 256 KB；
- 不读取你的对话内容；学习倍率用的请求日志只取 `group` / `model_name` / `other.group_ratio`；
- 不向 PackyAPI 之外的任何服务发送数据（没有遥测、没有统计上报）；
- 没有运行时依赖，也没有 postinstall 脚本。

## 响应体读取上限

控制台请求最多读 8 MiB，模型返回的错误体最多读 64 KiB；超出即中止，避免异常响应把插件内存吃满。

## 你可以做的

- 不在共享机器上长期保存系统访问令牌；
- 只想跑一个额度受限的 key 时，用「API Key」登录方式代替系统访问令牌；
- 定期在控制台检查 `magpie-*` 令牌，不需要的删掉；
- 怀疑泄漏时：控制台 → 个人设置 → 安全设置，撤销系统访问令牌；随后
  `magpie plugin logout packycode`，再重新登录。
