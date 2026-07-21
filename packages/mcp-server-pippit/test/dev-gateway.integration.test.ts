import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { createDevMcpGateway, type DevWorkerRequest, type DevWorkerResult } from "../src/dev-gateway.ts"
import { DevWorkerPool } from "../src/dev-supervisor.ts"
import { ChildMcpWorkerGeneration } from "../src/dev-worker-process.ts"

const fixture = resolve(fileURLToPath(new URL(".", import.meta.url)), "fixtures/dev-worker.mjs")
const workers: ChildMcpWorkerGeneration[] = []
const review = { behaviorTestsPassed: true, contractHash: "frozen-hash", semanticClassification: "hot-compatible" as const }

async function start(label: string, variant?: "cold") {
  const result = await ChildMcpWorkerGeneration.start({
    contractHash: "frozen-hash",
    entryPath: fixture,
    env: { ...process.env, DEV_WORKER_LABEL: label, ...(variant ? { DEV_WORKER_CONTRACT_VARIANT: variant } : {}) },
    generationId: label,
    implementationHash: `implementation-${label}`,
    migrationEpoch: 1,
    storageBackwardCompatible: true,
  })
  workers.push(result.worker)
  return result
}

afterEach(async () => Promise.all(workers.splice(0).map(worker => worker.close())))

describe("stable dev MCP gateway", () => {
  test("keeps one Codex-facing session while calls pin N and switch to N+1", async () => {
    const n = await start("n")
    const pool = new DevWorkerPool<DevWorkerRequest, DevWorkerResult>("frozen-hash")
    await pool.activate(n.worker, review)
    const gateway = createDevMcpGateway({ contract: n.contract, pool })
    const initialized = await gateway.handle({ id: 1, jsonrpc: "2.0", method: "initialize", params: { capabilities: {}, protocolVersion: "2025-11-25" } })
    expect(initialized).toMatchObject({ id: 1, result: { capabilities: { resources: { listChanged: false }, tools: { listChanged: false } } } })

    const slow = gateway.handle({ id: 2, jsonrpc: "2.0", method: "tools/call", params: { arguments: { delay_ms: 80, value: "old" }, name: "fixture_echo" } })
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20))
    const next = await start("next")
    expect(next.contract).toEqual(n.contract)
    await pool.activate(next.worker, review)
    const fresh = await gateway.handle({ id: 3, jsonrpc: "2.0", method: "tools/call", params: { arguments: { value: "new" }, name: "fixture_echo" } })
    expect(fresh).toMatchObject({ result: { structuredContent: { generation: "next", value: "new" } } })
    expect(await slow).toMatchObject({ result: { structuredContent: { generation: "n", value: "old" } } })
    expect(await gateway.handle({ id: 4, jsonrpc: "2.0", method: "ping", params: {} })).toMatchObject({ id: 4, result: {} })
  })

  test("keeps frozen discovery and fails calls closed after worker crash", async () => {
    const n = await start("n")
    const pool = new DevWorkerPool<DevWorkerRequest, DevWorkerResult>("frozen-hash")
    await pool.activate(n.worker, review)
    const gateway = createDevMcpGateway({ contract: n.contract, pool })
    await gateway.handle({ id: 1, jsonrpc: "2.0", method: "initialize", params: { capabilities: {}, protocolVersion: "2025-11-25" } })
    const crashed = await gateway.handle({ id: 2, jsonrpc: "2.0", method: "tools/call", params: { arguments: { crash: true }, name: "fixture_echo" } })
    expect(crashed).toMatchObject({ result: { isError: true, structuredContent: { error: { code: "DEV_SUPERVISOR_UNAVAILABLE" } } } })
    expect(await gateway.handle({ id: 3, jsonrpc: "2.0", method: "tools/list", params: {} })).toMatchObject({ result: { tools: [{ description: "Frozen echo" }] } })
  })

  test("detects a cold candidate before activation", async () => {
    const n = await start("n")
    const cold = await start("cold", "cold")
    expect(cold.contract).not.toEqual(n.contract)
  })
})
