# MCP、ChatGPT App 与 Codex plugin

本项目以通用 MCP package 作为能力真源，再提供三种集成形式：stdio MCP、投影安全子集并增加 widget 的 ChatGPT App，以及直接启动同一 stdio server 的 Codex plugin。

**这些集成面按单用户、本机优先架构设计。** Codex plugin 和 OpenCode plugin 是主要产品入口；stdio MCP、loopback Facade 与 ChatGPT developer-mode App 默认服务于同一用户和同一台受信主机。当前项目不把公共多用户托管、租户隔离、分布式状态或横向扩容作为交付目标。

## 共同前置与能力边界

三种 wrapper 都不直连 Pippit 上游，而是复用同一个 OpenRouter-style facade 能力层：

```text
MCP client / Codex / ChatGPT
  -> wrapper 持有内部或显式外部 Facade API Key
  -> OpenRouter-style facade
  -> encrypted BYOK store 中的 Pippit AK
  -> Pippit 上游视频 API
```

本地默认模式不要求先启动 facade 或配置内部 key。Codex plugin / stdio MCP 的安装、`initialize` 和 `tools/list` 都是无副作用的；第一次 `tools/call` 才在平台用户数据目录中幂等生成内部 key、启动一个随机端口的 loopback Facade，并由后续 MCP/Codex/本地 ChatGPT App 复用。状态不写入 plugin cache 或项目目录，普通 plugin uninstall 也不删除它。

若部署方要连接独立的外部 Facade，下面两项必须成对配置：

```bash
export PIPPIT_FACADE_BASE_URL=http://127.0.0.1:3000
export PIPPIT_FACADE_API_KEY='<facade-api-key>'
```

只配置其中一项会 fail closed，不会回退或拼接本地配置。不要在这两个变量、MCP client 配置或 plugin 配置中写 Pippit AK。无论本地还是外部模式，Pippit AK 都只从短时 loopback enrollment password POST 进入加密 BYOK store；生成、查询、编辑和 Widget 都看不到它。

当前工具集只有视频能力：

| 工具 | 作用 | 可用形式 |
| --- | --- | --- |
| `pippit_list_video_models` | 读取 facade 的视频模型与能力目录 | stdio MCP、ChatGPT App、Codex plugin |
| `pippit_generate_video` | 异步提交视频任务；可选 `idempotency_key` 仅用于异常恢复；支持 facade 的 URL 参考素材、首尾帧、`byok_id` 与 `thread_id` | stdio MCP、ChatGPT App、Codex plugin |
| `pippit_edit_video_segment` | 将已完成结果作为唯一视频参考，把最多 30 秒的选段、时间点和归一化矩形标注编译为提示词，重新生成一个异步视频任务 | stdio MCP、ChatGPT App、Codex plugin |
| `pippit_get_video` | 根据 facade `job_id` 轮询任务 | stdio MCP、ChatGPT App、Codex plugin |
| `pippit_download_video` | 为已自动落盘的完成结果创建一个自定义相对路径副本；不覆盖已有文件 | stdio MCP、Codex plugin |
| `pippit_list_access_keys` | 返回 facade BYOK 账号的 ID、名称、脱敏 AK 与 active 状态 | stdio MCP、Codex plugin |
| `pippit_add_access_key` | 创建短时 loopback enrollment URL；raw AK 不进入 tool arguments | stdio MCP、Codex plugin |
| `pippit_switch_access_key` | 切换同一 Facade API Key identity 的新任务 active 账号 | stdio MCP、Codex plugin |
| `pippit_delete_access_key` | 显式确认后删除 facade 加密 store 中的账号 | stdio MCP、Codex plugin |

参考图片/视频/音频只是视频生成的输入。本包没有宣告文本模型、图片生成、语音生成或转录工具。

`idempotency_key` 是 MCP/OpenCode plugin 的可选异常恢复字段，不属于 Facade/OpenRouter API。缺省时每次调用均独立提交；显式提供时，MCP 或 OpenCode 才在自己的私有账本中合并同 key 同请求、检测冲突并跨重启恢复。`submitting` 后的未知结果只能执行 fail-closed at-most-once retry policy，不能宣称 provider-level exactly-once。详见 [持久化幂等](./idempotency.md)。

## 1. 通用 stdio MCP package

package 名为 `@pippit-bridge/mcp-server`，源码入口是 `packages/mcp-server-pippit/src/stdio.ts`。它是标准 stdio MCP server：协议输出只写 stdout，日志只写 stderr。

从本 checkout 直接启动：

```bash
npm run dev:mcp
```

package 发布到 npm registry 后，同一个入口会以 `pippit-mcp` bin 提供：

```bash
npm install --global @pippit-bridge/mcp-server
pippit-mcp
```

对于需要 JSON server map 的 MCP client，默认只需声明可执行入口，不需要 env：

```json
{
  "mcpServers": {
    "pippit-video": {
      "command": "pippit-mcp"
    }
  }
}
```

本地模式的 output root 默认是 macOS `~/Movies/Pippit`、其他平台 `~/Videos/Pippit`。外部模式可设置 `PIPPIT_FACADE_BASE_URL`、`PIPPIT_FACADE_API_KEY`、可选的独立 `PIPPIT_FACADE_MANAGEMENT_API_KEY` 和 `PIPPIT_MCP_OUTPUT_ROOT`；这些 secret 应放在用户级 secret 配置中，不要提交到项目。下载工具只接受 root 下的相对 `output_path`，拒绝路径越界和覆盖。

Codex/MCP widget 在 completed 后会先把完整 MP4 原子写成 output root 下的普通本地文件，然后返回稳定的本地 artifact resource identity。widget 通过宿主代理的标准 `resources/read` 读取最多 1 MiB 的分块、校验总长度后创建沙箱内 `blob:` URL；换源、失败或 teardown 会撤销该 URL。artifact identity 不依赖 stdio 端口或进程随机密钥，因此 stdio 重启后仍可恢复同一文件。完整 MP4 不会进入 `/tmp`、项目目录或版本化 plugin cache；需要自定文件名或额外路径时再调用 `pippit_download_video`。

### AK 新增、切换与删除

自动本地模式会生成彼此独立的 runtime 与 Management key，因此默认发布四个 AK 管理工具。外部模式的 `PIPPIT_FACADE_MANAGEMENT_API_KEY` 必须与 `PIPPIT_FACADE_API_KEY` 分离；没有配置时只发布五个视频/runtime 工具。

安全新增流程：

1. 调用 `pippit_add_access_key({ account_name: "..." })`。普通 MCP 参数里没有 `access_key` 字段。
2. 打开结果中的短时 `http://127.0.0.1:...` setup URL，在 password 输入框中粘贴 Pippit AK。
3. 页面把 AK 直接 POST 给同一 MCP 进程；进程使用 Management API Key 写入 facade 的加密 store，并把新 credential 设为当前 Facade API Key identity 的 active。
4. 调用 `pippit_list_access_keys`，只核对账号 ID、名称、masked label 与 active 状态。

setup token 高熵、短时、单次消费，响应使用 `Cache-Control: no-store` 与严格 CSP。不要把 AK 粘贴进聊天、tool 参数、URL query、项目配置或日志。loopback setup 只适用于 MCP server 与用户浏览器在同一台受信主机的模式；远程部署应提供独立、经过 OAuth/管理员认证的 enrollment surface。

`pippit_switch_access_key` 的选择按 Facade API Key SHA-256 持久化在 facade 的加密 store。显式 `byok_id` 优先；否则新任务使用 active。已有 `job_id` 已绑定原 credential 与 key version，不受后续切换影响。当前 caller 还有其他可切换账号时，必须先 switch 才能删除 active；本地/facade 删除不代表在 Pippit 官网撤销，若要立即失效仍需去权威 AK 管理面撤销。

MCP 的 list/delete 会把 runtime Facade API Key 的 SHA-256 只在 server-to-server management 请求中作为 caller scope；facade 在服务端过滤并原子校验删除权限。其他 Facade API Key 专属的账号不会出现在列表中，猜测其 credential ID 删除也只返回 404。未携带 caller scope 的原始 `/api/v1/byok` Management API 仍保留部署管理员的全局语义。

### 参考视频重新生成

`pippit_edit_video_segment` 保留稳定工具名，但实际提交一次新的生成：它只接受已完成的 `source_job_id`，并复用 facade 的 job token 权限边界。完整源视频成为唯一 video reference；最多 30 秒的 `segment`、范围内的 `at_ms`、相对 intrinsic video content 的 `0..1` 矩形、局部 `instruction` 与整体 `prompt` 被编译为生成提示词。返回值是标准异步 video job，继续用 `pippit_get_video` 轮询。

当前小云雀接口没有单独暴露 hard trim 或 pixel-mask 字段。facade 会完整取得源结果，并把选段/区域编译成确定性的 provider instructions 再提交 `pippit_video_part_agent`。因此应称为“参考视频重新生成”，不能声称是原地修改、未选片段的字节没有上传，或存在像素级 mask 约束。

## 2. ChatGPT App

ChatGPT App package 名为 `@pippit-bridge/chatgpt-app`。它通过 `POST /mcp` 提供 Streamable HTTP MCP，并注册 MCP App 视频结果 widget。默认监听 `127.0.0.1:8787`。

`pippit_generate_video` 在 ChatGPT 形式中同时接受 URL 和 ChatGPT 上传文件：`first_frame` / `last_frame`、`images`、`videos`、`audios` 被声明为 file parameters，app server 只把其下载 URL 映射为 facade 的视频参考素材。这仍然不是图片、音频或通用文本生成能力。

### 本地启动

```bash
npm run dev:chatgpt-app

curl http://127.0.0.1:8787/health
```

上述最小本地启动自动复用用户级 Facade，但没有公开 origin，因此不生成 widget 媒体预览。要让 ChatGPT 连接并预览，使用 OpenAI Secure MCP Tunnel 或受信任的 HTTPS tunnel，然后设置公网 origin：

```bash
export CHATGPT_APP_PUBLIC_BASE_URL=https://example-tunnel.invalid
npm run dev:chatgpt-app
```

本地自动模式会从共享私有状态取得独立 media signing key。显式外部 Facade 模式必须把 `CHATGPT_APP_MEDIA_SIGNING_KEY_HEX` 与 public URL 成对设置。ChatGPT 中注册的 URL 必须是完整 `/mcp` endpoint，例如 `https://example-tunnel.invalid/mcp`。

### ChatGPT developer-mode 注册

1. 在 ChatGPT 打开 **Settings → Apps & Connectors → Advanced settings**，开启 **Developer mode**。如果 workspace 管理员禁用了 developer mode，需要先由管理员允许。
2. 回到 app settings，选择创建 developer-mode app。
3. 填写用户可见的 Name/Description，将 MCP server URL 设为 tunnel 的 `https://.../mcp`，并上传仓库中的 `apps/chatgpt-app/assets/pippit-video.png` 作为 App 图标。
4. 创建成功后核对四个 ChatGPT 工具：`pippit_list_video_models`、`pippit_generate_video`、`pippit_edit_video_segment`、`pippit_get_video`。ChatGPT App 不提供本地文件下载或 AK 管理工具。
5. 修改工具描述或 widget 后，回到该 developer-mode app 点击 **Refresh** 重新读取 server metadata。

### 认证与媒体预览边界

当前 ChatGPT transport 宣告 `noauth`，只用于本地、单用户或受控 tunnel 的 developer-mode 调试。这不等于可将 endpoint 无认证公开给多用户。生产多用户部署必须按 MCP authorization spec 实现 OAuth 2.1，校验每个 access token 的签名、issuer、audience/resource、过期时间和 scope，并将用户身份映射到正确的 facade 权限。本项目当前未实现这个生产 OAuth 层。

`/mcp` 会校验 Host 与可选 Origin，以降低 loopback DNS-rebinding 风险。当前 `noauth` 版本只允许 `CHATGPT_APP_HOST` 监听 loopback；即使配置了公网 HTTPS origin，也会拒绝 `0.0.0.0`、`::` 和其他非 loopback 地址。developer-mode 调试应由受信任的 HTTPS tunnel 转发到本地 loopback listener。ChatGPT 的 server-to-server 请求通常不带 Origin，仍可在这条 loopback/tunnel 边界上正常使用。

facade 返回的 content URL 仍需要 `Authorization: Bearer <PIPPIT_FACADE_API_KEY>`。widget 不会拿到该 key，也不会直连 facade content URL。ChatGPT App server 会把预览改写为短时有效的 `GET /media?token=...` 签名代理 URL；代理在 server 端校验签名与过期时间，再使用 facade key 获取媒体。

因此以下内容都不得包含 Facade API Key 或 Pippit AK：

- MCP `structuredContent` 和文本结果。
- widget HTML、`window.openai` state 与组件 URL。
- 签名 media token 的 payload。
- 日志、错误信息和 ChatGPT 对话内容。

`CHATGPT_APP_MEDIA_SIGNING_KEY_HEX` 应是独立的 32-byte 随机密钥，不要与 facade 的 `JOB_SIGNING_KEY_HEX` 或 `BYOK_ENCRYPTION_KEY_HEX` 复用。`CHATGPT_APP_MEDIA_TTL_SECONDS` 只控制 app 预览 URL 的有效期，不会把 facade content route 变成公开 URL。

media token 只绑定 `job_id`、结果 index 和过期时间，不包含 Facade API Key。但它在过期前仍是 bearer capability，不应写入日志或发送给 widget/ChatGPT 以外的接收方。

结果完成后，Widget 可在 intrinsic video content 上选择最多 30 秒的提示范围，在当前帧拖拽矩形、输入局部注释并形成时间戳 chip，再填写整体指令。点击 Regenerate video 后只调用共享的 `pippit_edit_video_segment`；当前完整视频由 facade 解析为唯一参考，Widget 参数只有 source job/index 与结构化 guidance metadata，不包含 preview URL、本地绝对路径、Facade API Key 或 Pippit AK。Widget 为相同 source 与 guidance 生成稳定的 SHA-256 幂等键。服务端在提交成功后持久记录 source job 到新 job 的私有 lineage；widget 重建时先调用 app-only `pippit_resolve_latest_video`，再通过 canonical `pippit_get_video` 加载最新后代。因此显示模式切换、旧 bootstrap 结果回放或 stdio 重启都不会把已成功的 regenerate 结果退回上一个视频。`window.openai.widgetState` 只作为兼容缓存，不是权威状态。所有生成相关调用保留 12 小时上限。不支持标准调用时才 capability-detect `window.openai.callTool`。

当前 `noauth` App 即使运行在 loopback/tunnel，也不会注册 `pippit_*_access_key` 工具。否则任何能访问 endpoint 的调用方都能借用服务端 Management API Key 修改全局凭证。未来只有在 OAuth 2.1、scope 与 per-user credential isolation 全部完成后，才应把脱敏 list/switch/delete 投影到 ChatGPT；raw AK enrollment 仍应走独立安全页面。

### `.app.json` 必须使用真实 app ID

developer-mode app 创建后，ChatGPT 页面 URL 中会出现真实 `plugin_asdk_app...` ID。仓库只提供 `apps/chatgpt-app/.app.json.example`，不伪造、不提交一个看似可用的 `.app.json`。

example 使用官方 app mapping 结构，不在 manifest 里重复填 MCP URL：

```json
{
  "apps": {
    "pippit-video": {
      "id": "plugin_asdk_app_REAL_ID"
    }
  }
}
```

仅当 app 已真实注册、且需要把它绑定到 Codex plugin 时：

1. 复制 example 为 `packages/mcp-server-pippit/.app.json`。
2. 用真实 `plugin_asdk_app...` ID 替换 example 占位符。
3. 在 `packages/mcp-server-pippit/.codex-plugin/plugin.json` 中新增 `"apps": "./.app.json"`。
4. 重新扫描/安装 plugin 并验证 ID 指向刚创建的 app。

在此之前，plugin manifest 不应声明 `apps` 字段。developer-mode app 本身可通过 ChatGPT 注册界面独立调试，不需要伪 ID。

## 3. Codex plugin

Codex plugin 名为 `pippit-video`，所属 marketplace 为 `pippit-bridge`。plugin root 就是 `packages/mcp-server-pippit`：

```text
packages/mcp-server-pippit
├── .codex-plugin/plugin.json
├── .mcp.json
├── plugin-entry.mjs
├── skills/
├── assets/
└── src/stdio.ts
```

公开 marketplace 位于 GitHub 仓库 `superche/pippit-bridge` 的 `.agents/plugins/marketplace.json`。Codex 自行克隆这个公开 marketplace 快照，并从快照内的相对目录安装 manifest、skill、assets 与启动 shim；这里的 `local` source 只表示“相对已下载的 marketplace 根目录”，不是用户机器上的仓库路径。用户不需要预先 clone 或 build 本仓库：

- Codex CLI：添加公开 GitHub marketplace，再安装 `plugin@marketplace`：

```bash
codex plugin marketplace add superche/pippit-bridge --ref main --json
codex plugin add pippit-video@pippit-bridge --json
codex plugin list --json
```

- ChatGPT Desktop：先在终端执行同样的 marketplace add / plugin add 命令，重启 app 后在 **Plugins** 或 `/plugins` 中确认 **Pippit Video** 已启用，再新建 Codex session。

`.mcp.json` 通过公开快照内的 `plugin-entry.mjs` 启动。npm tarball 安装中它直接加载随包发布的 stdio server 与 Facade daemon；GitHub marketplace 安装中它通过 `npx --package @pippit-bridge/mcp-server@0.2.13 pippit-mcp` 获取同一份公开、固定版本运行包。因此用户需要 Node.js 22.22.2+/24.15.0+（含 npm/npx），但不需要 checkout、`npm install` 或 build 本仓库。安装和 MCP discovery 不生成 key，第一次实际工具调用才启动用户级共享 runtime。plugin 升级后，下一次实际调用会先认证已有 daemon 的 challenge proof 与 runtime version；旧版本 daemon 会在 bootstrap lock 内自动停止并替换，持久化 key 与账号不变。需要外部部署时，仍可从启动 Codex 的 secret 环境中显式提供完整 Facade 配置。

生成、查询和参考视频重新生成工具共享同一个 MCP App widget resource。widget 会自动轮询 pending/in-progress job；打开旧结果时先通过 model-hidden 的 `pippit_resolve_latest_video` 找到最新 regenerate job，宿主随后回放的旧 tool result 不能覆盖它。`pippit_get_video` 到达 `completed` 后，stdio/plugin 进程先把完整 MP4 原子保存为普通本地文件，再通过 MCP Apps `resources/read` 分块传给 widget 并创建 `blob:` 播放地址。Codex 不要求模型另行生成 `file://` 可视化；本地绝对路径、facade content URL、API key 与 `unsigned_urls` 不进入 Widget 或 model-visible 结果。stdin 重启不改变本地 artifact identity 或 regenerate lineage，文件继续保留；用户需要自定文件名或额外路径时再调用下载工具。

marketplace 本身从公开 GitHub 下载，运行时通过 npm registry 获取由 `prepack` 生成的自包含 `@pippit-bridge/mcp-server@0.2.13` tarball；不会在 plugin cache 中运行仓库 lifecycle scripts。仓库开发者若要测试未发布源码，仍应在 checkout 中先运行 `npm run build -w @pippit-bridge/mcp-server`，再使用单独的开发 marketplace 配置，不能把用户机器上的绝对 path 作为公开分发契约。

进入 Codex 后可用 `/plugins` 检查/enable plugin。安装或更新后开始一个新 session，再请求 `pippit-video` 列出模型、生成或查询视频；完成结果会自动保存本地 MP4 并展示 widget，只有需要额外自定义文件名或路径副本时才请求下载。

plugin 的 `.mcp.json` 只声明本地 stdio server，不内嵌 Pippit AK 或 Facade API Key。Codex 的 sandbox/工具批准策略仍在 host 侧生效；plugin 不会绕过这些边界。

`.mcp.json` 将 Codex 的 MCP tool timeout 设置为 `43200` 秒；Facade、MCP client、Widget 视频工具与 ChatGPT App 的内部生成链路默认均为 `43200000` 毫秒。其他 MCP/ChatGPT 宿主、connector 或反向代理如果有更短的外层 deadline，仍需单独配置。点击 widget 的 `Regenerate video` 后会先展示 loading，再通过 `ui/request-display-mode` 请求 `inline`，不额外发送会触发模型轮次的对话消息。

Codex plugin 安装是声明式复制/注册流程，没有受信任的任意 postinstall 或 secret 表单。因此“安装自动处理”实现为首次能力调用时的惰性 bootstrap，而不是安装时执行脚本。ChatGPT App 的 `.app.json` 也只能绑定已经注册的真实 app ID，不能在本地 plugin install 中自动部署或注册一个生产 App。

marketplace 的认证策略使用 `ON_USE`，与惰性 runtime 一致：安装/enable 不应为了本地内部 key 等待认证；真正需要用户提供的 Pippit AK 仍由首次账号新增时的 loopback 页面处理。

## 配置索引

| 变量 | 使用者 | 用途 |
| --- | --- | --- |
| `PIPPIT_BRIDGE_HOME` | 本地 MCP / ChatGPT App / Codex plugin | 用户数据目录高级/测试覆盖；默认按平台解析 |
| `PIPPIT_LOCAL_RUNTIME_AUTO_START` | 本地 MCP / ChatGPT App / Codex plugin | 默认启用；设为 `false` 时必须显式配置外部 Facade |
| `PIPPIT_FACADE_BASE_URL` | MCP / ChatGPT App / Codex plugin | 外部 facade origin；必须与 API key 成对设置 |
| `PIPPIT_FACADE_API_KEY` | MCP / ChatGPT App / Codex plugin | 外部 Facade Bearer key；本地模式自动生成 |
| `PIPPIT_FACADE_MANAGEMENT_API_KEY` | stdio MCP / Codex plugin | 外部 AK 管理 key；本地模式自动生成，ChatGPT App 显式丢弃 |
| `PIPPIT_FACADE_TIMEOUT_MS` | MCP / ChatGPT App / Codex plugin | wrapper 到 facade 的请求超时；默认 `43200000`（12 小时） |
| `PIPPIT_MCP_OUTPUT_ROOT` | stdio MCP / Codex plugin | completed MP4 自动落盘及 `pippit_download_video` 额外副本的 root |
| `PIPPIT_MCP_ENROLLMENT_PORT` | stdio MCP / Codex plugin | loopback AK 设置页监听端口；默认 `0`，即随机空闲端口 |
| `PIPPIT_MCP_ENROLLMENT_TTL_MS` | stdio MCP / Codex plugin | 单次 AK 设置链接有效期；默认 `300000`，最大 15 分钟 |
| `CHATGPT_APP_HOST` / `CHATGPT_APP_PORT` | ChatGPT App | HTTP 监听地址；默认 `127.0.0.1:8787` |
| `CHATGPT_APP_PUBLIC_BASE_URL` | ChatGPT App | tunnel/部署的公开 HTTPS origin，用于生成预览 URL |
| `CHATGPT_APP_MEDIA_SIGNING_KEY_HEX` | ChatGPT App | 短时预览 token 的独立签名密钥 |
| `CHATGPT_APP_MEDIA_TTL_SECONDS` | ChatGPT App | 签名预览 URL 有效期 |

## 官方格式依据

- [OpenAI Apps SDK: Build your MCP server](https://developers.openai.com/apps-sdk/build/mcp-server)
- [OpenAI Apps SDK: Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)
- [OpenAI Apps SDK: Authentication](https://developers.openai.com/apps-sdk/build/auth)
- [OpenAI: Build plugins](https://developers.openai.com/codex/build-plugins)
