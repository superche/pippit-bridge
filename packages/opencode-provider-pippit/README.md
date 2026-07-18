# opencode-provider-pippit

OpenCode plugin for Pippit (小云雀) video generation. It uses OpenCode's standard plugin surfaces:

- `auth` hook for `/connect` and `opencode auth login`
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

Restart OpenCode, run `/connect`, select `Pippit`, and choose `Paste an Access Key issued by Pippit`. Create that dedicated key on the official Pippit website first. OpenCode owns the credential entry and stores it in its normal auth store; the plugin does not read cookies or write a second secret file.

For CI or a short-lived isolated environment, `PIPPIT_ACCESS_KEY` is also supported.

## Use

Ask OpenCode to generate a Pippit video. The plugin asks on every potentially billable submission and separately before downloading into the worktree; neither permission can be permanently allowed. The API origin is pinned to the official Pippit origin. HTTP(S) references receive private-network and media-signature checks. Local references and output directories are constrained to the current worktree, and repeated downloads choose a collision-safe filename without overwriting existing files.

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

The browser only receives a short-lived device grant. The Access Key is returned to the waiting plugin over HTTPS and handed to OpenCode's auth store; it is never placed in a redirect URL.
