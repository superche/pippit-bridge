# opencode-provider-pippit

OpenCode plugin for Pippit (小云雀) video generation. It uses OpenCode's standard plugin surfaces:

- `auth` hook for `/connect` and `opencode auth login`
- `pippit_manage_access_keys` for multi-account configuration, listing, switching, and deletion
- `pippit_generate_video` and `pippit_get_video` native tools
- the shared Pippit model catalog from this monorepo

Pippit's current public API is an asynchronous media API, not an AI SDK language model. The package therefore does not pretend that a video model implements OpenCode's `LanguageModelV3` contract.

## Install

Add the package to the global or project OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-provider-pippit"]
}
```

Ask OpenCode to configure a named Pippit account. `pippit_manage_access_keys` with `operation: "configure"` returns `https://xyq.jianying.com` and tells the user to sign in to the target account and issue an AK from the top of the page. The tool never accepts the AK itself. After issuance, run `/connect`, select `Pippit`, and paste the AK into OpenCode's hidden password prompt. The pending configure operation supplies the non-secret local account name; `/connect` only handles the secret.

OpenCode 1.18.3 stores only one credential per provider ID. To preserve older accounts when `/connect` imports another key, this plugin keeps a global keyring at `<OpenCode state>/pippit/access-keys.json`; it is outside every project/worktree, uses a `0700` directory and `0600` atomically replaced file, and is plaintext under the same local-user threat boundary as OpenCode's `auth.json`. The plugin does not read cookies, watch the clipboard, or accept raw AKs through normal tool arguments.

`opencode auth logout pippit` only clears OpenCode's single import slot. Use `pippit_manage_access_keys delete` to remove an AK from the multi-account keyring, and revoke it at the top-of-page AK management entry on the Pippit website when it must become invalid immediately.

Use `pippit_manage_access_keys` with:

- `operation: "list"` to return only account IDs, user-defined names, masked AKs, and active state.
- `operation: "switch"` plus `account_id` or `account_name` to select the account for new runs.
- `operation: "delete"` plus `account_id` or `account_name` to delete a local AK. Switch away before deleting an active account when other accounts remain. The result reports how many saved run bindings are affected. Local deletion does not revoke the key on the Pippit website.

For CI or a short-lived isolated environment, `PIPPIT_ACCESS_KEY` is also supported. It overrides the selected local account for new or otherwise unbound operations; all management results report the override instead of claiming the local selection is effective. A persisted managed-account run binding takes precedence when polling an existing run, so a later environment change cannot silently cross account scope.

## Use

Ask OpenCode to generate a Pippit video. The plugin asks on every potentially billable submission and separately before downloading into the worktree; neither permission can be permanently allowed. The API origin is pinned to the official Pippit origin. HTTP(S) references receive private-network and media-signature checks. Local references and output directories are constrained to the current worktree, and repeated downloads choose a collision-safe filename without overwriting existing files.

Every managed-account submission attempts to pin `run_id + thread_id` to the account used for submission. Switching accounts affects new runs; polling an existing bound run resolves its original account. If persistence fails after the upstream submission succeeds, the generation result is still returned with `account_binding_persisted: false`, a do-not-retry warning, and the `account_id` that can be supplied to a later get operation. If the bound account has been deleted, polling fails closed instead of silently using another AK.

The default output directory is `.pippit/outputs`.

## Website one-click binding

When Pippit exposes the device-authorization contract described in `docs/opencode-ak-binding.md`, enable it with plugin options:

```json
{
  "plugin": [
    [
      "opencode-provider-pippit",
      {
        "deviceAuthorization": {
          "authorizationURL": "https://xyq.jianying.com/developer/ak/device_authorization",
          "tokenURL": "https://xyq.jianying.com/developer/ak/token",
          "clientID": "pippit-opencode",
          "scope": "asset.upload video.generate video.read"
        }
      }
    ]
  ]
}
```

The browser only receives a short-lived device grant. The Access Key is returned to the waiting plugin over HTTPS, then imported into the same global multi-account keyring; it is never placed in a redirect URL.
