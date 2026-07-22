import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "..")

describe("Codex Dev source watcher", () => {
  it("tracks every workspace source and manifest in the worker/daemon build closure", async () => {
    const source = await readFile(resolve(root, "scripts/codex-dev.mjs"), "utf8")
    for (const input of [
      "package.json",
      "package-lock.json",
      "tsconfig.base.json",
      "packages/contracts/src",
      "packages/contracts/package.json",
      "packages/contracts/tsconfig.json",
      "packages/contracts/tsconfig.build.json",
      "packages/core/src",
      "packages/core/package.json",
      "packages/core/tsconfig.json",
      "packages/core/tsconfig.build.json",
      "packages/sdk/src",
      "packages/sdk/package.json",
      "packages/sdk/tsconfig.json",
      "packages/sdk/tsconfig.build.json",
      "apps/openrouter-facade/src",
      "apps/openrouter-facade/package.json",
      "apps/openrouter-facade/tsconfig.json",
      "apps/openrouter-facade/tsconfig.build.json",
    ]) {
      expect(source).toContain(`resolve(root, "${input}")`)
    }
    expect(source).toContain('resolve(packageRoot, "src")')
    expect(source).toContain('resolve(packageRoot, "scripts/build-artifact.mjs")')
    expect(source).toContain('resolve(packageRoot, "scripts/build-widget.mjs")')
    expect(source).toContain('resolve(packageRoot, "scripts/local-facade-daemon-entry.mjs")')
    expect(source).toContain('resolve(packageRoot, "package.json")')
    expect(source).toContain('resolve(packageRoot, "tsconfig.json")')
    expect(source).toContain('resolve(packageRoot, "tsconfig.build.json")')
  })
})
