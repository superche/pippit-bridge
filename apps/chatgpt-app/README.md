# Pippit ChatGPT App

This package exposes the shared Pippit MCP runtime as a remote, stateless MCP server with an inline MCP App widget.

The repository includes the approved 256px black-and-white app icon at [`assets/pippit-video.png`](./assets/pippit-video.png). Its indexed PNG is kept below the ChatGPT developer console's 10 KB upload limit. Upload this file as the app icon there; `.app.json` only binds the registered app ID and does not declare visual branding.

## Endpoints

- `POST /mcp` — stateless Streamable HTTP MCP endpoint.
- `GET /health` — process health and preview-enabled state.
- `GET /media?token=...` — optional short-lived signed video proxy. Other methods are rejected.

The widget receives only signed preview URLs in tool-result `_meta`; the facade API key and facade content URLs stay server-side. The proxy forwards a single incoming `Range` request to the facade and reflects its validated `200`/`206` media headers. Preview responses include CORS, cross-origin resource policy, and content-type hardening so the sandboxed MCP App player can load them without falling back to a host `file://` URL.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `CHATGPT_APP_HOST` | `127.0.0.1` | HTTP listener; the current `noauth` build accepts loopback only |
| `CHATGPT_APP_PORT` | `8787` | HTTP listen port |
| `PIPPIT_FACADE_BASE_URL` | auto-resolved locally | Server-side facade URL; required with an explicit external key |
| `PIPPIT_FACADE_API_KEY` | auto-generated locally | Server-side facade bearer key; never sent to the widget |
| `PIPPIT_FACADE_TIMEOUT_MS` | `43200000` | Facade request timeout (12 hours) |
| `CHATGPT_APP_PUBLIC_BASE_URL` | unset | Public HTTPS origin used for signed previews |
| `CHATGPT_APP_MEDIA_SIGNING_KEY_HEX` | auto-generated in local mode | Independent 32-byte HMAC key encoded as 64 hex characters |
| `CHATGPT_APP_MEDIA_TTL_SECONDS` | `300` | Preview token lifetime, from 30 to 900 seconds |

With no `PIPPIT_FACADE_*` settings, startup automatically resolves the shared user-level local Facade used by the MCP and Codex wrappers. Its state and generated secrets live outside the plugin/package directory. Set `PIPPIT_LOCAL_RUNTIME_AUTO_START=false` to require explicit external Facade configuration instead. Supplying only part of an external configuration fails closed: an external `PIPPIT_FACADE_API_KEY` and `PIPPIT_FACADE_BASE_URL` must be configured together.

In local mode, setting `CHATGPT_APP_PUBLIC_BASE_URL` automatically reuses the local runtime's independent media-signing key. With an external Facade, `CHATGPT_APP_PUBLIC_BASE_URL` and `CHATGPT_APP_MEDIA_SIGNING_KEY_HEX` must be set together. The public value must be an origin without a path; HTTP is accepted only for loopback development. Generate an independent external signing key with `openssl rand -hex 32`.

Run from the repository root after installing workspace dependencies:

```sh
npm run build -w @pippit-bridge/mcp-server
npm run dev -w @pippit-bridge/chatgpt-app
```

Register the public `https://YOUR_HOST/mcp` endpoint in the ChatGPT developer console. Copy `.app.json.example` to `.app.json` only after replacing `plugin_asdk_app_REAL_ID` with the real app id; the example intentionally creates no active binding.

## Tool contract

The App projects exactly four tools from the shared MCP capability layer: list models, generate video, get video, and `pippit_edit_video_segment`. It does not duplicate the MCP runtime and does not expose its local-download or AK-management tools. Generate exposes ChatGPT top-level file parameters `first_frame`, `last_frame`, `images`, `videos`, and `audios`, marked through `_meta["openai/fileParams"]`. A file object contains required `file_id` and `download_url`, plus optional `mime_type` and `file_name`. URL-only alternatives are available as `first_frame_url`, `last_frame_url`, `image_urls`, `video_urls`, and `audio_urls`.

Every generate request requires `idempotency_key`. It deduplicates retries only within the lifetime of the running MCP server process; it is not a durable cross-restart guarantee.

Generation, reference preparation, regeneration, result lookup, and local materialization use a 12-hour internal timeout. A ChatGPT deployment, connector, tunnel, or reverse proxy can still impose a shorter outer deadline and must be configured separately when long synchronous preparation is expected.

Generation can incur Pippit charges. Files and URLs supplied to the generate tool are uploaded to and processed by Pippit under the configured account.

For a completed result, the widget supports reference-guided regeneration modeled after the supplied “片段重拍” interaction: choose a guidance range of at most 30 seconds, seek and drag a rectangle over intrinsic video content, insert timestamped regional instructions, optionally add an overall instruction, then submit through the stable `pippit_edit_video_segment` tool. The facade uses the complete current result as the only video reference and compiles the range and annotations into the generation prompt. Tool arguments contain only source job/index and structured guidance metadata; signed preview URLs and local absolute paths are never copied into `structuredContent` or the request.

When regeneration is submitted, the widget immediately switches to loading and requests the host's `inline` display mode. A host that accepts the standard MCP Apps display-mode request returns the user to the conversation while the same widget continues polling; otherwise loading remains visible in the current container.

The current upstream contract has no hard-trim or pixel-mask field. The complete source video remains a reference and segment/rectangle values are submitted as deterministic edit guidance. The widget therefore does not claim that unselected bytes are omitted or that an exact mask is enforced.

## Security boundary

The current tool declarations intentionally use MCP `noauth` for loopback/single-developer use. `noauth` means anyone who can reach this server can spend the configured facade credential. Do not expose this configuration as a shared production service.

Even when the underlying MCP package is configured with a facade Management API Key, this `noauth` projection never registers add/list/switch/delete AK tools. Raw Pippit AK must not enter ChatGPT conversations, normal tool arguments, widget state, or preview metadata.

The `/mcp` route rejects unexpected Host and Origin headers to reduce loopback DNS-rebinding risk. The current `noauth` build refuses wildcard and non-loopback listeners even when a public HTTPS origin is configured; use a trusted tunnel that forwards to the loopback listener. Requests without an Origin header remain valid for server-to-server MCP clients reaching that loopback/tunnel boundary.

A production multi-user ChatGPT App requires OAuth 2.1 authorization and per-user policy/credential isolation in front of `/mcp` and `/media`. OAuth is intentionally not implemented by this package.
