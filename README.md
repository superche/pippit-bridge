# Pippit Bridge

<p align="center">
  <img src="./assets/brand/pippit-bird.png" width="180" alt="Pippit Bridge 飞鸟 Logo" />
</p>

## 安装方法

### OpenCode

从公开 npm registry 全局安装 OpenCode provider：

```bash
opencode plugin @pippit-bridge/opencode-provider --global
```

也可以在全局或项目 `opencode.json` 中配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@pippit-bridge/opencode-provider"]
}
```

### Codex

从公开 GitHub marketplace 安装 `pippit-video` plugin，无需克隆本仓库或使用本地路径：

```bash
codex plugin marketplace add superche/pippit-bridge --ref main --json
codex plugin add pippit-video@pippit-bridge --json
codex plugin list --json
```

Codex plugin 运行时需要 Node.js 22.22.2+、24.15.0+ 或 26+，并确保 `npm` / `npx` 可用。安装完成后重启 ChatGPT Desktop 或新建 Codex session。完整接入说明见 [MCP、ChatGPT App 与 Codex plugin](./docs/integrations.md)。

Pippit Bridge 是小云雀（Pippit）的 API gateway 与 adapter monorepo。当前同时提供：

- OpenRouter 风格的视频生成 facade 与服务器持久化 BYOK。
- 可发布的 Pippit TypeScript SDK、共享模型目录与安全素材能力。
- `@pippit-bridge/opencode-provider`：使用 OpenCode 标准 auth/plugin/tool 接口的本地视频 provider。
- `@pippit-bridge/mcp-server`：通用 stdio MCP server，面向支持 MCP 的本地 agent/client。
- `@pippit-bridge/chatgpt-app`：使用 Streamable HTTP `/mcp` 与 Apps SDK widget 的 ChatGPT App。
- `pippit-video`：从公开 GitHub marketplace 安装的 Codex plugin；公开快照携带 manifest、skill 与启动 shim，运行时使用 npm 上的同一个 stdio MCP server。

**当前三种封装的媒体能力都只覆盖视频。** 图片、视频和音频可以作为视频生成的参考素材，但这不代表已提供文本、图片生成、语音生成或转录工具。通用 MCP 与 Codex plugin 另外提供 facade 账号管理；ChatGPT App 的 `noauth` developer-mode surface 不暴露这组管理工具。

```text
pippit-bridge
├── apps
│   ├── openrouter-facade
│   └── chatgpt-app
├── packages
│   ├── core
│   ├── sdk
│   ├── mcp-server-pippit
│   └── opencode-provider-pippit
├── .agents/plugins/marketplace.json
└── docs
```

`core` 是模型版本与安全素材真源；`sdk` 只封装小云雀官方 AK API；facade 和 OpenCode provider 只能向下依赖它们。MCP server 只调用 facade，ChatGPT App 再复用 MCP 的工具实现；Codex plugin 的 manifest、skill 和 `.mcp.json` 直接随 `packages/mcp-server-pippit` 分发。后续的 CLI、ComfyUI、n8n 和 OpenMontage adapter 仍可作为新 workspace 增加，不需要复制上游协议实现。

## MCP、ChatGPT App 与 Codex plugin

| 形式 | 运行入口 | 暴露能力 | 适用场景 |
| --- | --- | --- | --- |
| 通用 MCP package | `packages/mcp-server-pippit/src/stdio.ts` | 安全新增/列出/切换/删除 AK；列模型、生成、参考视频重新生成、查询；completed 自动本地落盘与受限额外下载 | 支持 stdio MCP 的本地 client |
| ChatGPT App | `https://<host>/mcp` | 投影 MCP 的列模型、生成、查询和参考视频重新生成，并用结果 widget 选段/框选注释 | ChatGPT developer mode；本地或 tunnel 调试 |
| Codex plugin | `pippit-video@pippit-bridge` | `.mcp.json` 直接启动同一个通用 MCP，skill 只负责安全编排 | Codex CLI 或 ChatGPT Desktop 的 Codex 插件面 |

本地 stdio MCP、Codex plugin 和本地 ChatGPT App 默认不需要预设 facade 环境变量。安装与 `initialize` / `tools/list` 发现阶段不启动服务、也不创建密钥；第一次实际 MCP 工具调用（或本地 ChatGPT App 启动）才幂等创建/复用一个用户级、只监听 loopback 的共享 Facade。内部 runtime、management、BYOK encryption、job signing 与 ChatGPT media signing key 保存在 plugin cache 和项目目录之外，卸载 plugin 默认不会删除账号数据；Codex/stdio 预览通过宿主代理的 MCP 本地资源读取，不依赖临时端口。

部署方也可以显式使用外部 Facade；此时下面两个变量必须成对设置，半套配置会 fail closed，不会与本地自动配置混用：

```bash
export PIPPIT_FACADE_BASE_URL=http://127.0.0.1:3000
export PIPPIT_FACADE_API_KEY='<facade-api-key>'
```

`PIPPIT_FACADE_API_KEY` 是 wrapper 访问外部 facade 的凭证，不是 Pippit AK。自动本地模式会自行生成与保存内部 Facade/Management key；Pippit AK 仍只能从 `pippit_add_access_key` 返回的短时 loopback password 页面进入加密 store，不应写入环境变量、MCP client 配置、ChatGPT widget、工具结果或 Codex plugin。

外部模式下，stdio MCP / Codex 若要管理 AK，还需设置与 runtime key 严格分离的 `PIPPIT_FACADE_MANAGEMENT_API_KEY`。切换状态按 Facade API Key 指纹持久化在加密 BYOK store 中，因此同一 runtime identity 的 MCP、Codex 与 ChatGPT App 对“新任务使用哪个账号”保持一致。ChatGPT App 当前不投影 AK 管理工具，也不会继承 Management key。

最短启动命令：

```bash
# 通用 stdio MCP / Codex plugin 内嵌 server
npm run dev:mcp

# ChatGPT App，默认监听 http://127.0.0.1:8787/mcp
npm run dev:chatgpt-app
```

本地 ChatGPT App 未配置公开 origin 时不启用媒体预览。设置 tunnel/部署 origin `CHATGPT_APP_PUBLIC_BASE_URL` 后，本地自动模式会使用独立的用户级 media signing key；显式外部 Facade 模式仍须同时设置 `CHATGPT_APP_MEDIA_SIGNING_KEY_HEX`。

Codex plugin 的 manifest 是声明式配置，宿主没有可安全生成/注入 secret 的 install/postinstall hook；因此这里的“安装自动处理”落在首次实际能力调用，而不是安装期间执行任意代码。ChatGPT developer/production App 仍必须部署为可达 HTTPS endpoint、在 ChatGPT 注册真实 app ID；生产多用户形态还必须增加 OAuth 与远程 secret manager，不能由本地 plugin 安装代替。

完整的 MCP client 配置、ChatGPT developer-mode 注册、Codex marketplace 安装命令、生产 OAuth 要求和 `.app.json` 真实 ID 边界见 [三种集成形式](./docs/integrations.md)。

## OpenCode provider

OpenCode 1.18.3 的 model provider contract 是 AI SDK `LanguageModelV3`。小云雀当前公开的是异步视频任务 API，不是聊天/流式语言模型；本项目不会把视频模型伪装成聊天模型。功能性接入使用 OpenCode 官方支持的组合：

- `auth` hook：复用 `/connect` 的隐藏密码输入框，安全导入官网签发的 Pippit AK。
- `pippit_manage_access_keys`：配置、脱敏列出、切换和删除多个本地账号的 AK。
- `pippit_generate_video`：上传参考素材并提交视频生成；每次付费提交前显式请求权限。
- `pippit_get_video`：查询任务；写入 worktree 前单独请求下载权限。
- 共享模型目录：新增 Pippit 模型版本时只增加 catalog entry，两个 adapter 同步可见。

直接安装到 OpenCode 全局配置：

```bash
opencode plugin @pippit-bridge/opencode-provider --global
```

也可以在 OpenCode 配置中加入：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@pippit-bridge/opencode-provider"]
}
```

让 OpenCode 配置一个账号时，调用 `pippit_manage_access_keys` 的 `configure` 操作并传入本地账号名。工具会返回 `https://xyq.jianying.com`，并明确提示用户登录目标账号、去页面顶部签发 AK；工具本身不接收 AK。签发后运行 `/connect`，选择 `Pippit`，把 AK 粘贴进 OpenCode 自己的 secret/password prompt。configure 阶段保存的非敏感账号名会把这次 import 合并进全局 keyring 并设为 active，已有账号不会被覆盖。

同一个 `pippit_manage_access_keys` 工具还提供：

- `list`：只返回 `account_id`、本地账号名、脱敏 AK 与 active 状态。
- `switch`：按 `account_id` 或账号名切换新任务使用的 AK。
- `delete`：删除本地保存；删除 active 且仍有其他账号时必须先显式 switch。工具会展示受影响的历史 run 数量，并提醒“本地删除不等于官网撤销”。

OpenCode 1.18.3 的 auth store 对一个 provider 只能保存一条 credential，因此多账号秘密保存在 OpenCode 全局 state 下的 `pippit/access-keys.json`，而不是项目目录。父目录使用 `0700`、文件使用 `0600`，原子替换写入；和 OpenCode 自己的 `auth.json` 一样，当前内容是同 UID 可读的明文，不是系统 keychain。plugin 不读取 Cookie、不监听剪贴板、不把 AK 放进普通 tool 参数、项目配置、日志或 telemetry，也不启动 gateway/sidecar。

`opencode auth logout pippit` 只能清理 OpenCode 自己的单一 import slot；删除多账号 keyring 中的本地 AK 必须使用 `pippit_manage_access_keys delete`。需要让 AK 立即失效时，还必须在小云雀官网顶部的 AK 管理入口撤销。

Direct provider 的 API 与 Device Flow issuer 都固定为小云雀官方 origin，项目配置不能把已保存 AK 改发到其他站点。`PIPPIT_ACCESS_KEY` 仍用于 CI/短期隔离环境，并覆盖新任务使用的本地 active 账号；管理工具会把这个 override 明确返回。已持久绑定的历史 `run_id + thread_id` 始终优先使用原账号，不会被后来设置的环境变量或 active 切换静默改写；若原账号已删除则 fail closed。

官网尚未提供机器可消费的授权协议时，最短安全路径仍需要用户在官网复制并隐藏粘贴一次 AK。真正无粘贴的一键绑定已经按 RFC 8628 Device Authorization 预留实现：官网提供授权与 token endpoint 后，`/connect` 会打开官网，用户确认一次，plugin 自动把新签发 AK 交回 OpenCode。AK 不经过浏览器 URL。完整协议、威胁模型与验收标准见 [OpenCode AK 绑定设计](./docs/opencode-ak-binding.md)。

OpenCode 包的安装与 options 见 [packages/opencode-provider-pippit/README.md](./packages/opencode-provider-pippit/README.md)。

## OpenRouter facade

facade 底层调用小云雀的“生成沉浸式短片视频”API，并提供服务器持久化 BYOK（Bring Your Own Key）。

调用方不会把 Pippit AK 直接用作 facade 的 Bearer token。部署管理员先用 Management API Key 将小云雀官方签发的 Pippit AK 写入 `/api/v1/byok`；运行时调用方再使用独立的 Facade API Key 访问模型、生成、轮询和下载接口。

```text
Management API Key -> /api/v1/byok
                   -> /api/v1/byok/active
                   -> encrypted Pippit AK store + per-Facade-key active selection

Facade API Key -> POST /api/v1/videos
               -> POST /api/v1/videos/edits
               -> GET /api/v1/videos/{jobId}
               -> GET /api/v1/videos/{jobId}/content?index=0
```

对图片、视频和音频参考素材，服务会先下载每个 URL，逐个调用小云雀上传接口取得 `data.pippit_asset_id`，全部成功后才提交视频任务：

```text
image_url / video_url / audio_url
  -> POST /api/biz/v1/skill/upload_file
  -> data.pippit_asset_id
  -> POST /api/biz/v1/skill/submit_run
  -> thread_id + run_id
  -> POST /api/biz/v1/agent/query_generate_video_result
```

## 认证边界

| 凭证 | 来源与保存方式 | 允许访问的接口 |
| --- | --- | --- |
| Management API Key | 部署方生成；服务配置中只保存 SHA-256 | 仅 `/api/v1/byok` CRUD |
| Facade API Key | 部署方生成并发给调用方；服务配置中只保存 SHA-256 allowlist | `/api/v1/models`、`/api/v1/videos/**` |
| Pippit AK | 从小云雀官方页面签发；通过 BYOK API 写入并加密落盘 | 仅由服务调用 Pippit 上游，不作为 facade Bearer token |
| BYOK encryption key | 32 个随机字节；仅部署环境持有 | AES-256-GCM 加密 BYOK store |
| Job signing key | 另一把独立的 32 字节随机密钥 | 签名并校验异步 `jobId` |

Management API Key 不能调用模型或视频接口，Facade API Key 不能管理 BYOK；若 Management digest 同时出现在 Facade allowlist，服务会拒绝启动。`BYOK_ENCRYPTION_KEY_HEX` 与 `JOB_SIGNING_KEY_HEX` 必须不同。

本项目参考 OpenRouter 的 BYOK 管理资源和 Management API Key 认证方式，但有两个明确扩展：

- BYOK 请求中的 `provider: "pippit"` 是本 facade 扩展；OpenRouter 官方 provider 枚举不应被理解为已经包含 Pippit。
- 在 BYOK create/update 中写入 `allowed_api_key_hashes` 是本 facade 扩展，用于把一条 Pippit AK 限定给指定 Facade API Key 的 SHA-256；传 `null` 表示不做该项限制。

当前 facade 只解析静态 Facade API Key，没有 per-user identity。`allowed_user_ids` 只有为 `null` 时才能用于当前运行时路由；一旦写成非空列表，任何视频请求都不会匹配该 credential。保留这个字段是为了契约兼容和未来扩展，不代表已经支持 user routing。

当前 file store 是单 workspace 实现，workspace 固定为 `00000000-0000-0000-0000-000000000000`。创建 credential 时建议省略 `workspace_id`；传入其他 workspace id 会被拒绝，不会被静默合并。

原始 Pippit AK 不会由 list/get/update 响应回显，响应只返回掩码 `label` 和路由元数据。

### Pippit AK 的签发边界

Pippit AK 必须由用户在小云雀官方页面中签发。本 provider 不导入 Pippit Cookie，也不代替官方页面管理 AK；它只接收已经由官方签发的 AK，并通过自己的 Management-Key-protected BYOK API 加密保存。

## 快速开始

完整 monorepo 要求 Node.js 22.22.2+、24.15.0+ 或 26+；单独运行 facade/core/sdk 的最低版本仍为 Node.js 22。

先生成四个彼此独立的高熵值：

```bash
export MANAGEMENT_API_KEY="$(openssl rand -hex 32)"
export FACADE_API_KEY="$(openssl rand -hex 32)"

printf '%s' "$MANAGEMENT_API_KEY" | shasum -a 256
printf '%s' "$FACADE_API_KEY" | shasum -a 256

openssl rand -hex 32 # BYOK_ENCRYPTION_KEY_HEX
openssl rand -hex 32 # JOB_SIGNING_KEY_HEX，必须与上一行不同
```

复制配置，并把上面两个摘要和两把 64 位十六进制密钥填入 `.env`：

```bash
npm install
cp .env.example .env
npm run dev
```

默认监听 `http://127.0.0.1:3000`。所有必需密钥或摘要缺失时，服务会拒绝启动。

### 1. 写入 Pippit BYOK

先从小云雀官方页面创建并复制 AK，再用 Management API Key 写入。以下示例将该 AK 限定给一个 Facade API Key；`FACADE_API_KEY_SHA256` 是该 Facade API Key 的小写 SHA-256：

```bash
export PIPPIT_AK='ak-...'
export FACADE_API_KEY_SHA256='<sha256-of-facade-api-key>'

curl -X POST http://localhost:3000/api/v1/byok \
  -H "Authorization: Bearer $MANAGEMENT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{
    \"provider\": \"pippit\",
    \"key\": \"${PIPPIT_AK}\",
    \"name\": \"production-pippit\",
    \"allowed_models\": [\"pippit/seedance-2.0\"],
    \"allowed_api_key_hashes\": [\"${FACADE_API_KEY_SHA256}\"]
  }"
```

成功返回 HTTP `201`，其中 `data.id` 是 BYOK credential id；`key` 不会返回：

```json
{
  "data": {
    "id": "30a504af-e33b-46a3-a689-b40fae68bd25",
    "provider": "pippit",
    "label": "ak-****bc12",
    "name": "production-pippit",
    "disabled": false,
    "is_fallback": false
  }
}
```

管理接口均只接受 Management API Key，并返回 `Cache-Control: no-store`：

```text
POST   /api/v1/byok
GET    /api/v1/byok
GET    /api/v1/byok/{id}
PATCH  /api/v1/byok/{id}
DELETE /api/v1/byok/{id}
```

用 `PATCH` 传入新的 `key` 会创建新的内部 key version。已经生成的 `jobId` 仍绑定旧 version，因此轮询不会因为正常轮换而漂移到新 AK。删除 credential 会同时删除其版本，依赖它的未完成任务将无法再查询；若需要立即吊销，应同时在小云雀官方侧撤销 AK。

### 2. 发现模型

模型和视频接口使用 Facade API Key：

```bash
curl http://localhost:3000/api/v1/videos/models \
  -H "Authorization: Bearer $FACADE_API_KEY"
```

### 3. 提交视频

```bash
curl -X POST http://localhost:3000/api/v1/videos \
  -H "Authorization: Bearer $FACADE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "pippit/seedance-2.0",
    "prompt": "以产品特写开场，镜头缓慢推进，最后出现品牌标语",
    "duration": 10,
    "resolution": "720p",
    "aspect_ratio": "9:16",
    "provider": {
      "options": {
        "pippit": {
          "byok_id": "30a504af-e33b-46a3-a689-b40fae68bd25"
        }
      }
    },
    "input_references": [
      {
        "type": "image_url",
        "image_url": { "url": "https://example.com/product.png" }
      },
      {
        "type": "video_url",
        "video_url": { "url": "https://example.com/motion.mp4" }
      },
      {
        "type": "audio_url",
        "audio_url": { "url": "https://example.com/music.mp3" }
      }
    ]
  }'
```

`provider.options.pippit.byok_id` 也是 facade 扩展；省略时服务会按 credential 的限制条件和排序自动选择。继续已有 `thread_id` 且存在多个可用 credential 时，必须显式提供 `byok_id`，避免把 Pippit 会话切换到另一条 AK。

成功返回 HTTP `202`：

```json
{
  "id": "pippit_job_v2....",
  "polling_url": "/api/v1/videos/pippit_job_v2....",
  "status": "pending",
  "generation_id": "marketing_...",
  "model": "pippit/seedance-2.0",
  "usage": { "is_byok": true }
}
```

用提交任务时的同一个 Facade API Key 查询和下载：

```bash
curl http://localhost:3000/api/v1/videos/$JOB_ID \
  -H "Authorization: Bearer $FACADE_API_KEY"

curl "http://localhost:3000/api/v1/videos/$JOB_ID/content?index=0" \
  -H "Authorization: Bearer $FACADE_API_KEY" \
  --output result.mp4
```

`jobId` 是带 HMAC 的无状态句柄，绑定 Facade API Key、workspace、BYOK credential/key version、`thread_id`、`run_id` 和 facade model id。只要相同的 job signing key 和所需 credential version 仍存在，服务重启后即可继续查询。

## BYOK 选择与 fallback

运行时只考虑满足以下条件的 credential：未禁用、`provider`/workspace 匹配、允许当前 model，并且 `allowed_api_key_hashes` 允许当前 Facade API Key。主 credential 按 `sort_order` 优先，`is_fallback: true` 的 credential 排在其后。

服务只在 Pippit 明确返回 HTTP `401`、`403` 或 `429` 时尝试下一条 credential。网络错误、超时或 `submit_run` 结果不确定时不会 fallback，避免同一请求在上游产生重复任务。每次切换 credential，参考图片、视频和音频都会使用该 credential 重新上传并取得新的 `data.pippit_asset_id`，随后才调用 `submit_run`。

## 首尾帧

OpenRouter 的 `frame_images` 会映射为小云雀 `generate_type: 1`。上传顺序固定为首帧、尾帧，不依赖调用方数组顺序。

```json
{
  "model": "pippit/seedance-2.0",
  "prompt": "从白天平滑过渡到夜景",
  "frame_images": [
    {
      "type": "image_url",
      "image_url": { "url": "https://example.com/first.png" },
      "frame_type": "first_frame"
    },
    {
      "type": "image_url",
      "image_url": { "url": "https://example.com/last.png" },
      "frame_type": "last_frame"
    }
  ]
}
```

与 OpenRouter 当前语义一致，同时传 `frame_images` 和 `input_references` 时，`frame_images` 优先，后者不会上传或提交。

## 模型

| Facade model | Pippit model | 分辨率 |
| --- | --- | --- |
| `pippit/seedance-2.0-fast` | `seedance2.0_fast_vision` | `480p`, `720p` |
| `pippit/seedance-2.0` | `seedance2.0_vision` | `480p`, `720p`, `1080p` |
| `pippit/seedance-2.0-mini` | `Seedance_2.0_mini` | `480p`, `720p` |
| `pippit/seedance-2.0-mini-lite` | `Seedance_2.0_mini_lite` | `480p`, `720p` |

为迁移已有调用，`model` 也接受表格中的原始 Pippit model 字符串；模型发现接口只返回稳定的 facade id。

接口同时提供：

- `GET /api/v1/videos/models`：OpenRouter 视频模型能力结构，需要 Facade API Key。
- `GET /api/v1/models`：带 `architecture.input_modalities/output_modalities` 的通用模型列表，需要 Facade API Key。
- `GET /openapi.json`：OpenAPI 3.1 描述。
- `GET /health`：不鉴权的健康检查；加密 BYOK store 不可用时不会返回健康状态。

## 参数映射

| OpenRouter 字段 | Pippit 字段/行为 |
| --- | --- |
| `prompt` | 同时写入 `message` 与 `video_part_tool_param.prompt` |
| `duration` | `duration_sec`；省略时默认 5 秒 |
| `aspect_ratio` | `ratio` |
| `resolution` | `resolution` |
| `size` | 显式拒绝；Pippit 只承诺 `resolution + ratio`，不能保证精确像素尺寸 |
| `seed` | `video_part_tool_param.seed` |
| `frame_images` | 先上传并取得 `data.pippit_asset_id`，写入 `images`，设置 `generate_type: 1` |
| `input_references` | 图片/视频/音频先上传并取得 `data.pippit_asset_id`，再写入 `images` / `videos` / `audios` |
| `provider.options.pippit.byok_id` | facade 扩展；固定使用指定 BYOK credential |
| `provider.options.pippit.thread_id` | facade 扩展；复用已有 Pippit 会话 |

小云雀文档没有暴露 `callback_url` 和可控的 `generate_audio`，因此显式传入这两个字段会返回 `unsupported_parameter`，不会静默忽略。

## 参考素材安全

- 只接受 `http:` / `https:` URL；不接受 `data:`、`file:` 或携带 URL credentials 的地址。
- 默认拒绝 localhost、私网、链路本地和其他非公网目标；每次重定向都会重新校验，生产传输会把已校验 DNS 地址固定到实际 socket，避免 DNS rebinding。
- 根据文件特征和 MIME/扩展名校验格式：图片支持 JPEG/PNG/GIF/BMP/WebP，视频支持 MP4/MOV，音频支持 MP3/WAV。
- 默认单文件上限为图片 30 MiB、视频 200 MiB、音频 15 MiB；单请求总计 300 MiB，音频合计 15 MiB。
- 默认单请求上传并发和全局素材工作并发均为 1；同一请求内相同类型、相同 URL 只上传一次。
- 任一下载或上传失败会中止当前 credential 的提交；没有成功上传全部参考素材时不会调用该 credential 的 `submit_run`。
- 生成结果也通过本服务代理；结果 URL 使用同一套公网目标与重定向校验，并支持 `Range` 下载。

如确实需要访问内网素材，可设置 `ALLOW_PRIVATE_REFERENCE_URLS=true`；只应在受信网络和受控调用方场景启用。

## File store 部署边界

默认 `BYOK_STORE_PATH=./data/byok-credentials.json` 使用本地 file store。它适用于单进程、单实例的本地 POSIX 部署，不支持多副本或 NFS/共享文件系统，也不是分布式凭证库。

- 父目录必须由服务用户拥有且权限为 `0700` 或更严格；store 和 `${BYOK_STORE_PATH}.lock` 使用 `0600`。
- 进程以排他方式创建 `.lock`。若启动提示锁不可用，应先确认没有其他 provider 进程使用该 store；只有确认是崩溃遗留的 stale lock 后才能人工删除。
- 每次变更会以临时文件、`fsync`、原子 rename、目录 `fsync` 的方式写入完整 AES-256-GCM envelope。
- AES-GCM 能校验机密性和完整性，但不能判断一个旧的、仍然有效的完整 store snapshot 是否被回滚。备份/快照的访问控制与版本新鲜度必须由部署系统负责。
- update/delete 只保证当前逻辑 store 不再使用旧 AK。APFS/文件系统快照、备份、SSD wear leveling 可能仍保留旧 ciphertext；本服务不声称实现物理擦除。需要立即吊销时，以小云雀官方侧撤销 AK 为准。

容器部署必须把 `/app/data` 挂载到持久卷；同一卷同一时间只运行一个 provider 实例。`BYOK_ENCRYPTION_KEY_HEX`、`JOB_SIGNING_KEY_HEX`、Management/Facade 原始 Key 应由 secret manager 注入，不要写入镜像或提交到仓库。

## 配置

见 [.env.example](./.env.example)。常用项：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BYOK_ENCRYPTION_KEY_HEX` | 无 | 必填；32 个随机字节的 64 位小写 hex，用于加密 Pippit AK |
| `JOB_SIGNING_KEY_HEX` | 无 | 必填；另一把 32 字节随机密钥，用于 job token HMAC |
| `BYOK_MANAGEMENT_KEY_SHA256` | 无 | 必填；Management API Key 的小写 SHA-256 |
| `FACADE_API_KEY_SHA256_ALLOWLIST` | 无 | 必填；逗号分隔的 Facade API Key 小写 SHA-256 |
| `BYOK_STORE_PATH` | `./data/byok-credentials.json` | 加密 file store 路径；相对路径按服务工作目录解析 |
| `HOST` | `127.0.0.1` | 监听地址；容器端口映射时设置为 `0.0.0.0` |
| `PIPPIT_BASE_URL` | `https://xyq.jianying.com` | 文档中的小云雀 API origin，可按部署环境覆盖 |
| `PIPPIT_REQUEST_TIMEOUT_MS` | `43200000` | 上传、提交、查询超时（12 小时） |
| `CONTENT_STREAM_IDLE_TIMEOUT_MS` | `43200000` | 生成结果流连续无数据的最大等待时间（12 小时） |
| `REFERENCE_FETCH_TIMEOUT_MS` | `43200000` | 单个参考素材下载超时（12 小时） |
| `REFERENCE_MAX_IMAGE_BYTES` | `31457280` | 单张图片最大 30 MiB |
| `REFERENCE_MAX_VIDEO_BYTES` | `209715200` | 单个视频最大 200 MiB |
| `REFERENCE_MAX_AUDIO_BYTES` | `15728640` | 单个音频与单请求音频合计最大 15 MiB |
| `REFERENCE_MAX_TOTAL_BYTES` | `314572800` | 单请求参考素材合计最大 300 MiB |
| `REFERENCE_MAX_REDIRECTS` | `3` | 参考 URL 最大重定向次数 |
| `REFERENCE_UPLOAD_CONCURRENCY` | `1` | 单请求素材上传并发数 |
| `REFERENCE_GLOBAL_CONCURRENCY` | `1` | 整个进程同时执行的素材下载+上传工作数 |
| `ALLOW_PRIVATE_REFERENCE_URLS` | `false` | 是否允许私网参考 URL |
| `PUBLIC_BASE_URL` | 空 | 设置后返回绝对 `polling_url` / `unsigned_urls` |
| `PIPPIT_BRIDGE_HOME` | 平台用户数据目录 | 本地自动 runtime 的高级/测试覆盖；不要指向 plugin cache 或项目目录 |
| `PIPPIT_LOCAL_RUNTIME_AUTO_START` | `true` | 设为 `false` 时禁止本地自动 runtime，要求显式外部 Facade |
| `PIPPIT_FACADE_BASE_URL` | 本地自动解析 | 外部模式的 facade origin；必须与 API key 成对设置 |
| `PIPPIT_FACADE_API_KEY` | 本地自动生成 | 外部模式的原始 Facade API Key，不是 digest 或 Pippit AK |
| `PIPPIT_FACADE_MANAGEMENT_API_KEY` | 本地自动生成 / 外部空 | stdio MCP / Codex 的 AK 管理 key；ChatGPT App 明确丢弃 |
| `PIPPIT_FACADE_TIMEOUT_MS` | `43200000` | wrapper 调用 facade 的超时（12 小时） |
| `PIPPIT_MCP_OUTPUT_ROOT` | macOS `~/Movies/Pippit`；其他平台 `~/Videos/Pippit` | stdio MCP / Codex 的 completed MP4 与额外下载文件 root；可覆盖 |
| `PIPPIT_MCP_ENROLLMENT_PORT` | `0` | stdio MCP / Codex 的 loopback AK 设置页端口；`0` 表示随机空闲端口 |
| `PIPPIT_MCP_ENROLLMENT_TTL_MS` | `300000` | stdio MCP / Codex 的单次 AK 设置链接有效期，最大 15 分钟 |
| `CHATGPT_APP_HOST` / `CHATGPT_APP_PORT` | `127.0.0.1` / `8787` | ChatGPT App Streamable HTTP 监听地址；当前 `noauth` 封装只允许 loopback |
| `CHATGPT_APP_PUBLIC_BASE_URL` | 空 | 用于签名媒体预览的公开 HTTPS origin；必须与签名 key 同时设置 |
| `CHATGPT_APP_MEDIA_SIGNING_KEY_HEX` | 空 | 独立 32-byte 签名 key；必须与 public base URL 同时设置 |
| `CHATGPT_APP_MEDIA_TTL_SECONDS` | `300` | 签名预览 URL 有效期，允许 `30`–`900` 秒 |

Codex/MCP 的 completed 结果会先把完整 MP4 原子保存为 `PIPPIT_MCP_OUTPUT_ROOT` 下的普通本地文件，再返回 widget。默认目录在 macOS 是 `~/Movies/Pippit`，其他平台是 `~/Videos/Pippit`；不会写入 `/tmp`、仓库或 plugin cache。widget 通过标准 MCP Apps `resources/read` 分块读取这份本地文件并创建沙箱内 `blob:` 播放地址，不会把远程签名地址、`file://` 路径或普通 HTTP loopback 地址交给播放器。stdio 重启后仍可按稳定 artifact identity 重新读取，MP4 继续保留。`pippit_download_video` 只用于创建另一个用户指定文件名或路径的副本。

生成、参考素材准备、重新生成、结果查询与落盘链路的内部默认超时统一为 12 小时。Codex plugin 还在 `.mcp.json` 中把 MCP tool timeout 设置为 12 小时；其他 MCP/ChatGPT 宿主若另有更短的外层调用期限，仍需在宿主侧同步配置。生成任务本身保持异步：工具尽快返回 pending job，widget 自动轮询。点击 `Regenerate video` 后，widget 会立即显示 loading，并请求从全屏编辑视图回到 inline 对话视图；宿主不支持该显示模式时会留在当前视图继续展示 loading。

## 验证

```bash
npm run check
```

默认测试使用内存 BYOK store 和注入的 Pippit fake，覆盖管理/运行时认证隔离、加密持久化、credential 选择与轮换、素材上传先于生成、图片/视频/音频映射、状态映射、job token 隔离、内容代理、超时、大小限制与私网 URL 拒绝。真实 Pippit AK 的上游验收需要单独执行，可能产生生成费用，不会混入默认测试。

## 协议依据

- [OpenRouter BYOK overview](https://openrouter.ai/docs/guides/overview/auth/byok)
- [OpenRouter Management API Keys](https://openrouter.ai/docs/guides/overview/auth/management-api-keys)
- OpenRouter BYOK CRUD：[create](https://openrouter.ai/docs/api/api-reference/byok/create-byok-key)、[list](https://openrouter.ai/docs/api/api-reference/byok/list-byok-keys)、[get](https://openrouter.ai/docs/api/api-reference/byok/get-byok-key)、[update](https://openrouter.ai/docs/api/api-reference/byok/update-byok-key)、[delete](https://openrouter.ai/docs/api/api-reference/byok/delete-byok-key)
- [OpenRouter Video Generation](https://openrouter.ai/docs/guides/overview/multimodal/video-generation)
- [OpenRouter Video API Reference](https://openrouter.ai/docs/api/api-reference/video-generation/create-videos)
- [OpenAI Apps SDK: Build your MCP server](https://developers.openai.com/apps-sdk/build/mcp-server)
- [OpenAI Apps SDK: Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)
- [OpenAI Apps SDK: Authentication](https://developers.openai.com/apps-sdk/build/auth)
- [OpenAI: Build plugins](https://developers.openai.com/codex/build-plugins)
- [小云雀（Pippit）](https://xyq.jianying.com/)

更细的边界和状态映射见 [docs/architecture.md](./docs/architecture.md)。

## License

[MIT](./LICENSE) © 2026 superche
