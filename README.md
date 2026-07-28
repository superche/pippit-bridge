# Pippit Bridge

<p align="center">
  <img src="./assets/brand/pippit-bird.png" width="180" alt="Pippit Bridge 飞鸟 Logo" />
</p>

<p align="center">
  <strong>让 Codex、OpenCode、MCP 与 ChatGPT 安全调用小云雀的图片和视频生成能力。</strong>
  <br />
  本地优先 · 多账号 BYOK · 参考素材 · 结果预览与落盘
</p>

<p align="center">
  <a href="#快速安装">快速安装</a> ·
  <a href="#选择接入方式">选择接入方式</a> ·
  <a href="#首次使用">首次使用</a> ·
  <a href="#文档导航">文档导航</a>
</p>

Pippit Bridge 是小云雀（Pippit）的开源 API gateway 与 adapter monorepo。它把图片和视频生成、参考素材上传、任务查询、结果下载与账号管理封装成 agent 可以安全调用的工具，同时提供 OpenRouter 风格的 facade 和 TypeScript SDK。

## 功能亮点

- **图片与视频生成**：支持文生图、参考图生图、文生视频，以及图片、视频、音频参考素材。
- **视频工作流**：支持首尾帧、异步任务查询、结果预览与参考视频片段重拍。
- **安全的多账号 BYOK**：通过一次性 loopback 页面录入和切换 Pippit AK，原始密钥不进入聊天或项目配置。
- **本地优先**：Codex、stdio MCP 与 OpenCode 默认在受信主机上运行，生成结果持久化到用户目录。
- **多种接入面**：同一套能力可用于 Codex、OpenCode、通用 MCP、ChatGPT App 和 OpenRouter 风格 API。

> [!IMPORTANT]
> Pippit Bridge 当前聚焦图片与视频生成。音频可作为视频参考素材，但尚未提供通用文本、语音生成或转录工具。

## 快速安装

运行 Codex plugin 或完整 monorepo 需要 Node.js 22.22.2+、24.15.0+ 或 26+，并确保 `npm` / `npx` 可用。

### Codex（推荐）

从公开 GitHub marketplace 安装，无需克隆本仓库：

```bash
codex plugin marketplace add superche/pippit-bridge --ref main --json
codex plugin add pippit-video@pippit-bridge --json
codex plugin list --json
```

安装完成后重启 ChatGPT Desktop 或新建 Codex session。

### OpenCode

从公开 npm registry 全局安装：

```bash
opencode plugin @pippit-bridge/opencode-plugin --global
```

也可以写入全局或项目级 `opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@pippit-bridge/opencode-plugin"]
}
```

## 选择接入方式

| 接入方式 | 适合场景 | 入口 |
| --- | --- | --- |
| **Codex plugin** | 在 Codex CLI 或 ChatGPT Desktop 中直接生成和预览素材 | `pippit-video@pippit-bridge` |
| **OpenCode plugin** | 在 OpenCode 中使用图片、视频和账号工具 | `@pippit-bridge/opencode-plugin` |
| **通用 MCP** | 其他支持 stdio MCP 的本地 agent/client | `@pippit-bridge/mcp-server` |
| **ChatGPT App** | ChatGPT developer mode 或 HTTPS 部署 | `@pippit-bridge/chatgpt-app` |
| **OpenRouter facade** | HTTP API、服务器持久化 BYOK 或自定义 adapter | `apps/openrouter-facade` |

完整配置和部署边界见 [MCP、ChatGPT App 与 Codex plugin 接入指南](./docs/integrations.md)。

## 首次使用

1. 在[小云雀官网](https://xyq.jianying.com/)签发并复制 Pippit AK。
2. Codex/stdio MCP 调用 `pippit_add_access_key`；OpenCode 调用 `pippit_manage_access_keys` 的 `configure` 操作。
3. 在工具返回的短时本地页面中粘贴 AK。不要把 AK 发送到聊天、普通工具参数、URL query 或项目配置。
4. 直接用自然语言请求 agent，例如“用这张参考图生成一张 16:9 海报”或“生成一段 10 秒的视频”。

主要能力：

| 能力 | 工具 |
| --- | --- |
| 模型发现 | `pippit_list_image_models`、`pippit_list_video_models` |
| 图片生成 | `pippit_generate_image` |
| 视频生成与查询 | `pippit_generate_video`、`pippit_get_video` |
| 视频片段重拍 | `pippit_edit_video_segment` |
| 本地视频副本 | `pippit_download_video` |
| Codex/MCP 账号管理 | `pippit_add_access_key`、`pippit_list_access_keys`、`pippit_switch_access_key`、`pippit_delete_access_key` |

Codex/MCP 完成的图片和视频默认保存到 macOS `~/Movies/Pippit` 或其他平台 `~/Videos/Pippit`，随后通过结果卡预览。更多工具、文件上传和 ChatGPT App 差异见[接入指南](./docs/integrations.md)。

## 项目架构

这是面向**单个本地用户、单台受信主机**的 plugin bridge，不是多租户 SaaS。多用户 OAuth、租户隔离、横向扩容和跨机器状态同步不属于当前目标。

```text
Codex / MCP / ChatGPT
  -> authenticated OpenRouter-style Facade
  -> encrypted BYOK store
  -> Pippit SDK
  -> Pippit upstream

OpenCode
  -> Core + Pippit SDK
  -> Pippit upstream
```

```text
pippit-bridge
├── apps
│   ├── openrouter-facade
│   └── chatgpt-app
├── packages
│   ├── contracts
│   ├── core
│   ├── sdk
│   ├── mcp-server-pippit
│   └── opencode-plugin-pippit
├── .agents/plugins/marketplace.json
└── docs
```

`contracts` 是公共 schema 真源，`core` 提供模型目录与安全文件原语，`sdk` 封装小云雀上游 API。完整依赖方向、Widget、运行时和发布边界见[架构文档](./docs/architecture.md)。

## 本地开发

```bash
npm ci
npm run dev                 # OpenRouter facade
npm run dev:mcp             # stdio MCP
npm run dev:chatgpt-app     # http://127.0.0.1:8787/mcp
```

Facade 默认监听 `http://127.0.0.1:3000`。配置项以 [.env.example](./.env.example) 为准，HTTP 合同以 [OpenAPI golden](./apps/openrouter-facade/contracts/openapi.golden.json) 为准。

连接显式外部 Facade 时，下面两个变量必须成对设置：

```bash
export PIPPIT_FACADE_BASE_URL=http://127.0.0.1:3000
export PIPPIT_FACADE_API_KEY='<facade-api-key>'
```

Codex plugin 开发使用独立 profile：

```bash
npm run codex:dev:profile:setup
npm run codex:dev
npm run codex:dev:app
npm run codex:dev:full-gate
```

运行完整检查：

```bash
npm run check
```

正式发布、hot/cold contract 和回滚流程见 [Codex Plugin 开发与发布工程](./docs/codex-plugin-dev-release-engineering.md)。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [集成指南](./docs/integrations.md) | stdio MCP、ChatGPT App、Codex plugin、工具和配置 |
| [架构设计](./docs/architecture.md) | 模块边界、依赖方向、Widget 与运行时 |
| [OpenCode plugin](./packages/opencode-plugin-pippit/README.md) | 安装、账号录入和生成流程 |
| [MCP server](./packages/mcp-server-pippit/README.md) | 本地与外部 Facade 模式 |
| [ChatGPT App](./apps/chatgpt-app/README.md) | Endpoint、配置和安全边界 |
| [持久化幂等](./docs/idempotency.md) | 视频任务异常恢复合同 |
| [AK 安全录入](./docs/opencode-ak-binding.md) | OpenCode 账号存储与安全约束 |
| [开发与发布工程](./docs/codex-plugin-dev-release-engineering.md) | Dev profile、contract gate、release 与 rollback |

## 支持项目

如果 Pippit Bridge 对你的创作或开发有所帮助，欢迎请我喝杯咖啡。你的支持会用于持续维护适配器、改进生成体验和完善文档。

<p align="center">
  <img src="./assets/buy-me-a-coffee.jpg" width="360" alt="Pippit Bridge 赞赏码：Buy Me a Coffee" />
</p>

## License

[MIT](./LICENSE) © 2026 superche
