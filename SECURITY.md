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

插件**不把任何密钥写进自己的文件**。它唯一写入的磁盘文件是
`~/.config/magpie/packycode-groups.json`，内容只有分组倍率（数字），权限 `0600`；写入前会检查它
不是符号链接。

## 网络

插件只访问 PackyAPI 自己的三个域名，代码里没有其它出站地址，`test/package.test.mjs` 会扫描
运行时代码，出现别的 host 就测试失败：

- `https://slb-v1.api.fan`（默认：推理 + 控制台）
- `https://cf.api.fan`（推理，控制台接口不存在）
- `https://www.packyapi.com`（推理 + 控制台）

登录方式里的“接口线路”是固定的三个选项；手工改配置文件填入未知主机时，代码会回落到默认主机，
不会拿任意 URL 去发请求。

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
