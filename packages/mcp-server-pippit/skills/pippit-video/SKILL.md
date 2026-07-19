---
name: pippit-video
description: Use when the user wants to manage facade-backed Pippit accounts, list video models, submit generation or structured segment-edit jobs, inspect status, locally save and preview completed video, or create an additional named copy through Pippit Bridge.
---

# Pippit Video

Use the bundled `pippit_*` tools as the only capability layer. The Codex plugin starts this same MCP server; it does not maintain a second account, generation, or editing implementation.

## Configuration boundary

On a local Codex plugin, stdio MCP, or local ChatGPT App install, do not ask the user to configure internal facade credentials. Installation and MCP discovery are side-effect free. On the first actual `pippit_*` tool call, the shared MCP layer idempotently creates or reconnects to one user-level, loopback-only Pippit Facade runtime. Its internal runtime, management, encryption, job-signing, and ChatGPT media-signing keys stay in private user state outside the plugin cache and project directory. Codex/stdio previews use the host-proxied MCP resource bridge and do not expose a loopback or upstream media URL.

An operator may instead configure an external facade by setting both `PIPPIT_FACADE_BASE_URL` and `PIPPIT_FACADE_API_KEY`. If either one is configured without the other, do not fall back to the local runtime; report the configuration error. `PIPPIT_FACADE_MANAGEMENT_API_KEY` remains optional in external mode and controls whether the account-management tools are available.

Never ask for, accept, display, or persist a raw Pippit Access Key in a prompt, ordinary environment variable, config manifest, log, or tool argument.

Account management is enabled only when `PIPPIT_FACADE_MANAGEMENT_API_KEY` is configured. This is a separate facade Management API Key, not a Pippit AK and not the runtime Facade API Key. `pippit_add_access_key` returns a short-lived loopback setup URL. Ask the user to open that URL and enter the Pippit AK in its password field; never ask them to paste the AK into chat. The enrollment page sends the secret directly to the facade management plane and the tool results contain only masked account metadata.

External mode also reads:

- `PIPPIT_FACADE_TIMEOUT_MS` (default `120000`)
- `PIPPIT_MCP_OUTPUT_ROOT` (default `~/Movies/Pippit` on macOS or `~/Videos/Pippit` elsewhere)

In local mode, every completed output is first saved as an ordinary MP4 under `~/Movies/Pippit` on macOS or `~/Videos/Pippit` on other platforms. `PIPPIT_MCP_OUTPUT_ROOT` overrides this location. `PIPPIT_BRIDGE_HOME` is only a test/advanced isolation override; when it is set, outputs stay beneath that isolated root. Never suggest placing outputs in a temporary directory, plugin cache, or project checkout.

For Codex/stdio, the widget reads bounded chunks of the completed MP4 through standard MCP Apps `resources/read`, reconstructs a sandbox-local `blob:` URL, and revokes that URL when the widget changes source or closes. The stable resource identity is derived from the job and output index, so a new stdio process can reopen the same ordinary local file without a stale port. Neither an upstream signed URL nor a local filesystem path is assigned directly to the player.

## Workflow

1. If no account is configured, call `pippit_add_access_key` with a non-secret account name, then have the user complete its loopback setup page. Use `pippit_list_access_keys` to confirm the masked account is active.
2. Use `pippit_switch_access_key` to select the account for new jobs. Switching never changes the credential embedded in an existing job id. Before `pippit_delete_access_key`, show the selected masked account and get explicit confirmation; local deletion does not revoke the AK on the Pippit website.
3. Call `pippit_list_video_models` when the model or its supported settings are not already known.
4. Call `pippit_generate_video` once with a new, stable `idempotency_key`. It submits a job and returns immediately; it does not wait for generation to finish.
5. Save the returned job `id`, then poll `pippit_get_video` until the job reaches a terminal state. A completed `pippit_get_video` first materializes every output as a regular local MP4, then automatically opens the shared video preview and segment-edit widget through the MCP Apps local resource bridge. Report the local path when it helps the user find the result.
6. Call `pippit_download_video` only when the user asks for an additional copy with a chosen relative file name/path. The job must be `completed`; use a new relative `output_path` beneath the configured output root. Existing files are never overwritten. Do not use this tool as a prerequisite for normal playback or initial local persistence.

## Segment editing

Use `pippit_edit_video_segment` only with a completed source job. Supply a source output index, a segment of at most 30 seconds, and either an overall prompt or one or more timestamped rectangle annotations. Rectangle coordinates are normalized to the intrinsic video content, not the widget box or its letterboxing.

The current upstream contract receives the source video plus deterministic segment and region instructions. It does not expose a hard server-side trim or pixel mask. Describe the result as an instructed local edit, not as proof that bytes outside the selection were omitted or that an exact mask was enforced.

The edit returns another asynchronous job. Poll it with `pippit_get_video`; its completed result is likewise saved locally first and opens the same preview/editor widget. Create an extra copy only under the explicit-copy rule above.

`frame_images` and `input_references` use HTTP(S) URLs that the facade resolves. A request containing frame images uses first/last-frame generation semantics. Never mix `frame_images` with `input_references` in one request.

Do not claim text, standalone image, speech, transcription, or audio-generation support. Audio is accepted only as an input reference for a video request.
