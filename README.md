# Pippit Bridge

<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="./assets/brand/pippit-bird.png" width="180" alt="Pippit Bridge bird logo" />
</p>

<p align="center">
  <strong>Bring Pippit image and video generation safely to Codex, OpenCode, MCP, and ChatGPT.</strong>
  <br />
  Local-first · Multi-account BYOK · Reference media · Preview and persistent outputs
</p>

<p align="center">
  <a href="#quick-install">Quick install</a> ·
  <a href="#choose-an-integration">Choose an integration</a> ·
  <a href="#first-use">First use</a> ·
  <a href="#documentation">Documentation</a>
</p>

Pippit Bridge is an open-source API gateway and adapter monorepo for Pippit (XiaoYunque). It turns image and video generation, reference uploads, job polling, downloads, and account management into agent-safe tools, while also providing an OpenRouter-style facade and a TypeScript SDK.

## Highlights

- **Image and video generation:** text-to-image, reference-image generation, text-to-video, and image, video, or audio references.
- **Video workflows:** first and last frames, asynchronous job polling, result previews, and native video segment regeneration.
- **Secure multi-account BYOK:** add and switch Pippit access keys through a one-time loopback page without exposing raw keys to chat or project configuration.
- **Local-first:** Codex, stdio MCP, and OpenCode run on a trusted host by default and persist generated results in a user directory.
- **Multiple integrations:** use the same capabilities through Codex, OpenCode, generic MCP, a ChatGPT App, or an OpenRouter-style API.

> [!IMPORTANT]
> Pippit Bridge currently focuses on image and video generation. Audio can be used as video reference material, but general text generation, speech generation, and transcription are not provided.

## Quick install

The Codex plugin and full monorepo require Node.js 22.22.2+, 24.15.0+, or 26+, with `npm` and `npx` available.

### Codex (recommended)

Install from the public GitHub marketplace without cloning this repository:

```bash
codex plugin marketplace add superche/pippit-bridge --ref main --json
codex plugin add pippit-video@pippit-bridge --json
codex plugin list --json
```

Restart ChatGPT Desktop or start a new Codex session after installation.

### OpenCode

Install the plugin globally from the public npm registry:

```bash
opencode plugin @pippit-bridge/opencode-plugin --global
```

Alternatively, add it to a global or project-level `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@pippit-bridge/opencode-plugin"]
}
```

## Choose an integration

| Integration | Best for | Entry point |
| --- | --- | --- |
| **Codex plugin** | Generating and previewing media in Codex CLI or ChatGPT Desktop | `pippit-video@pippit-bridge` |
| **OpenCode plugin** | Image, video, and account tools in OpenCode | `@pippit-bridge/opencode-plugin` |
| **Generic MCP** | Other local agents and clients that support stdio MCP | `@pippit-bridge/mcp-server` |
| **ChatGPT App** | ChatGPT developer mode or HTTPS deployments | `@pippit-bridge/chatgpt-app` |
| **OpenRouter facade** | HTTP APIs, server-persisted BYOK, or custom adapters | `apps/openrouter-facade` |

See the [MCP, ChatGPT App, and Codex plugin integration guide](./docs/integrations.md) for full configuration and deployment boundaries.

## First use

1. Create and copy a Pippit access key from the [official Pippit site](https://xyq.jianying.com/).
2. In Codex or stdio MCP, call `pippit_add_access_key`. In OpenCode, use the `configure` action of `pippit_manage_access_keys`.
3. Paste the key into the short-lived local page returned by the tool. Never send it through chat, ordinary tool arguments, URL queries, or project configuration.
4. Ask the agent naturally, for example: “Create a 16:9 poster from this reference image” or “Generate a 10-second video.”

Core capabilities:

| Capability | Tools |
| --- | --- |
| Model discovery | `pippit_list_image_models`, `pippit_list_video_models` |
| Image generation | `pippit_generate_image` |
| Video generation and polling | `pippit_generate_video`, `pippit_get_video` |
| Video segment regeneration | `pippit_edit_video_segment` |
| Additional local video copy | `pippit_download_video` |
| Codex/MCP account management | `pippit_add_access_key`, `pippit_list_access_keys`, `pippit_switch_access_key`, `pippit_delete_access_key` |

Completed Codex/MCP images and videos are saved to `~/Movies/Pippit` on macOS or `~/Videos/Pippit` on other platforms, then displayed in a result card. See the [integration guide](./docs/integrations.md) for more tools, file uploads, and ChatGPT App differences.

## Architecture

This is a plugin bridge for **one local user on one trusted host**, not a multi-tenant SaaS. Multi-user OAuth, tenant isolation, horizontal scaling, and cross-machine state synchronization are outside the current scope.

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

`contracts` is the source of truth for public schemas, `core` provides the model catalog and secure file primitives, and `sdk` wraps the upstream Pippit API. See the [architecture guide](./docs/architecture.md) for dependency direction, widgets, runtime behavior, and release boundaries.

## Local development

```bash
npm ci
npm run dev                 # OpenRouter facade
npm run dev:mcp             # stdio MCP
npm run dev:chatgpt-app     # http://127.0.0.1:8787/mcp
```

The facade listens on `http://127.0.0.1:3000` by default. [.env.example](./.env.example) is the configuration source of truth, and the [OpenAPI golden](./apps/openrouter-facade/contracts/openapi.golden.json) defines the HTTP contract.

When connecting to an explicit external facade, both variables must be set together:

```bash
export PIPPIT_FACADE_BASE_URL=http://127.0.0.1:3000
export PIPPIT_FACADE_API_KEY='<facade-api-key>'
```

Use an isolated profile for Codex plugin development:

```bash
npm run codex:dev:profile:setup
npm run codex:dev
npm run codex:dev:app
npm run codex:dev:full-gate
```

Run the complete local check:

```bash
npm run check
```

See [Codex Plugin development and release engineering](./docs/codex-plugin-dev-release-engineering.md) for release gates, hot/cold contracts, and rollback procedures.

## Documentation

| Document | Contents |
| --- | --- |
| [Integration guide](./docs/integrations.md) | stdio MCP, ChatGPT App, Codex plugin, tools, and configuration |
| [Architecture](./docs/architecture.md) | Module boundaries, dependency direction, widgets, and runtime |
| [OpenCode plugin](./packages/opencode-plugin-pippit/README.md) | Installation, account enrollment, and generation |
| [MCP server](./packages/mcp-server-pippit/README.md) | Local and external facade modes |
| [ChatGPT App](./apps/chatgpt-app/README.md) | Endpoints, configuration, and security boundaries |
| [Durable idempotency](./docs/idempotency.md) | Recovery contract for video jobs |
| [Secure key enrollment](./docs/opencode-ak-binding.md) | OpenCode account storage and security constraints |
| [Development and release engineering](./docs/codex-plugin-dev-release-engineering.md) | Dev profiles, contract gates, releases, and rollback |

## Support the project

If Pippit Bridge helps your creative or development workflow, consider buying me a coffee. Your support helps maintain the adapters, improve the generation experience, and keep the documentation current.

<p align="center">
  <img src="./assets/buy-me-a-coffee.jpg" width="360" alt="Buy Me a Coffee QR code for Pippit Bridge" />
</p>

## License

[MIT](./LICENSE) © 2026 superche
