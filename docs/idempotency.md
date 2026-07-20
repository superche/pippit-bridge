# Durable idempotency

> Status: implemented inside the Codex/MCP and OpenCode plugins. The Facade remains OpenRouter-compatible and does not accept or define `Idempotency-Key`. This is an optional abnormal-recovery mechanism, not a provider-level exactly-once guarantee.

## Scope and positioning

Pippit Bridge is a **single-user, local-first plugin bridge**. Its primary products are the Codex `pippit-video` plugin and `opencode-provider-pippit`; the loopback Facade and local ChatGPT developer app are supporting integration surfaces. This design therefore uses private user-level files and a single-writer process model. It does not introduce a database, distributed lock, multi-tenant namespace, OAuth identity, or cross-machine coordination.

Codex and generic stdio MCP submit through the Facade but own recovery state in the MCP module. OpenCode submits directly to Pippit and owns a separate ledger over the same record contract. Neither plugin changes the Facade/OpenRouter protocol merely to share recovery state.

## Goals

- Replaying the same explicit recovery key and normalized request after an MCP, Codex or OpenCode restart returns the original submitted job instead of creating another paid run.
- Reusing a key with a different operation or payload fails before upload or submission.
- A crash at an ambiguous upstream submission boundary fails closed instead of automatically creating a second paid run.
- Records do not persist prompts, reference URLs, local paths, raw API keys or Pippit AKs.
- Corrupt, unauthenticated or durability-uncertain state fails closed.

## Non-goals

- Exactly-once execution across a process crash while the upstream `submit_run` response is unknown. Pippit does not currently expose a provider-side idempotency key or a query-by-client-key API, so that guarantee cannot be constructed locally.
- Deduplication across users, machines, Facade API key identities or unrelated plugin installations.
- Adding an `Idempotency-Key` header or an idempotency request field to the Facade/OpenRouter protocol.
- Deduplicating ordinary calls that omit a recovery key. Two identical keyless calls are two intentional submissions.
- Retrying a changed prompt, model, account, reference set or edit payload under an old key.

## Contract

### Codex and MCP

`pippit_generate_video` and `pippit_edit_video_segment` accept an optional caller-chosen `idempotency_key` of 1 to 200 non-control characters. When omitted, every invocation performs a normal independent submission. When present, the MCP module scopes it by:

```text
(facade_api_key_hash, MCP operation, idempotency_key)
```

The key never crosses the Facade HTTP boundary. `operation` distinguishes `mcp_generate_video` and `mcp_edit_video`; the key itself is excluded from the normalized request fingerprint.

### OpenCode

The OpenCode tool accepts the same optional recovery field. A keyless call is submitted normally. Keyed recovery is scoped by:

```text
(OpenCode global state identity, operation, idempotency_key)
```

The selected `account_id` is part of the request fingerprint, not a separate fallback dimension. Reusing a key after switching accounts therefore conflicts instead of silently submitting under another AK.

## Fingerprint and persisted record

Before hashing, the adapter constructs the exact normalized request that would cross the paid submission boundary. Object keys use deterministic canonical JSON ordering; array order is preserved because reference and frame order can change semantics. The fingerprint is an HMAC-SHA-256 with a dedicated private `idempotency_hmac_key_hex`, not an unkeyed digest of user content. Scope hashes, key hashes, request fingerprints and whole-store integrity tags use separate domain prefixes under that key so one digest cannot be substituted for another.

The store keeps hashes and minimal recovery metadata only:

```ts
interface PersistentIdempotencyRecordV1 {
  version: 1
  scope_hash: string
  key_hash: string
  operation: "mcp_generate_video" | "mcp_edit_video" | "pippit_generate_video"
  request_fingerprint: string
  phase: "preparing" | "submitting" | "submitted" | "failed" | "indeterminate"
  owner_instance_id: string
  created_at: string
  updated_at: string
  expires_at: string
  response?: {
    job_id: string
    generation_id?: string | null
    polling_url: string
    status: string
  }
  failure_code?: string
}
```

The record must not contain the raw idempotency key, prompt, annotations, reference URLs, local paths, Facade API Key, Management API Key, Pippit AK or encryption/signing keys. A signed Facade job id may be stored because it is already bound to the Facade caller identity and the file is private user state.

## State machine

| Phase | Meaning | Same key and fingerprint | Restart behavior |
| --- | --- | --- | --- |
| `preparing` | Plugin validation is running; no Facade/Pippit submission has started | Join the live in-memory promise | A stale record may restart because no paid submission crossed the boundary |
| `submitting` | The record was durably synced and the Facade or direct Pippit submission call has started | Join the live promise | Convert to `indeterminate`; never auto-submit again |
| `submitted` | The upstream run and Facade job response were durably recorded | Replay the original response | Replay the original response without contacting Pippit |
| `failed` | A definitive pre-submit or provider rejection was recorded | Replay the stable error | Do not silently reinterpret the same key as a new request |
| `indeterminate` | Submission may have succeeded but no recoverable run id is known | Return a recovery-required error | Require a new explicit user decision and a new key before another paid attempt |

Any same-key request with a different fingerprint returns a plugin conflict error before a new submission. A live keyed duplicate in the same MCP process shares the existing promise for low latency. Keyless calls never enter this cache.

Age alone never makes a record stale. Recovery may take over `preparing` only after the recorded owner process or authenticated local-runtime instance is proven dead. A live, malformed or unverifiable owner record fails closed.

### Submission ordering

1. Parse the plugin tool request. If no recovery key is present, submit normally without entering this state machine.
2. Canonicalize the paid request and look up the scoped recovery key.
3. Create and durably sync a `preparing` record.
4. Atomically change the record to `submitting` and `fsync` it **before** the MCP module calls the Facade, or before OpenCode calls Pippit `submit_run`.
5. On a successful response, atomically persist `submitted` plus the replayable job response.
6. If a failure is proven definitive, persist a stable `failed` result.
7. If step 4 has begun and success versus failure is ambiguous, persist `indeterminate` and fail closed.

There remains a narrow crash window after the Facade or Pippit accepts the run but before `submitted` is synced. The `submitting` record deliberately converts that uncertainty into a visible recovery error rather than a duplicate paid run. Provider-side idempotency or query-by-client-key support would be required to close this window automatically.

## Storage

### Codex and stdio MCP

The local runtime stores records under:

```text
<PIPPIT_BRIDGE_HOME>/idempotency/mcp-v1.json
<PIPPIT_BRIDGE_HOME>/idempotency/secret-v1.json
```

The directory is `0700`; the state, secret and lock files are `0600`. Persistence follows the existing local-state discipline: bounded schema, maximum file size and record count, `O_NOFOLLOW`, exclusive single-writer lock, temporary file, file `fsync`, atomic rename and parent-directory `fsync`. The whole canonical state envelope carries a domain-separated HMAC integrity tag.

The MCP runtime owns this user-level state even when it calls an externally configured Facade. It automatically creates an independent HMAC key. The Facade never reads these files and has no `IDEMPOTENCY_*` deployment variables.

### OpenCode direct provider

OpenCode stores the same logical records in a separate file:

```text
<OpenCode state>/pippit/idempotency-v1.json
<OpenCode state>/pippit/idempotency-secret-v1.json
```

The secret file contains the independently generated `idempotency_hmac_key_hex` and uses the same `0600`, no-follow and atomic-create rules. If records exist but the secret is missing, OpenCode fails closed instead of generating a replacement. The record store reuses the account store's private-directory, lock, atomic-replace and durability rules, but not the account file itself. Account deletion does not delete submitted idempotency records; otherwise an old key could be reused and cross account scope after a switch.

## Retention and cleanup

- Default retention is 30 days for terminal `submitted`, `failed` and `indeterminate` records.
- Live `preparing` and `submitting` records are not removed by ordinary age-based cleanup.
- Cleanup runs under the same store lock and only after the new state has been durably persisted.
- The initial limit is 1,000 records and 8 MiB per store. When the limit is reached, expired terminal records are removed first; if no safe record is removable, new paid submissions fail closed.
- Clearing records is an explicit maintenance action and must identify the exact key scope or terminal records being removed. It is not coupled to plugin uninstall.

## Error and replay behavior

| Condition | Result |
| --- | --- |
| Same key, same fingerprint, `submitted` | Original recorded job response; no new upload or submission |
| Same recovery key, different fingerprint | Plugin conflict error; no new submission |
| Stale `submitting` record | Plugin `indeterminate` recovery error |
| Corrupt or unauthenticated store | Plugin fails closed; no upstream submission |
| Store lock unavailable | Plugin fails closed; no upstream submission |
| Missing HMAC key with existing records | Startup failure; never generate a replacement key |
| Recovery key omitted | Normal independent submission; no replay lookup |

Tool-facing errors must explain whether retrying with the same key is safe. An `indeterminate` result must not recommend automatic retry; it asks the user to inspect known jobs/account history and explicitly choose whether to create a new key.

## Implemented delivery

1. The shared core package owns deterministic HMAC fingerprints, state transitions, private file locking, atomic replacement, integrity verification, retention and capacity limits.
2. The MCP module owns a low-latency keyed promise cache and private durable ledger, then calls the unchanged Facade API.
3. OpenCode uses its direct-store adapter plus lifecycle hooks immediately around `submit_run`.
4. Both tool contracts keep `idempotency_key` optional so ordinary repeated generations are never collapsed accidentally.

## Acceptance criteria

- Two simultaneous calls with the same explicit recovery key cause exactly one submission.
- Two identical keyless calls remain two independent submissions.
- Replaying after an MCP or OpenCode restart returns the original job and causes zero new submissions.
- Reusing a key with a changed prompt, model, references, edit guidance or selected account fails before external work.
- A simulated crash before the `submitting` sync is safely retryable.
- A simulated crash after the `submitting` sync never automatically calls `submit_run` again.
- Store corruption, missing HMAC key, unsafe permissions, symlinks and durability-uncertain writes all fail closed.
- Stored fixtures contain no raw key, prompt, annotation, URL, local path or AK.
- Codex/MCP and OpenCode pass the same state-machine contract tests while retaining their separate runtime paths.
