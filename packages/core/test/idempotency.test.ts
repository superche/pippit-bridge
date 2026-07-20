import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import { FileIdempotencyStore } from "../src/idempotency.js"

const temporaryDirectories: string[] = []
const hmacKey = Buffer.alloc(32, 11)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

async function storePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pippit-idempotency-"))
  temporaryDirectories.push(directory)
  return join(directory, "records.json")
}

const input = {
  key: "stable-user-key",
  operation: "video_generation",
  request: { model: "pippit/seedance-2.0", prompt: "private prompt" },
  scope: "private-facade-identity",
} as const

describe("FileIdempotencyStore", () => {
  it("replays a submitted response after reopening without persisting request plaintext", async () => {
    const filePath = await storePath()
    const first = new FileIdempotencyStore({ filePath, hmacKey, ownerInstanceId: "first" })
    const begun = await first.begin(input)
    expect(begun.kind).toBe("started")
    if (begun.kind !== "started") throw new Error("Expected a new idempotency record")
    await first.markSubmitting(begun.recordId)
    await first.markSubmitted(begun.recordId, { id: "job-1", status: "pending" })

    const reopened = new FileIdempotencyStore({ filePath, hmacKey, ownerInstanceId: "second" })
    await expect(reopened.begin(input)).resolves.toMatchObject({
      kind: "replay",
      response: { id: "job-1", status: "pending" },
    })
    const raw = await readFile(filePath, "utf8")
    expect(raw).not.toContain(input.key)
    expect(raw).not.toContain(input.scope)
    expect(raw).not.toContain(input.request.prompt)
  })

  it("rejects the same key when its request fingerprint changes", async () => {
    const filePath = await storePath()
    const store = new FileIdempotencyStore({ filePath, hmacKey })
    const begun = await store.begin(input)
    expect(begun.kind).toBe("started")
    await expect(store.begin({ ...input, request: { ...input.request, prompt: "different" } })).resolves.toMatchObject({
      kind: "conflict",
    })
  })

  it("recovers dead preparation owners but fails closed after the submit boundary", async () => {
    const preparingPath = await storePath()
    const deadPreparing = new FileIdempotencyStore({
      filePath: preparingPath,
      hmacKey,
      ownerInstanceId: "dead-preparing",
      ownerPid: 2_000_000_000,
    })
    await deadPreparing.begin(input)
    const preparationRecovery = new FileIdempotencyStore({ filePath: preparingPath, hmacKey, ownerInstanceId: "recovery" })
    await expect(preparationRecovery.begin(input)).resolves.toMatchObject({ kind: "started" })

    const submittingPath = await storePath()
    const deadSubmitting = new FileIdempotencyStore({
      filePath: submittingPath,
      hmacKey,
      ownerInstanceId: "dead-submitting",
      ownerPid: 2_000_000_000,
    })
    const begun = await deadSubmitting.begin(input)
    if (begun.kind !== "started") throw new Error("Expected a new idempotency record")
    await deadSubmitting.markSubmitting(begun.recordId)
    const submissionRecovery = new FileIdempotencyStore({ filePath: submittingPath, hmacKey, ownerInstanceId: "recovery" })
    await expect(submissionRecovery.begin(input)).resolves.toMatchObject({ kind: "indeterminate" })
  })

  it("removes only a private lock whose recorded owner is dead", async () => {
    const filePath = await storePath()
    await writeFile(`${filePath}.lock`, JSON.stringify({ created_at: Date.now(), pid: 2_000_000_000 }), { mode: 0o600 })
    const store = new FileIdempotencyStore({ filePath, hmacKey, lockRetryCount: 0 })

    await expect(store.begin(input)).resolves.toMatchObject({ kind: "started" })
  })
})
