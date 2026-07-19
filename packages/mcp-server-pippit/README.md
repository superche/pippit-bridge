# Pippit MCP server and Codex plugin

`@pippit-bridge/mcp-server` is the shared Pippit video capability layer for generic stdio MCP clients and the `pippit-video` Codex plugin. It provides model discovery, asynchronous video generation, structured segment editing, polling, confined downloads, and facade-backed account add/list/switch/delete.

## Local zero-configuration mode

Run `pippit-mcp` without `PIPPIT_FACADE_*` variables. MCP initialization and `tools/list` are side-effect free. The first actual tool call creates or reconnects to a user-level, loopback-only Facade runtime with private generated internal keys and an encrypted BYOK store. Multiple MCP/Codex processes share one runtime; state lives outside plugin caches and project directories and is preserved by a normal plugin uninstall.

After a package/plugin upgrade, the next actual tool call authenticates the shared daemon's proof and runtime version. An older authenticated daemon is stopped and replaced automatically while the persisted keys and BYOK accounts remain unchanged.

The raw Pippit AK is never an environment variable or ordinary MCP argument. `pippit_add_access_key` returns a short-lived, one-time `http://127.0.0.1:...` setup page. Enter the AK only in that page's password field.

`pippit_generate_video`, `pippit_get_video`, and `pippit_edit_video_segment` advertise one shared MCP App resource. After polling reaches `completed`, a supporting host such as Codex renders the inline preview and segment editor from the `pippit_get_video` result automatically. Before returning that result, the stdio/plugin process fully downloads and atomically publishes an ordinary MP4 under its output root. The widget then reads bounded base64 chunks through standard MCP Apps `resources/read`, reconstructs a sandbox-local `blob:` URL, and can recover the same stable artifact after stdio restart. Upstream content URLs, loopback media URLs, and `unsigned_urls` never reach the player or model-visible output. `pippit_download_video` is only needed for an additional user-chosen file name or destination.

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

The npm tarball includes compiled stdio code and a self-contained local Facade daemon. Codex's npm marketplace installer does not run package lifecycle scripts, so `prepack` builds these artifacts before publication. A clean installed tarball requires no package install, build step, or secret injection at first use.

The repo-local marketplace is for development. Run `npm run build -w @pippit-bridge/mcp-server` before installing it from a clean checkout. After publishing version `0.2.7`, use the npm marketplace shape in `.agents/plugins/marketplace.npm.example.json` for an end-user install.

See [the integration guide](../../docs/integrations.md) for ChatGPT App deployment, production OAuth boundaries, and the full tool matrix.
