# Pippit MCP server and Codex plugin

`@pippit-bridge/mcp-server` is the shared Pippit image/video capability layer for generic stdio MCP clients and the `pippit-video` Codex plugin. It provides Seedream image generation, asynchronous video generation, reference-guided regeneration, polling, confined video downloads, and facade-backed account add/list/switch/delete.

`pippit_generate_image` returns standard MCP image content and binds a dedicated MCP App result card. In Codex/stdio, every completed image is atomically persisted under the configured output root first. The card reads its stable opaque `pippit-image://artifact/...` resource through the local MCP bridge and offers `Download original`; it never depends on an expiring upstream URL or requires another paid generation.

This package is designed for one local user on a trusted host. Its shared loopback runtime and private file stores are not a multi-tenant service boundary and do not provide distributed coordination or cross-machine state.

## Local zero-configuration mode

Run `pippit-mcp` without `PIPPIT_FACADE_*` variables. MCP initialization and `tools/list` are side-effect free. The first actual tool call creates or reconnects to a user-level, loopback-only Facade runtime with private generated internal keys and an encrypted BYOK store. Multiple MCP/Codex processes share one runtime; state lives outside plugin caches and project directories and is preserved by a normal plugin uninstall.

After a package/plugin upgrade, the next actual tool call authenticates the shared daemon's proof and runtime version. An older authenticated daemon is stopped and replaced automatically while the persisted keys and BYOK accounts remain unchanged.

The raw Pippit AK is never an environment variable or ordinary MCP argument. `pippit_add_access_key` returns a short-lived, one-time `http://127.0.0.1:...` setup page. Enter the AK only in that page's password field.

`pippit_generate_video`, `pippit_get_video`, and `pippit_edit_video_segment` advertise one shared MCP App resource. After polling reaches `completed`, a supporting host such as Codex renders the inline preview and regeneration controls from the `pippit_get_video` result automatically. Successful regeneration also records a private source-to-child job lineage; the app-only `pippit_resolve_latest_video` tool follows that chain before an old widget result is restored, so the newest regenerated video remains selected across iframe or stdio restarts. Before returning a completed result, the stdio/plugin process fully downloads and atomically publishes an ordinary MP4 under its output root. The widget then reads bounded base64 chunks through standard MCP Apps `resources/read`, reconstructs a sandbox-local `blob:` URL, and can recover the same stable artifact after stdio restart. Absolute filesystem paths, upstream content URLs, loopback media URLs, and `unsigned_urls` never reach the widget. `pippit_download_video` is only needed for an additional user-chosen file name or destination.

In zero-configuration local mode the output root is `~/Movies/Pippit` on macOS and `~/Videos/Pippit` on other platforms. `PIPPIT_MCP_OUTPUT_ROOT` overrides it. `PIPPIT_BRIDGE_HOME` remains an advanced/test override and keeps outputs beneath that isolated root.

## Explicit external Facade mode

Set both variables together:

```bash
export PIPPIT_FACADE_BASE_URL=https://facade.example.test
export PIPPIT_FACADE_API_KEY='<facade-runtime-key>'
pippit-mcp
```

Set a distinct `PIPPIT_FACADE_MANAGEMENT_API_KEY` only if this external identity may manage accounts. Partial external configuration fails closed and never borrows generated local values.

## Distribution

The npm tarball includes compiled stdio code and a self-contained local Facade daemon. `prepack` builds these artifacts before publication. A clean installed tarball requires no build step or secret injection at first use.

The public GitHub marketplace at `superche/pippit-bridge` installs the plugin metadata, skill, assets, and launcher from the repository snapshot. Its relative local source is inside Codex's downloaded marketplace cache, not an end-user checkout. When the compiled bundle is absent from that Git snapshot, the launcher runs the pinned public `@pippit-bridge/mcp-server@0.2.13` package through `npx`. End users need Node.js/npm but do not clone, install dependencies for, or build this repository. A separate local development marketplace may still be used after running `npm run build -w @pippit-bridge/mcp-server`.

The plugin manifest configures Codex MCP tool calls for a 12-hour timeout. The same default applies to facade requests, reference preparation, generation/regeneration submission, result materialization, and widget video-tool calls. Generic MCP hosts may have their own shorter outer timeout and must opt into an equivalent limit separately.

`idempotency_key` is an optional MCP-level abnormal-recovery field. It is never sent to the Facade. Keyless calls are independent submissions; explicitly keyed calls use the MCP-owned private ledger under `PIPPIT_BRIDGE_HOME/idempotency`. See [the integration guide](../../docs/integrations.md) and [the durable idempotency contract](../../docs/idempotency.md).
