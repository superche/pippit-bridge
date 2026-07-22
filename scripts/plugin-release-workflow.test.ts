import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "..")

describe("plugin release dependency order", () => {
  it("publishes or verifies contracts before packing and publishing the MCP consumer", async () => {
    const workflow = await readFile(resolve(root, ".github/workflows/plugin-release.yml"), "utf8")
    const contractsPack = workflow.indexOf("npm pack -w @pippit-bridge/contracts")
    const contractsPublish = workflow.indexOf("npm publish \"$local_tarball\"")
    const contractsInstall = workflow.indexOf("/tmp/pippit-contracts-registry-install")
    const corePack = workflow.indexOf("npm pack -w @pippit-bridge/core")
    const corePublish = workflow.indexOf("name: Publish or verify the exact core dependency")
    const coreInstall = workflow.indexOf("/tmp/pippit-core-registry-install")
    const mcpPack = workflow.indexOf("npm pack -w @pippit-bridge/mcp-server")
    const mcpPublish = workflow.indexOf("npm publish \"release/pippit-bridge-mcp-server-")

    expect(contractsPack).toBeGreaterThan(-1)
    expect(contractsPublish).toBeGreaterThan(contractsPack)
    expect(contractsInstall).toBeGreaterThan(contractsPublish)
    expect(corePack).toBeGreaterThan(contractsPack)
    expect(corePublish).toBeGreaterThan(contractsInstall)
    expect(coreInstall).toBeGreaterThan(corePublish)
    expect(mcpPack).toBeGreaterThan(coreInstall)
    expect(mcpPublish).toBeGreaterThan(mcpPack)
    expect(workflow).toContain("diff -ru local-contracts/package registry-contracts-extracted/package")
    expect(workflow).toContain("diff -ru local-core/package registry-core-extracted/package")
    expect(workflow).toContain("diff -ru local-contracts-verify/package registry-contracts-extracted-verify/package")
    expect(workflow).toContain("diff -ru local-core-verify/package registry-core-extracted-verify/package")
    expect(workflow).toContain("diff -ru local-mcp-verify/package registry-mcp-extracted-verify/package")
    expect(workflow).toContain("npm run check:release-artifact && npm run check:dev-gateway")
    expect(workflow).toContain("smoke-installed-bin.mjs /tmp/pippit-registry-install/node_modules/.bin/pippit-mcp")
  })

  it("builds the contracts package from a clean checkout before packing", async () => {
    const manifest = JSON.parse(await readFile(resolve(root, "packages/contracts/package.json"), "utf8")) as {
      scripts?: Record<string, string>
    }
    expect(manifest.scripts?.prepack).toBe("npm run build")
  })
})
