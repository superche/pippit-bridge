import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"

interface ArtifactIdentity {
  readonly artifactHash: string
  readonly kind: string
  readonly sourceGraph: readonly { readonly bytesHash: string; readonly path: string }[]
  readonly sourceGraphHash: string
}

const packageRoot = resolve(import.meta.dirname, "..")

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

function graphHash(graph: ArtifactIdentity["sourceGraph"]): string {
  return createHash("sha256").update(JSON.stringify(canonical(graph))).digest("hex")
}

async function identity(kind: string): Promise<ArtifactIdentity> {
  return JSON.parse(await readFile(resolve(packageRoot, `dist/meta/${kind}.json`), "utf8")) as ArtifactIdentity
}

describe("development artifact source closure", () => {
  test("binds the host to gateway source without pulling in worker handlers", async () => {
    const host = await identity("dev-host")
    const paths = host.sourceGraph.map(input => input.path)
    expect(paths).toContain("package-lock.json")
    expect(paths).toContain("packages/mcp-server-pippit/scripts/build-artifact.mjs")
    expect(paths).toContain("packages/mcp-server-pippit/tsconfig.build.json")
    expect(paths).toContain("packages/mcp-server-pippit/src/dev-stdio.ts")
    expect(paths).not.toContain("packages/mcp-server-pippit/src/tools/runtime.ts")
    expect(graphHash(host.sourceGraph)).toBe(host.sourceGraphHash)
  })

  test("binds daemon identity to Facade, SDK, Core, contracts, and its entry", async () => {
    const daemon = await identity("facade-daemon")
    const paths = daemon.sourceGraph.map(input => input.path)
    for (const expected of [
      "apps/openrouter-facade/src/app.ts",
      "apps/openrouter-facade/tsconfig.build.json",
      "packages/contracts/src/index.ts",
      "packages/contracts/package.json",
      "packages/core/src/index.ts",
      "packages/core/tsconfig.json",
      "packages/sdk/src/client.ts",
      "packages/sdk/tsconfig.build.json",
      "packages/mcp-server-pippit/scripts/local-facade-daemon-entry.mjs",
      "packages/mcp-server-pippit/scripts/build-artifact.mjs",
    ]) expect(paths).toContain(expected)
    expect(graphHash(daemon.sourceGraph)).toBe(daemon.sourceGraphHash)
  })

  test("changes closure identity when any bound source digest changes", async () => {
    const daemon = await identity("facade-daemon")
    for (const path of [
      "apps/openrouter-facade/src/app.ts",
      "packages/core/src/index.ts",
      "packages/sdk/src/client.ts",
      "packages/mcp-server-pippit/scripts/local-facade-daemon-entry.mjs",
    ]) {
      const changed = daemon.sourceGraph.map(input => input.path === path
        ? { ...input, bytesHash: "0".repeat(64) }
        : input)
      expect(graphHash(changed), path).not.toBe(daemon.sourceGraphHash)
    }
  })

  test("binds the worker artifact to the canonical Widget asset and its typed sources", async () => {
    const worker = await identity("worker-generation")
    const paths = worker.sourceGraph.map(input => input.path)
    expect(paths).toContain("packages/mcp-server-pippit/assets/generated/pippit-video-job-v15.html")
    expect(paths).toContain("packages/mcp-server-pippit/scripts/build-artifact.mjs")
    expect(paths).toContain("packages/mcp-server-pippit/scripts/build-widget.mjs")
    expect(paths).toContain("packages/mcp-server-pippit/src/widget/state.ts")
    expect(paths).toContain("packages/mcp-server-pippit/src/widget/template.ts")
    expect(graphHash(worker.sourceGraph)).toBe(worker.sourceGraphHash)
  })
})
