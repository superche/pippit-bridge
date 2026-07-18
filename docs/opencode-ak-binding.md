# OpenCode 绑定小云雀 AK 设计

状态：已实现客户端与 OpenCode plugin 侧；等待小云雀官网提供授权协议后启用无粘贴流程。

## 目标与非目标

目标是让用户在 OpenCode 中选择 Pippit 后，尽可能只完成一次官网确认，同时满足：

- Pippit AK 必须由小云雀官网签发。
- plugin 不抓取 Cookie、不读取网页 DOM、不模拟用户登录。
- AK 不进入浏览器 URL、shell argv、项目文件、日志或 telemetry。
- OpenCode 继续拥有 credential 生命周期；`/connect`、`auth list`、`auth logout` 行为一致。
- 桌面、SSH、容器和 WSL 都有可用路径。

当前小云雀视频接口不是语言模型接口。OpenCode 1.18.3 的 `provider.npm` 只加载 AI SDK `LanguageModelV3`，因此视频能力必须走标准 plugin custom tool，不能通过一个伪 chat provider 混入 `/models`。

## 两种部署模式

### Direct OpenCode

```text
OpenCode auth store
  -> opencode-provider-pippit
  -> Pippit SDK
  -> https://xyq.jianying.com
```

本机 OpenCode 是受信调用方。Pippit AK 由 OpenCode 保存，plugin 每次调用时读取当前 credential，只把它发送给代码中固定的 `https://xyq.jianying.com` 官方 origin；项目配置不能覆盖该地址。此模式不需要 Management API Key、Facade API Key、BYOK store 或常驻 gateway。

### Gateway / OpenRouter facade

```text
Facade API Key
  -> Pippit Bridge
  -> encrypted BYOK store
  -> Pippit AK
  -> https://xyq.jianying.com
```

这条边界保持不变。Pippit AK 不能直接成为 facade Bearer token；Management、Facade、Pippit 三种凭证继续隔离。Direct provider 的出现不能降低服务器模式的安全边界。

## 阶段 1：官网尚无授权 API

安全体验的下限是“一次官网签发 + 一次隐藏粘贴”：

1. OpenCode 配置加载 `opencode-provider-pippit`。
2. 用户运行 `/connect`，选择 `Pippit`。
3. 用户在小云雀官网为当前设备创建专用 AK。
4. 用户选择 `粘贴官网已签发的 AK / Paste an Access Key issued by Pippit`。
5. OpenCode 使用内置 password prompt 接收 AK，并保存为 `pippit` 的 API credential。
6. plugin 的 `auth.loader` 只保留 OpenCode 提供的 credential getter；不会复制到第二个 secret store。

手工 fallback 必须是没有自定义 `authorize()` 的 `type: "api"`。不能用以下替代方案：

- OAuth `method: "code"` 直接接收 AK：OpenCode 当前把 code 当普通文本输入。
- AuthHook 普通 text prompt：同样不是 secret prompt。
- `--ak <value>`：会进入 argv 和 shell history。
- 项目 `.env` 或 `opencode.json`：会扩大泄漏面并污染项目配置。
- 后台监听 clipboard：超出用户授权，且无法保证其他进程没有读取。

AK 校验只做稳定的格式下限：trim 后 1 到 4096 个可见 ASCII 字符。不能硬编码 `ak-` 前缀或当前长度；官网以后可能升级格式。没有官方、无费用 introspection API 时，也不能用“先生成一个视频”验证 AK。

## 阶段 2：官网无粘贴绑定

默认采用 OAuth 2.0 Device Authorization Grant（RFC 8628），因为它同时覆盖桌面和 headless 环境，也不要求 plugin 监听固定端口。

### 官网接口

#### 申请 device grant

```http
POST /developer/ak/device_authorization
Content-Type: application/x-www-form-urlencoded
Accept: application/json

client_id=pippit-opencode
&scope=asset.upload%20video.generate%20video.read
```

响应：

```json
{
  "device_code": "high-entropy-secret",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://xyq.jianying.com/developer/ak/device",
  "verification_uri_complete": "https://xyq.jianying.com/developer/ak/device?user_code=ABCD-EFGH",
  "expires_in": 300,
  "interval": 5
}
```

`device_code` 必须高熵、短期、单次使用；`user_code` 只用于人机匹配，不能充当 token。官网确认页应显示：

- 当前 Pippit 账号/空间。
- client：OpenCode。
- 设备标签与 key 名称，例如 `OpenCode · MacBook · 2026-07-17`。
- scope、有效期和撤销入口。
- “授权并签发 AK”确认动作。

#### 轮询并领取 AK

```http
POST /developer/ak/token
Content-Type: application/x-www-form-urlencoded
Accept: application/json

grant_type=urn:ietf:params:oauth:grant-type:device_code
&client_id=pippit-opencode
&device_code=...
```

未完成时遵循 RFC 8628：

```json
{ "error": "authorization_pending" }
```

还必须支持：

- `slow_down`：客户端在原 interval 上增加 5 秒。
- `access_denied`：用户拒绝。
- `expired_token`：device grant 已过期。

成功响应：

```json
{
  "access_token": "<officially-issued-pippit-ak>",
  "token_type": "Bearer",
  "expires_in": 7776000,
  "scope": "asset.upload video.generate video.read",
  "key_id": "ak_..."
}
```

`access_token` 就是官网签发的专用 Pippit AK。token endpoint 必须：

- 只通过 HTTPS 返回，响应使用 `Cache-Control: no-store`。
- 不重定向，不在错误信息中回显 `device_code` 或 AK。
- 把 grant 绑定到 `client_id`、用户、scope 和 consent。
- 单次消费；网络重试应幂等，不能创建多把孤儿 AK。
- 在 token exchange 完成时才最终创建 AK，或自动清理未领取的 pending AK。

### OpenCode AuthHook 映射

plugin 已实现的接口形状：

```ts
auth: {
  provider: "pippit",
  methods: [
    {
      type: "oauth",
      label: "小云雀官网一键绑定 / Bind on Pippit website",
      authorize: async () => ({
        url: verification_uri_complete,
        instructions: "Confirm the grant in your browser",
        method: "auto",
        callback: pollTokenEndpoint
      })
    },
    {
      type: "api",
      label: "粘贴官网已签发的 AK / Paste an Access Key issued by Pippit"
    }
  ]
}
```

callback 成功返回：

```ts
{
  type: "success",
  provider: "pippit",
  key: access_token
}
```

OpenCode 随后以标准 API credential 保存它。官方 `/connect` 成功后会执行 `global.dispose()` 并重建 provider instance，因此新 AK 可立即被 `auth.loader` 读取；若绕过 `/connect` 直接调用底层 auth API，则需要显式 dispose 或重启 OpenCode。官网接口未上线时不展示 OAuth method，避免出现“能打开网页但永远无法完成”的假一键流程；masked paste 始终保留为 fallback。

启用方式：

```json
{
  "plugin": [
    [
      "opencode-provider-pippit",
      {
        "deviceAuthorization": {
          "authorizationURL": "https://xyq.jianying.com/developer/ak/device_authorization",
          "tokenURL": "https://xyq.jianying.com/developer/ak/token",
          "clientID": "pippit-opencode",
          "scope": "asset.upload video.generate video.read"
        }
      }
    ]
  ]
}
```

客户端要求两个 endpoint 使用相同 HTTPS origin，且 issuer 与 verification URL 都必须回到代码中固定的小云雀官方 origin，不允许项目配置覆盖。

## 可选桌面优化：Authorization Code + PKCE

如果官网要优化桌面端回跳，可增加 Authorization Code + PKCE：

1. plugin 先绑定 `127.0.0.1:<ephemeral>`，生成随机 callback path、`state` 和 PKCE verifier/challenge。
2. 浏览器打开官网 authorize URL。
3. 浏览器只回传一次性 `code + state`。
4. plugin 校验 state，用 code + verifier 通过 HTTPS 换 AK。
5. loopback server 立即关闭。

要求：

- PKCE S256，禁止 plain。
- 只监听 IP literal loopback，不监听 `0.0.0.0`。
- callback path 与 state 至少 128 bit 随机性。
- code 绑定 `client_id + redirect_uri + code_challenge`，短 TTL、单次使用。
- AK 绝不进入 query、fragment、deep link 或 callback HTML。

Device Flow 仍是 SSH/容器默认路径。自定义 deep link 不是 MVP：OpenCode AuthHook 没有注册 OS scheme 的接口，自定义 scheme 也可能被其他应用抢注。

## 凭证保存与撤销

OpenCode 标准路径为 `~/.local/share/opencode/auth.json`，文件权限为 `0600`，内容仍是明文 JSON，不是系统 keychain。MVP 接受这个标准边界，以换取 `/connect`、`auth list/logout` 和跨平台一致性：

- 不再生成 plugin 私有 secret 文件。
- `auth list` 不回显 AK。
- `auth logout` 只删除本地 credential，不等于官网撤销。
- 官网必须提供按 `key_id` 查看、最近使用、到期和撤销的页面。
- 同 UID 恶意进程仍可能读取 AK；这不是 `0600` 能解决的威胁。

以后可评估 macOS Keychain、Windows Credential Manager 与 Secret Service，但必须先解决 OpenCode logout 没有 plugin cleanup hook 时的孤儿凭证问题。

## 威胁模型

| 风险 | 控制 |
| --- | --- |
| AK 出现在 URL/history/referrer | 浏览器只携带 user code 或一次性 authorization code；AK 只走 token HTTPS response |
| 仿冒 issuer | 官网 endpoint 同源 HTTPS 校验；生产包固定官方 origin |
| device flow phishing | consent 页展示 client、账号、设备、scope、有效期；user code 短期且限速 |
| loopback 劫持 | PKCE、state、随机 path/port、仅 loopback、短超时 |
| 重定向带走 AK | token 请求 `redirect: error`；带 AK 的 API 请求不得跨 origin redirect |
| terminal/clipboard 泄漏 | OpenCode masked API prompt；无 argv、无自定义 text prompt、无后台 clipboard 监听 |
| 日志泄漏 | SDK 错误不保留 Authorization、response body 或 fetch cause；失败信息再次替换 AK |
| npm 供应链 | 官方 package、provenance、公开 registry lockfile、最低/最新 OpenCode 双版本 CI |
| 生成计费误触 | `pippit_generate_video` 每次提交前调用 OpenCode permission ask |
| 模型静默写盘 | 默认下载前调用独立的 `pippit_download_video` permission ask，并展示 run ID 与输出目录 |
| 网络请求永久挂起 | Device Flow、Pippit API 查询和视频下载均设置请求/剩余 TTL 截止；瞬时 token 错误退避重试 |
| 重复下载覆盖文件 | 使用 `wx` 原子创建和 collision-safe 后缀；永不覆盖或删除已有文件 |
| 本地文件外带 | local reference 必须 realpath 后仍位于当前 worktree；远端 URL 默认拒绝私网 |
| 孤儿 AK | exchange 时最终创建或自动回收 pending key；exchange 幂等 |
| logout 与 revoke 混淆 | CLI/文档明确区分；提供官网撤销入口 |

## 验收标准

### 当前 fallback

- 新环境无需手工写 provider credential JSON。
- AK 输入在终端不可见，不出现在 scrollback、argv、项目文件、错误或日志。
- plugin 不读取 Pippit Cookie，也不启动 browser automation。
- `opencode auth list` 能看到 `pippit` API credential。
- Direct 调用期间没有 gateway/sidecar。
- 无效/撤销 AK 返回脱敏的重新绑定指引，不自动提交“测试视频”。
- local references 与输出均不能越过 worktree；HTTP references 默认不能访问私网。
- 生成工具在付费提交前出现 permission confirmation。
- 下载工具在写入 worktree 前出现独立 permission confirmation；两种权限均不提供永久放行模式。

### 官网协议版

- 已登录用户只需在官网完成一次 consent，全程无需 copy/paste。
- URL、浏览器历史、callback HTML、服务日志中没有 AK。
- `authorization_pending`、`slow_down`、拒绝、过期、网络失败都有自动化测试。
- device grant 单次消费，重复 exchange 不产生第二把 AK。
- 同一 OpenCode 实例的并发 Pippit 登录被拒绝或显式替换旧 flow。
- macOS、Windows、Linux、SSH/container 都有真实 OpenCode runtime 验收。
- 官网可按 key ID 显示 scope、有效期、最近使用并撤销。

## 版本与扩展

- OpenCode 最低支持版本：`1.18.0`；实现按 `@opencode-ai/plugin` `1.18.3` 编译验证。
- 当前外部 plugin 在 OpenCode `--pure` 模式下不会加载。
- 一个 OpenCode provider ID 当前只有一个 active credential；多账号切换不属于 MVP。
- auth 生命周期与视频模型目录分离。新增 Seedance/Pippit 版本只修改 `packages/core/src/models.ts`，不改变 credential。
- 如果未来小云雀公开真正的聊天/流式/tool-call API，再单独发布 AI SDK `LanguageModelV3` provider；不能复用当前视频 tool 冒充。

## 依据

- [OpenCode Providers](https://opencode.ai/docs/providers/)
- [OpenCode Plugins](https://opencode.ai/docs/plugins/)
- [OpenCode AuthHook 类型](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts)
- [OpenCode credential 保存实现](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/auth/index.ts)
- [RFC 8628 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628)
- [RFC 7636 PKCE](https://www.rfc-editor.org/rfc/rfc7636)
- [RFC 8252 Native Apps](https://www.rfc-editor.org/rfc/rfc8252)
