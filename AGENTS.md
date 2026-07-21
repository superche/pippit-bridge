# Pippit Bridge Agent Guide

This file applies to the whole repository. The detailed Codex Plugin design and runbook lives in
[`docs/codex-plugin-dev-release-engineering.md`](docs/codex-plugin-dev-release-engineering.md).

## Editing and repository safety

- Make code changes only with `Write`, `Edit`, `MultiEdit`, or another editor that exposes narrow file diffs to the CADK hook. Do not use `git apply`, `cp`, or bulk rewrite scripts to modify source files.
- Start release work from an isolated worktree based on the latest `origin/main`. Do not publish from a dirty primary checkout or a stale local `main`.
- Preserve unrelated user changes and local data. Do not implement development by editing the global Codex plugin cache or by using symlink traversal.
- `npm publish`, production marketplace activation, and destructive rollback require explicit user authorization. A feature-branch push or PR does not authorize any of those release actions.

## Codex Plugin identities and isolation

- Production identity is `pippit-video@pippit-bridge`; development identity is `pippit-video@pippit-bridge-dev`.
- Dev and production must use physically separate Codex profiles, plugin caches, runtime roots, credentials, jobs, artifacts, and task context. Never enable both identities in one profile.
- Skills are immutable files scanned by the Codex host. The MCP gateway does not hot-reload or manage Skills.
- Direct npm installation requires a supported external Node.js runtime; the package does not bundle Node.
- The current `/bin/sh` launcher supports macOS and Linux. Native Windows Codex launch is unsupported until the launcher contract changes.

## Backend development hot loop

Use:

```bash
npm run codex:dev
npm run codex:dev:status
npm run check:dev-gateway
npm run codex:dev:full-gate
```

`npm run codex:dev` prepares an isolated local marketplace and a stable Codex-facing stdio gateway. The gateway keeps its connection and frozen discovery contract while replaceable child worker generations carry implementation changes. Calls and resource reads pin one generation; old calls drain without replay and new calls use the activated generation.

Candidate changes run related tests plus the gateway/supervisor/Widget core suite. Activation additionally requires `.pippit-dev/semantic-review.json`, which is local and ignored by Git:

```json
{
  "classification": "hot-compatible",
  "migrationEpoch": 1,
  "sourceHash": "copy candidateSourceHash from npm run codex:dev:status",
  "storageBackwardCompatible": true
}
```

Only behavior-compatible handler changes may be hot. Tool names, schemas, descriptions, result meaning, resource URI/MIME/CSP/binding, manifest, `.mcp.json`, Skills, defaults, validation, confirmation, approval, payment, and write boundaries are cold contracts that require an immutable release and a new task.

The backend worker hot path is wired and host-validated. `src/dev-widget.ts` currently contains protected loopback asset/HMR primitives and tests, but it is not wired into the installed Widget `outputTemplate`; do not claim mounted iframe HMR. Widget source changes require a cold rebuild and a new Widget instance unless that integration is completed and proven against the target Codex host.

## Version and contract rules

- `packages/mcp-server-pippit/package.json` is the mechanical plugin version source. Use `npm run sync:plugin-version -- <exact-version>` and then `npm run check:plugin-version`; do not update version markers independently.
- The root lockfile may resolve remote packages only from `https://registry.npmjs.org`. Keep `.npmrc` pinned to the official registry and run `npm run check:public-lockfile`; internal mirror URLs make public clean installs non-reproducible.
- `.agents/plugins/marketplace.json` is the canonical production catalog and must use an exact direct npm source. It may point only to an artifact that exists on the official npm registry and has been re-downloaded and verified.
- Contract goldens are generated from a clean build of the real launcher and discovery surface. The npm commands build `@pippit-bridge/core` before the MCP package so clean worktrees cannot reuse stale workspace output. Discovery strips ambient `PIPPIT_*` values and injects an isolated runtime/output root plus fixed non-secret enrollment settings so CI, developer accounts, and platform defaults cannot alter the golden; run `npm run generate:plugin-contract` only for an intentional cold-contract release, review the diff, and keep `npm run check:plugin-contract` green.
- Skills remain part of the plugin contract through their cache digest even though they are not served by the MCP gateway.

## Release workflow

The order is mandatory:

```text
clean install/build/test/pack
  -> direct-extract offline launcher smoke
  -> protected npm publish gate
  -> official-registry metadata, re-download, install, and launcher verification
  -> optional exact-version marketplace activation PR
```

Local release gate:

```bash
npm ci
npm run check:public-lockfile
npm run check:plugin-version
npm run check:plugin-contract
npm run check
npm run check:release-artifact
npm run check:dev-gateway
```

- `.github/workflows/plugin-contract.yml` enforces version, contract, build, test, artifact, and dev-gateway gates on PRs and `main` across supported Node/platform combinations.
- `.github/workflows/plugin-release.yml` is a manually dispatched, environment-protected publish workflow. It refuses occupied versions, publishes the packed artifact, re-downloads it from the official registry, and creates an activation PR only when `activate_marketplace=true`.
- Roll back by committing the previous verified exact npm version to the canonical catalog and creating a new task. Never overwrite npm, force-push a release, or combine a runtime rollback with newer manifest/Skill/resource files.

## Required handoff evidence

Record exact commands and results for version/contract checks, full tests, tarball contents, real launcher smoke, tools/resources/templates/read, Skill digest, dev generation activation, and any host acceptance performed. Clearly separate locally verified behavior, target-host evidence, and behavior that remains an implementation detail rather than a public Codex SLA.
