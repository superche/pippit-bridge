import { mkdtemp, mkdir, lstat, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { LazyOpenCodeIdempotencyStore } from "../src/idempotency.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pippit-opencode-idempotency-"))
  temporaryDirectories.push(root)
  return root
}

function input(key: string) {
  return {
    key,
    operation: "video_generation",
    request: { prompt: `private-${key}` },
    scope: "opencode-account",
  }
}

describe("LazyOpenCodeIdempotencyStore private files", () => {
  it("creates one private secret and a plaintext-free record store", async () => {
    const root = await stateRoot()
    const first = new LazyOpenCodeIdempotencyStore(async () => root)
    const second = new LazyOpenCodeIdempotencyStore(async () => root)

    await expect(Promise.all([
      first.begin(input("first-key")),
      second.begin(input("second-key")),
    ])).resolves.toMatchObject([{ kind: "started" }, { kind: "started" }])

    const directory = join(root, "pippit")
    const secretPath = join(directory, "idempotency-secret-v1.json")
    const recordsPath = join(directory, "idempotency-v1.json")
    expect((await lstat(directory)).mode & 0o777).toBe(0o700)
    expect((await lstat(secretPath)).mode & 0o777).toBe(0o600)
    expect((await lstat(secretPath)).nlink).toBe(1)
    expect((await lstat(recordsPath)).mode & 0o777).toBe(0o600)
    const records = await readFile(recordsPath, "utf8")
    expect(records).not.toContain("first-key")
    expect(records).not.toContain("private-first-key")
    await first.close()
    await second.close()
  })

  it("does not replace a missing or linked secret for an existing store", async () => {
    const missingRoot = await stateRoot()
    const missingDirectory = join(missingRoot, "pippit")
    await mkdir(missingDirectory, { mode: 0o700 })
    await writeFile(join(missingDirectory, "idempotency-v1.json"), "existing", { mode: 0o600 })
    const missing = new LazyOpenCodeIdempotencyStore(async () => missingRoot)
    await expect(missing.begin(input("missing-secret"))).rejects.toThrow(
      "An OpenCode idempotency store exists without its HMAC key",
    )

    const linkedRoot = await stateRoot()
    const linkedDirectory = join(linkedRoot, "pippit")
    await mkdir(linkedDirectory, { mode: 0o700 })
    const target = join(linkedDirectory, "secret-target.json")
    await writeFile(target, `${JSON.stringify({
      idempotency_hmac_key_hex: "11".repeat(32),
      schema_version: 1,
    })}\n`, { mode: 0o600 })
    await symlink(target, join(linkedDirectory, "idempotency-secret-v1.json"))
    const linked = new LazyOpenCodeIdempotencyStore(async () => linkedRoot)
    await expect(linked.begin(input("linked-secret"))).rejects.toThrow(
      "The OpenCode idempotency secret is invalid or unsafe",
    )
  })
})
