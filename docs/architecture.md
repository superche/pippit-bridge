# Architecture and contract boundaries

## Monorepo dependency direction

```text
packages/core
  |-- stable video model catalog
  `-- public-network and media-signature primitives

packages/sdk
  `-- Pippit upload / submit / query client

apps/openrouter-facade ------------------+
  |-- auth, BYOK, job token, HTTP routes |
  `--------------------------------------+- depends on core + sdk

packages/mcp-server-pippit --------------+
  |-- facade-only client                 |
  |-- shared account + video MCP tools   |
  |-- one-time loopback AK enrollment    |
  |-- stdio transport + local MP4 server |
  `-- embedded Codex plugin metadata     |
                                         +- depends on facade HTTP contract
apps/chatgpt-app ------------------------+
  |-- Streamable HTTP /mcp               |
  |-- safe MCP capability projection     |
  |-- Apps SDK segment-edit widget       |
  `-- short-lived signed media proxy     |

packages/opencode-provider-pippit -------+
  |-- OpenCode AuthHook
  |-- global multi-account AK keyring
  |-- pippit_manage_access_keys
  |-- pippit_generate_video
  `-- pippit_get_video
```

`core` and `sdk` do not depend on an adapter. The MCP request/tool layer consumes only the facade HTTP contract. For zero-config local distribution, the MCP package additionally ships a build-time single-file bundle of the facade daemon; stdio still talks to it over the same authenticated HTTP contract rather than importing business handlers. The ChatGPT App reuses the MCP tool implementation but owns its HTTP transport, widget, and preview proxy. The Codex plugin is distribution metadata embedded in the MCP package, not another protocol implementation. This keeps the stable model ids and upstream request types reusable when CLI, ComfyUI, n8n, or OpenMontage packages are added.

The root scripts intentionally start the facade from the repository root. This preserves the existing meaning of `.env` and relative `BYOK_STORE_PATH=./data/byok-credentials.json` after the workspace move.

## MCP, ChatGPT App, and Codex distribution boundary

The three wrappers expose one current media capability family: asynchronous video generation and structured segment-edit jobs. Image, video, and audio URLs may be video-generation references, but no wrapper advertises text generation, image generation, speech, or transcription. The generic MCP/Codex surfaces additionally expose facade account administration; the current ChatGPT `noauth` projection deliberately does not.

```text
generic MCP client                  Codex plugin
  | stdio                             | embedded .mcp.json -> stdio
  +-------------------+---------------+
                      v
          shared MCP account + video tools
                      | lazy local resolver or complete external config
                      v
       user-level loopback Facade daemon --------> encrypted BYOK store
       or explicitly deployed external Facade
                      |
                      | completed full download
                      v
       Movies/Videos/Pippit/*.mp4 <----- stdio/plugin loopback media server

ChatGPT
  | HTTPS Streamable HTTP POST /mcp
  v
ChatGPT App transport + MCP App result/editor widget
  | safe projection of shared MCP video tools
  | same local resolver / external Facade boundary
  +-------------------------------------> Facade
  `-- GET /media?token=... -------------> protected facade content route
```

`@pippit-bridge/mcp-server` owns the canonical definitions, validation and handlers for account list/add/switch/delete, model discovery, generation, structured segment editing, job polling, automatic completed-file materialization, and local download. Completed Codex/stdio results are atomically published under `PIPPIT_MCP_OUTPUT_ROOT`; the download tool realpath-confines an optional caller-supplied additional relative path under the same root and never overwrites an existing file. The ChatGPT App projects exact canonical video tool names and adds file parameters, UI metadata and signed previews; it deliberately omits the local-filesystem and all Management-Key-backed tools.

Raw Pippit AK is not a normal MCP tool argument. `pippit_add_access_key` creates a bounded, high-entropy, one-time loopback enrollment URL. Its password form POSTs directly to the MCP process, which uses the distinct Management key only on `/api/v1/byok/**`. Runtime Facade API Key and Management API Key are never substituted for one another. The MCP process does not persist another copy of the AK.

Local installation is deliberately lazy. Codex plugin installation and MCP `initialize` / `tools/list` do not execute the daemon or create secret material. The first actual tool call obtains a private bootstrap lock, creates one stable set of independent internal keys, starts the bundled Facade on port `0`, verifies an HMAC-signed ready descriptor plus a challenge proof, and then sends the Facade bearer key. Concurrent clients converge on the same process. An authenticated daemon with an older runtime version is stopped and replaced under that lock after an upgrade. Partial external configuration fails closed instead of borrowing local values.

Local runtime state lives in a platform user-data directory (macOS `~/Library/Application Support/Pippit Bridge`), with directories `0700` and state files `0600`. Ordinary completed videos instead default to `~/Movies/Pippit` on macOS or `~/Videos/Pippit` elsewhere. Both are outside the plugin cache and checkout, so upgrade/uninstall does not rotate encryption/job keys, delete accounts, or remove completed MP4 files. If encrypted BYOK state exists without its matching secret file, bootstrap refuses to generate replacements. Bootstrap recognizes and removes only the exact same-inode private candidate hard link left by a dead lock owner; unfamiliar hard links fail closed. A crashed local daemon's store lock is removed only after the signed descriptor owner and lock PID are no longer alive; arbitrary live or malformed locks are not removed.

The encrypted facade BYOK state stores active credential selections keyed by the runtime Facade API Key SHA-256. This makes the selection consistent across stdio MCP, Codex and the ChatGPT App when they intentionally share one runtime identity. MCP account list/delete also carry that hash only on the server-to-server management hop; the facade filters list results and performs scoped delete checks atomically, while the unscoped Management API retains administrator-wide behavior. An explicit `provider.options.pippit.byok_id` still wins. Without an explicit id, an active selection is fail-closed: a missing, disabled or ineligible selected credential is not silently replaced by another account. Existing signed job ids remain bound to the credential/key version used at submission.

The Codex plugin root is `packages/mcp-server-pippit`. Its `.codex-plugin/plugin.json`, `.mcp.json`, `plugin-entry.mjs`, skills, assets, stdio runtime, and bundled local Facade are installed as one self-contained unit. The shim prefers compiled `dist/stdio.js` in an npm package and falls back to `src/stdio.ts` in an unbuilt repo checkout; a packaged install neither resolves monorepo siblings nor runs `npm install` on first start. The repo marketplace at `.agents/plugins/marketplace.json` points to that package; no second copy of the MCP implementation is maintained. Codex has no trusted arbitrary postinstall/secret-injection surface here, so automatic setup occurs on first capability use.

The local ChatGPT App resolves the same user-level Facade and internal media-signing key at server startup, but explicitly removes the Management key before building its configuration. It registers only `/mcp`, a versioned result/editor widget resource, and the four safe video tools. Its current `noauth` declaration is a developer-mode boundary for local or controlled-tunnel use. A public, multi-user deployment still requires a reachable HTTPS service, a separately registered real App ID, OAuth 2.1 MCP resource-server validation, scopes, per-user mapping, remote persistence, and a secret manager; local plugin installation cannot create those production identity surfaces.

The edit contract carries `source_job_id`, output index, a segment no longer than 30 seconds, timestamped intrinsic-video normalized rectangles, and global/local instructions. The facade resolves the source through the signed job boundary and submits a new asynchronous `pippit_video_part_agent` job. The currently documented upstream protocol has no hard-trim or pixel-mask field, so the complete source result is uploaded and the segment/ROI data is compiled into deterministic provider instructions. The UI must not claim that unselected bytes were omitted or that a pixel-exact mask was enforced.

An Apps SDK registration creates a real identifier beginning with `plugin_asdk_app`. The repository therefore keeps only `apps/chatgpt-app/.app.json.example`. Until a real ID exists, the Codex plugin manifest must not claim an `apps` component. After registration, a real `packages/mcp-server-pippit/.app.json` may be created and the manifest may point `apps` at it; placeholder IDs are not a distributable integration.

## OpenCode direct-provider boundary

OpenCode currently loads model providers as AI SDK `LanguageModelV3`. Pippit's asynchronous video endpoint does not implement that contract. The OpenCode adapter therefore uses documented plugin surfaces instead of advertising a fake language model:

```text
OpenCode /connect
  -> plugin auth.provider = pippit
  -> OpenCode hidden password prompt
  -> plugin global keyring (multiple named accounts + active pointer)

agent
  -> pippit_manage_access_keys
  -> configure: official website link + top-of-page issuance instructions
  -> list / switch / delete (never returns or accepts a raw AK)

agent
  -> pippit_generate_video (permission ask)
  -> SDK upload_file / submit_run
  -> pippit_get_video / query_generate_video_result
  -> checked download inside current worktree
```

Direct mode does not use the facade's Management API Key, Facade API Key, BYOK store, or signed job id. OpenCode 1.18.3 exposes one credential slot per provider, so `/connect` remains the secret-input/import channel while the plugin owns a global, non-project keyring for multiple named accounts. The keyring uses a `0700` directory, a `0600` atomically replaced plaintext file, masked public summaries, and an explicit active pointer. It shares OpenCode `auth.json`'s same-UID plaintext threat boundary; it is not the encrypted server BYOK store.

Each managed-account submission persists upstream `thread_id + run_id` with the `account_id` used at submission. A later switch or environment override only changes new work; a saved binding wins when polling. If binding persistence fails after a successful upstream submission, the tool returns the run instead of turning it into a retryable failure, marks `account_binding_persisted: false`, and returns the explicit `account_id` recovery selector. Polling fails closed if its bound account was deleted instead of silently crossing account scope. Local inputs are realpath-confined to the worktree; remote inputs and generated outputs use the shared public-network checks.

Pippit AK binding has two states: the always-available OpenCode masked API prompt, and an RFC 8628 device flow that is only exposed when official same-origin website endpoints are configured. See [opencode-ak-binding.md](./opencode-ak-binding.md).

## Control plane and runtime flow

```text
Deployment administrator
  | Authorization: Bearer <Management API Key>
  | POST/PATCH/GET/DELETE /api/v1/byok
  v
BYOK management plane
  |-- accepts officially issued Pippit AK
  |-- never returns the raw AK
  v
single-instance encrypted file store
  |-- AES-256-GCM envelope
  |-- exclusive .lock
  |-- credential + retained key versions

OpenRouter-style client
  | Authorization: Bearer <Facade API Key>
  | POST /api/v1/videos
  v
Facade authentication and BYOK routing
  |-- Facade API Key -> SHA-256 allowlist
  |-- model/workspace/API-key constraints -> credential version
  |-- model id -> exact Pippit model
  |-- reference URL -> bytes
  |-- bytes -> upload_file -> data.pippit_asset_id
  v
Pippit submit_run (using decrypted Pippit AK)
  |-- returns run_id
  |-- returns thread_id
  v
signed facade job id
  | GET /api/v1/videos/{jobId}
  v
same credential key version -> Pippit query_generate_video_result
  |-- run_state -> OpenRouter status
  |-- video_urls -> facade content endpoints
  v
GET /api/v1/videos/{jobId}/content?index=N
  -> stream selected Pippit result URL
```

All image, video, and audio references cross an explicit two-step boundary: the facade first calls `POST /api/biz/v1/skill/upload_file`, reads `data.pippit_asset_id`, and only then places those asset ids into `POST /api/biz/v1/skill/submit_run`. A source URL, downloaded byte stream, and `pippit_asset_id` are distinct handles.

## Authentication matrix

| Credential | Stored representation | Accepted surface | Explicitly not accepted for |
| --- | --- | --- | --- |
| Management API Key | One SHA-256 digest in deployment config | `/api/v1/byok` CRUD only | Models, video create/poll/content |
| Facade API Key | SHA-256 allowlist in deployment config | Models, video create/poll/content | `/api/v1/byok` management |
| Wrapper copy of Facade API Key | Raw runtime secret in `PIPPIT_FACADE_API_KEY` | MCP/ChatGPT App/Codex server-to-facade requests | Pippit upstream auth, widget state, tool results, URLs |
| Pippit AK | Encrypted at rest in the BYOK store | Server-to-Pippit upstream calls | Any facade `Authorization` header |
| BYOK encryption key | Raw 32-byte deployment secret | Decrypt/encrypt BYOK store | Job signing |
| Job signing key | Different raw 32-byte deployment secret | Job-token HMAC and API-key binding | BYOK encryption |
| ChatGPT media signing key | Independent raw 32-byte app secret | Short-lived app preview tokens | Facade auth, Pippit upstream auth, BYOK/job signing |
| Codex/stdio preview capability key | Process-random, memory only | Current plugin-lifecycle local MP4 URLs | Persistence, Facade auth, ChatGPT previews |

The raw Management and Facade API Keys are generated and distributed outside this service; only their SHA-256 digests are configured. Startup rejects a Management digest that also appears in the Facade allowlist, so one raw key cannot be configured for both audiences.

Authorization headers and BYOK request bodies are logger-redacted. BYOK responses expose a masked `label`, never the raw Pippit AK, encrypted payload, or key-version secret.

## OpenRouter-compatible BYOK surface and facade extensions

The management resource follows OpenRouter's current BYOK route family:

```text
POST   /api/v1/byok
GET    /api/v1/byok
GET    /api/v1/byok/{id}
PATCH  /api/v1/byok/{id}
DELETE /api/v1/byok/{id}
```

Every route requires the Management API Key and returns `Cache-Control: no-store`. The following request fields are deliberate facade extensions rather than claims about OpenRouter's official provider contract:

- `provider: "pippit"`: extends the facade's provider set with Pippit.
- writable `allowed_api_key_hashes`: narrows a credential to the listed lowercase SHA-256 hashes of Facade API Keys.
- `provider.options.pippit.byok_id`: pins a video request to one credential.
- `provider.options.pippit.thread_id`: continues a Pippit thread under the selected credential.

This v1 file store is a single-workspace implementation. Its workspace is `00000000-0000-0000-0000-000000000000`; callers should omit `workspace_id` or send that value. Another workspace id is rejected instead of being silently collapsed into the default workspace.

The current facade authenticates static API keys and does not resolve a per-user identity. Consequently, `allowed_user_ids: null` is the usable runtime setting; any non-null `allowed_user_ids` list currently matches no video request. The field is retained for contract compatibility and future identity-aware routing, but must not be interpreted as implemented user routing.

Pippit AKs must be issued through the official Pippit web surface. This provider neither imports a Pippit Cookie nor manages official AK issuance. It only accepts an already-issued AK and stores it through its own Management-Key-protected BYOK API.

## Credential selection, fallback, and rotation

For a video create request, the store filters credentials by these rules:

1. The credential is enabled and belongs to the store's workspace.
2. `provider` is `pippit`.
3. `allowed_models` is `null` or contains the resolved stable facade model id.
4. `allowed_api_key_hashes` is `null` or contains the current Facade API Key's SHA-256.
5. `allowed_user_ids` is `null`; the current runtime has no caller user id to match against a list.
6. If `provider.options.pippit.byok_id` is present, only that credential is eligible.

Main credentials are ordered before `is_fallback: true` credentials; within each group, `sort_order` controls selection. Fallback occurs only after an explicit Pippit HTTP `401`, `403`, or `429`. It does not occur after a network error, timeout, cancellation, or ambiguous `submit_run` outcome, because retrying could create a duplicate upstream run.

Reference assets are scoped to the selected Pippit AK. If the facade safely advances to another credential, it reloads and reuploads every reference with that credential, obtains a new set of `data.pippit_asset_id` values, and only then calls `submit_run` again.

PATCHing `key` appends a key version and makes it active for new jobs. The signed job token pins the exact credential id and key-version id, so an existing job continues to poll with the version used at submission. The file store retains up to its configured version limit. Deleting a credential removes all versions; a later poll for a job pinned to it fails closed rather than using a different AK.

## Identifiers are not interchangeable

| Handle | Owner | Purpose |
| --- | --- | --- |
| Input URL | Facade caller | Locate source bytes |
| `data.pippit_asset_id` | Pippit upload API | Reference an uploaded input in `submit_run` |
| BYOK credential id | This service | Select credential metadata and its active key version |
| BYOK key-version id | This service | Pin the exact encrypted Pippit AK used by one job |
| `thread_id` | Pippit | Conversation/session handle required for result queries |
| `run_id` | Pippit | Generation task handle required for result queries |
| facade `jobId` | This service | Signed poll handle containing exact credential/thread/run bindings |
| `generation_id` | OpenRouter-style response | Exposes the upstream `run_id`; it is not the facade job id |
| output URL | Pippit query API | Temporary generated-media source proxied by content route |

The v2 job token is HMAC-signed with `JOB_SIGNING_KEY_HEX` and includes workspace, credential id, key-version id, `thread_id`, `run_id`, model, creation time, and a binding derived from the Facade API Key. Another Facade API Key cannot use it. It is restart-safe only while the signing key and referenced credential version remain available. The token is not a cancellation handle; the documented Pippit API exposes no cancel operation.

## Encrypted file-store boundary

The built-in `FileByokStore` is intentionally scoped to a single process and a single local POSIX filesystem. It is not a multi-writer database, does not support NFS/shared filesystems, and must not back multiple provider replicas.

- The parent directory must be a real directory, owned by the service user, with mode `0700` or stricter. The encrypted store and lock file use `0600`.
- Startup creates `${BYOK_STORE_PATH}.lock` with exclusive-create semantics and holds its file handle until shutdown. A second process fails to start. After a crash, an operator may remove a stale lock only after confirming that no provider process is using the store.
- The entire logical state is serialized into an AES-256-GCM envelope. The envelope authenticates the format/version/key id/AAD context and ciphertext.
- Persistence uses a new `0600` temporary file, file `fsync`, atomic rename, and parent-directory `fsync`. A directory-sync failure after rename is treated as durability-uncertain and the store fails closed.
- `BYOK_ENCRYPTION_KEY_HEX` and `JOB_SIGNING_KEY_HEX` must be independent. Losing the encryption key makes the store unreadable; losing or changing the signing key invalidates outstanding job tokens.

AES-GCM authenticates one snapshot but provides no monotonic counter outside that snapshot. Restoring an older, valid encrypted file can therefore roll back rotations, deletes, disables, and ordering without detection. External backups and snapshots must provide access control, version/freshness policy, and recovery testing. A backup containing the ciphertext remains sensitive for as long as its encryption key can be obtained.

Logical update/delete rewrites the current store, but does not guarantee physical erasure from APFS/filesystem snapshots, backup media, SSD over-provisioning, or wear-leveled flash cells. Immediate credential revocation must be enforced at the authoritative Pippit AK management surface. The facade does not claim forensic deletion.

In the supplied container image, `/app/data` is the persistent store directory. It must be mounted to a single-writer volume. All keys and digests are deployment secrets and must be injected at runtime rather than baked into the image.

## State mapping

| Pippit `run_state` | OpenRouter status |
| --- | --- |
| `0` | `failed` |
| `1` | `pending` |
| `2`, `7` | `in_progress` |
| `3` | `completed` |
| `4` | `failed` |
| `5` | `cancelled` |
| `6`, `8`, `9` | `failed` |
| unknown/forward-compatible | `failed` |

`expired` exists in the OpenRouter status enum but the referenced Pippit API does not publish an equivalent state. Unknown states fail closed instead of leaving clients polling forever. A Pippit `completed` response without any `video_urls` is treated as an invalid upstream response (`502`), not as a downloadable completed job.

## Reference and output network boundary

The facade accepts HTTP(S) references only. Every source URL and redirect is checked against private/special address ranges, and the validated DNS answer is pinned to the production socket lookup. File signatures, declared media type, extension, per-kind limits, aggregate limits, request concurrency, and process-wide concurrency are enforced before `submit_run`.

Generated output URLs are not returned as direct download targets. The content route resolves and streams them through the same public-network checks, forwards byte ranges, and only reflects video media types. Private-reference access is an explicit opt-in for trusted deployments.

Facade content URLs remain Bearer-protected when consumed through an integration. For Codex/stdio MCP, every completed result is fully materialized first as a regular MP4 in the configured output root using an opaque SHA-256 identity, a private partial file, `fsync`, and an atomic no-overwrite publish. Only then does the widget receive a stable `pippit-video://artifact/<sha256>` resource identity. The sandboxed widget asks the host to proxy bounded `resources/read` chunks, validates and assembles them into a `blob:` URL, and revokes that URL when the source changes or the widget closes. The artifact identity and ordinary local MP4 survive stdio process restarts; no upstream URL, local filesystem path, or loopback HTTP endpoint is assigned to the player. `pippit_download_video` creates only an optional additional user-named copy.

The ChatGPT widget cannot attach or receive `PIPPIT_FACADE_API_KEY`, so the ChatGPT App replaces its preview targets with short-lived signed URLs on its own media proxy. The proxy validates the token and expiry, then attaches the Facade API Key only on the server-to-server hop. Neither the raw key nor any other credential is placed in widget HTML, ChatGPT tool results, preview URLs, or the token payload.

The default bind address is `127.0.0.1`. Authentication is mandatory regardless of bind address: the Management API Key digest and at least one Facade API Key digest are required at startup. Generated content has separate response-header and body-idle timeouts so a stalled origin cannot occupy a stream indefinitely.

## Unsupported OpenRouter controls

- `callback_url`: Pippit documentation specifies polling and no facade callback delivery contract is implemented.
- `generate_audio`: Pippit may generate or use audio, but the documented immersive-video request has no equivalent boolean control.

Both are rejected rather than silently ignored. `seed` is forwarded because the upstream immersive-video request contract includes it.

## Validation boundary

Default tests use injected HTTP/Pippit fakes and an in-memory BYOK store. They prove the facade mapping, credential routing, authentication separation, and lifecycle without claiming real generation. File-store tests prove serialization/encryption, permissions, locking, rotation retention, and tamper rejection on the local test filesystem; they do not prove the behavior of every network filesystem or physical storage device.

A live Pippit proof requires an unmasked, officially issued AK with video permission plus reachable reference assets and may incur generation cost; it is intentionally a separate acceptance step.

## External contract references

- [OpenRouter BYOK overview](https://openrouter.ai/docs/guides/overview/auth/byok)
- [OpenRouter Management API Keys](https://openrouter.ai/docs/guides/overview/auth/management-api-keys)
- OpenRouter BYOK CRUD: [create](https://openrouter.ai/docs/api/api-reference/byok/create-byok-key), [list](https://openrouter.ai/docs/api/api-reference/byok/list-byok-keys), [get](https://openrouter.ai/docs/api/api-reference/byok/get-byok-key), [update](https://openrouter.ai/docs/api/api-reference/byok/update-byok-key), [delete](https://openrouter.ai/docs/api/api-reference/byok/delete-byok-key)
- [OpenAI Apps SDK: Build your MCP server](https://developers.openai.com/apps-sdk/build/mcp-server)
- [OpenAI Apps SDK: Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)
- [OpenAI Apps SDK: Authentication](https://developers.openai.com/apps-sdk/build/auth)
- [OpenAI: Build plugins](https://developers.openai.com/codex/build-plugins)
- [Pippit](https://xyq.jianying.com/)
