import { describe, expect, test, vi } from "vitest"
import { DEV_WORKER_IPC_VERSION, DevGatewayError, DevWorkerPool, DevWorkerSupervisor, type DevWorkerGeneration } from "../src/dev-supervisor.ts"

function worker(id: string, contractHash = "contract-a", migrationEpoch = 1, storageBackwardCompatible = true) {
  const close = vi.fn(async () => undefined)
  const invoke = vi.fn(async (value: string) => `${id}:${value}`)
  return {
    close,
    contractHash,
    generationId: id,
    implementationHash: `impl-${id}`,
    invoke,
    ipcVersion: DEV_WORKER_IPC_VERSION,
    migrationEpoch,
    ready: true,
    storageBackwardCompatible,
  } satisfies DevWorkerGeneration<string, string>
}

const review = { behaviorTestsPassed: true, contractHash: "contract-a", semanticClassification: "hot-compatible" as const }

describe("DevWorkerPool", () => {
  test("pins an in-flight call to N while new calls use N+1", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const n = worker("n")
    n.invoke.mockImplementationOnce(async value => { await gate; return `n:${value}` })
    const next = worker("next")
    const pool = new DevWorkerPool<string, string>("contract-a")
    await pool.activate(n, review)
    const oldCall = pool.invoke("slow")
    await pool.activate(next, review)
    expect(await pool.invoke("new")).toBe("next:new")
    expect(n.close).not.toHaveBeenCalled()
    release()
    expect(await oldCall).toBe("n:slow")
    expect(n.close).toHaveBeenCalledOnce()
  })

  test("rejects cold contract and unreviewed semantics", async () => {
    const pool = new DevWorkerPool<string, string>("contract-a")
    await expect(pool.activate(worker("wrong", "contract-b"), review)).rejects.toMatchObject({ code: "DEV_CONTRACT_MISMATCH" })
    await expect(pool.activate(worker("unreviewed"), { ...review, semanticClassification: "unreviewed" })).rejects.toMatchObject({ code: "DEV_SEMANTIC_REVIEW_REQUIRED" })
  })

  test("fails closed after an incompatible post-write migration", async () => {
    const pool = new DevWorkerPool<string, string>("contract-a")
    const n = worker("n", "contract-a", 1)
    const next = worker("next", "contract-a", 2, false)
    await pool.activate(n, review)
    await pool.activate(next, review)
    await pool.invoke("write", { writesState: true })
    await expect(pool.rollback(n)).rejects.toEqual(expect.objectContaining<Partial<DevGatewayError>>({ code: "DEV_POST_ACTIVATION_UNSAFE_ROLLBACK" }))
  })

  test("isolates worker pools by contract hash", () => {
    const supervisor = new DevWorkerSupervisor()
    expect(supervisor.pool("a")).not.toBe(supervisor.pool("b"))
    expect(supervisor.pool("a")).toBe(supervisor.pool("a"))
  })

  test("closes the active generation when the stable gateway shuts down", async () => {
    const pool = new DevWorkerPool<string, string>("contract-a")
    const active = worker("active")
    await pool.activate(active, review)
    await pool.close()
    expect(active.close).toHaveBeenCalledOnce()
    await expect(pool.invoke("after-close")).rejects.toMatchObject({ code: "DEV_SUPERVISOR_UNAVAILABLE" })
  })
})
