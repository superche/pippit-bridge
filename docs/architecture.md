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

packages/opencode-provider-pippit -------+
  |-- OpenCode AuthHook
  |-- global multi-account AK keyring
  |-- pippit_manage_access_keys
  |-- pippit_generate_video
  `-- pippit_get_video
```

`core` and `sdk` do not depend on an adapter. An adapter never imports another adapter. This keeps the stable model ids and upstream request types reusable when CLI, MCP, ChatGPT App, Codex, ComfyUI, n8n, or OpenMontage packages are added.

The root scripts intentionally start the facade from the repository root. This preserves the existing meaning of `.env` and relative `BYOK_STORE_PATH=./data/byok-credentials.json` after the workspace move.

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
| Pippit AK | Encrypted at rest in the BYOK store | Server-to-Pippit upstream calls | Any facade `Authorization` header |
| BYOK encryption key | Raw 32-byte deployment secret | Decrypt/encrypt BYOK store | Job signing |
| Job signing key | Different raw 32-byte deployment secret | Job-token HMAC and API-key binding | BYOK encryption |

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
- [Pippit](https://xyq.jianying.com/)
