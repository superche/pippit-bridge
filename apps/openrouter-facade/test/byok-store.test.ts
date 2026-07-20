import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { chmod, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtemp } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import {
  ByokStoreError,
  DEFAULT_BYOK_WORKSPACE_ID,
  FileByokStore,
  MemoryByokStore,
} from "../src/byok/index.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

async function temporaryStorePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pippit-byok-store-"))
  temporaryDirectories.push(directory)
  return join(directory, "credentials.json")
}

async function rewriteAsLegacyEnvelopeWithoutActiveSelections(
  filePath: string,
  masterKey: Uint8Array,
): Promise<void> {
  const envelope = JSON.parse(await readFile(filePath, "utf8")) as {
    ciphertext: string
    format: "pippit-byok-store"
    key_id: string
    nonce: string
    tag: string
    version: 1
  }
  const aad = Buffer.from(
    `${envelope.format}\u0000${envelope.version}\u0000${envelope.key_id}\u0000pippit-bridge`,
    "utf8",
  )
  const decipher = createDecipheriv(
    "aes-256-gcm",
    masterKey,
    Buffer.from(envelope.nonce, "base64url"),
    { authTagLength: 16 },
  )
  decipher.setAAD(aad)
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ])
  const state = JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>
  Reflect.deleteProperty(state, "active_selections")

  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce, { authTagLength: 16 })
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()])
  await writeFile(
    filePath,
    JSON.stringify({
      ...envelope,
      ciphertext: ciphertext.toString("base64url"),
      nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    }),
    { mode: 0o600 },
  )
}

describe("MemoryByokStore", () => {
  it("creates public credentials without exposing secret material", async () => {
    const store = new MemoryByokStore()
    const credential = await store.create({
      key: "ak-secret-never-public",
      name: "production",
      provider: "pippit",
    })

    expect(credential).toMatchObject({
      allowed_api_key_hashes: null,
      allowed_models: null,
      allowed_user_ids: null,
      disabled: false,
      is_fallback: false,
      name: "production",
      provider: "pippit",
      workspace_id: DEFAULT_BYOK_WORKSPACE_ID,
    })
    expect(credential.id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(credential.label).toBe("ak-****blic")
    expect(JSON.stringify(credential)).not.toContain("ak-secret-never-public")
    expect(JSON.stringify(credential)).not.toContain("ciphertext")
    expect(JSON.stringify(credential)).not.toContain("fingerprint")
    expect(await store.getWorkspaceId()).toBe(DEFAULT_BYOK_WORKSPACE_ID)

    const listed = await store.list({ limit: "10", offset: "0" })
    expect(listed.total_count).toBe(1)
    expect(listed.data).toEqual([credential])
  })

  it("pins old key versions while rotating the active Pippit AK", async () => {
    const store = new MemoryByokStore()
    const credential = await store.create({ key: "ak-old", provider: "pippit" })
    const [beforeRotation] = await store.resolveCandidates({
      model: "pippit/seedance-2.0",
      workspaceId: DEFAULT_BYOK_WORKSPACE_ID,
    })
    expect(beforeRotation?.accessKey).toBe("ak-old")
    expect(beforeRotation?.keyVersion.id).toMatch(/^[0-9a-f-]{36}$/u)

    await store.update(credential.id, { key: "ak-new" })
    const [afterRotation] = await store.resolveCandidates({
      model: "pippit/seedance-2.0",
      workspaceId: DEFAULT_BYOK_WORKSPACE_ID,
    })
    expect(afterRotation?.accessKey).toBe("ak-new")
    expect(afterRotation?.keyVersion.id).not.toBe(beforeRotation?.keyVersion.id)

    const pinned = await store.getVersion(credential.id, beforeRotation?.keyVersion.id ?? "")
    expect(pinned?.accessKey).toBe("ak-old")
    expect(JSON.stringify(pinned?.credential)).not.toContain("ak-old")
  })

  it("filters candidates with AND semantics and orders primary keys before fallbacks", async () => {
    const store = new MemoryByokStore()
    const callerHash = "a".repeat(64)
    const primary = await store.create({
      allowed_api_key_hashes: [callerHash],
      allowed_models: ["pippit/seedance-2.0"],
      allowed_user_ids: ["user-1"],
      key: "ak-primary",
      name: "primary",
      provider: "pippit",
    })
    const fallback = await store.create({
      allowed_api_key_hashes: [callerHash],
      allowed_models: ["pippit/seedance-2.0"],
      allowed_user_ids: ["user-1"],
      is_fallback: true,
      key: "ak-fallback",
      name: "fallback",
      provider: "pippit",
    })
    await store.create({
      allowed_models: [],
      key: "ak-never-matches",
      name: "empty-filter",
      provider: "pippit",
    })
    await store.create({ disabled: true, key: "ak-disabled", provider: "pippit" })

    const resolved = await store.resolveCandidates({
      apiKeyHash: callerHash,
      model: "pippit/seedance-2.0",
      userId: "user-1",
      workspaceId: DEFAULT_BYOK_WORKSPACE_ID,
    })
    expect(resolved.map((candidate) => candidate.accessKey)).toEqual(["ak-primary", "ak-fallback"])

    const explicitlySelected = await store.resolveCandidates({
      apiKeyHash: callerHash,
      credentialId: fallback.id,
      model: "pippit/seedance-2.0",
      userId: "user-1",
      workspaceId: DEFAULT_BYOK_WORKSPACE_ID,
    })
    expect(explicitlySelected.map((candidate) => candidate.credential.id)).toEqual([fallback.id])
    expect(
      await store.resolveCandidates({
        apiKeyHash: "b".repeat(64),
        credentialId: primary.id,
        model: "pippit/seedance-2.0",
        userId: "user-1",
        workspaceId: DEFAULT_BYOK_WORKSPACE_ID,
      }),
    ).toEqual([])
  })

  it("isolates active selections by caller, honors explicit selection, and fails closed", async () => {
    const store = new MemoryByokStore()
    const firstCallerHash = "a".repeat(64)
    const secondCallerHash = "b".repeat(64)
    const unselectedCallerHash = "c".repeat(64)
    const allowedHashes = [firstCallerHash, secondCallerHash, unselectedCallerHash]
    const first = await store.create({
      allowed_api_key_hashes: allowedHashes,
      key: "ak-first",
      provider: "pippit",
    })
    const second = await store.create({
      allowed_api_key_hashes: allowedHashes,
      key: "ak-second",
      provider: "pippit",
    })

    await store.setActiveSelection(firstCallerHash, first.id)
    await store.setActiveSelection(secondCallerHash, second.id)
    expect(await store.getActiveSelection(firstCallerHash)).toMatchObject({
      credential_id: first.id,
      facade_api_key_hash: firstCallerHash,
    })
    expect(
      (
        await store.resolveCandidates({
          apiKeyHash: firstCallerHash,
          model: "pippit/seedance-2.0",
          workspaceId: DEFAULT_BYOK_WORKSPACE_ID,
        })
      ).map((candidate) => candidate.credential.id),
    ).toEqual([first.id])
    expect(
      (
        await store.resolveCandidates({
          apiKeyHash: secondCallerHash,
          model: "pippit/seedance-2.0",
          workspaceId: DEFAULT_BYOK_WORKSPACE_ID,
        })
      ).map((candidate) => candidate.credential.id),
    ).toEqual([second.id])
    expect(
      (
        await store.resolveCandidates({
          apiKeyHash: unselectedCallerHash,
          model: "pippit/seedance-2.0",
          workspaceId: DEFAULT_BYOK_WORKSPACE_ID,
        })
      ).map((candidate) => candidate.credential.id),
    ).toEqual([first.id, second.id])

    const explicitlySelected = await store.resolveCandidates({
      apiKeyHash: firstCallerHash,
      credentialId: second.id,
      model: "pippit/seedance-2.0",
      workspaceId: DEFAULT_BYOK_WORKSPACE_ID,
    })
    expect(explicitlySelected.map((candidate) => candidate.credential.id)).toEqual([second.id])

    await store.update(first.id, { disabled: true })
    expect(
      await store.resolveCandidates({
        apiKeyHash: firstCallerHash,
        model: "pippit/seedance-2.0",
        workspaceId: DEFAULT_BYOK_WORKSPACE_ID,
      }),
    ).toEqual([])
    await store.update(first.id, { disabled: false })
    await expect(store.delete(first.id)).rejects.toMatchObject({
      code: "ACTIVE_CREDENTIAL_DELETE_REQUIRES_SWITCH",
    })
    await store.setActiveSelection(firstCallerHash, second.id)
    expect(await store.delete(first.id)).toBe(true)
  })

  it("clears a caller selection when deleting its only credential", async () => {
    const store = new MemoryByokStore()
    const callerHash = "d".repeat(64)
    const credential = await store.create({ key: "ak-only", provider: "pippit" })
    await store.setActiveSelection(callerHash, credential.id)

    expect(await store.delete(credential.id)).toBe(true)
    expect(await store.getActiveSelection(callerHash)).toBeUndefined()
  })

  it("updates, deletes, enforces the capacity limit, and rejects use after close", async () => {
    const store = new MemoryByokStore({ maxCredentials: 1 })
    const credential = await store.create({ key: "ak-one", provider: "pippit" })
    expect(await store.update(credential.id, { disabled: true, name: "paused" })).toMatchObject({
      disabled: true,
      name: "paused",
    })
    await expect(store.create({ key: "ak-two", provider: "pippit" })).rejects.toMatchObject({
      code: "CREDENTIAL_LIMIT_EXCEEDED",
    })
    expect(await store.delete(credential.id)).toBe(true)
    expect(await store.delete(credential.id)).toBe(false)
    await store.close()
    await expect(store.list()).rejects.toMatchObject({ code: "STORE_CLOSED" })
  })

  it("fails closed before an unbounded key-version history can corrupt the store", async () => {
    const store = new MemoryByokStore()
    const credential = await store.create({ key: "ak-version-0", provider: "pippit" })
    for (let index = 1; index < 100; index += 1) {
      await store.update(credential.id, { key: `ak-version-${index}` })
    }
    await expect(store.update(credential.id, { key: "ak-version-overflow" })).rejects.toMatchObject({
      code: "CREDENTIAL_LIMIT_EXCEEDED",
    })
    const [resolved] = await store.resolveCandidates({
      model: "pippit/seedance-2.0",
      workspaceId: DEFAULT_BYOK_WORKSPACE_ID,
    })
    expect(resolved?.accessKey).toBe("ak-version-99")
  })
})

describe("FileByokStore", () => {
  it("persists an authenticated encrypted envelope with restrictive permissions", async () => {
    const filePath = await temporaryStorePath()
    const masterKey = randomBytes(32)
    const store = await FileByokStore.open({ filePath, masterKey })
    const credential = await store.create({
      key: "ak-file-secret-sentinel",
      name: "secret credential name",
      provider: "pippit",
    })
    const callerHash = "a".repeat(64)
    await store.setActiveSelection(callerHash, credential.id)

    const serialized = await readFile(filePath, "utf8")
    const envelope = JSON.parse(serialized) as Record<string, unknown>
    expect(envelope).toMatchObject({ format: "pippit-byok-store", key_id: "v1", version: 1 })
    expect(Buffer.from(String(envelope.nonce), "base64url")).toHaveLength(12)
    expect(Buffer.from(String(envelope.tag), "base64url")).toHaveLength(16)
    expect(serialized).not.toContain("ak-file-secret-sentinel")
    expect(serialized).not.toContain("secret credential name")
    expect((await stat(filePath)).mode & 0o077).toBe(0)
    await store.close()

    const reopened = await FileByokStore.open({ filePath, masterKey })
    expect(await reopened.get(credential.id)).toEqual(credential)
    expect(await reopened.getActiveSelection(callerHash)).toMatchObject({
      credential_id: credential.id,
      facade_api_key_hash: callerHash,
    })
    const [resolved] = await reopened.resolveCandidates({
      model: "pippit/seedance-2.0",
      workspaceId: DEFAULT_BYOK_WORKSPACE_ID,
    })
    expect(resolved?.accessKey).toBe("ak-file-secret-sentinel")
    await reopened.close()
  })

  it("opens a legacy encrypted store that has no active selection field", async () => {
    const filePath = await temporaryStorePath()
    const masterKey = randomBytes(32)
    const store = await FileByokStore.open({ filePath, masterKey })
    const credential = await store.create({ key: "ak-legacy", provider: "pippit" })
    await store.close()
    await rewriteAsLegacyEnvelopeWithoutActiveSelections(filePath, masterKey)

    const reopened = await FileByokStore.open({ filePath, masterKey })
    expect(await reopened.getActiveSelection("e".repeat(64))).toBeUndefined()
    expect(await reopened.get(credential.id)).toEqual(credential)
    expect(
      (
        await reopened.resolveCandidates({
          model: "pippit/seedance-2.0",
          workspaceId: DEFAULT_BYOK_WORKSPACE_ID,
        })
      ).map((candidate) => candidate.accessKey),
    ).toEqual(["ak-legacy"])
    await reopened.close()
  })

  it("holds an exclusive process lock until close and fails closed on a stale lock", async () => {
    const filePath = await temporaryStorePath()
    const masterKey = randomBytes(32)
    const first = await FileByokStore.open({ filePath, masterKey })
    await expect(FileByokStore.open({ filePath, masterKey })).rejects.toMatchObject({
      code: "STORE_IO_ERROR",
    })
    await first.close()

    const reopened = await FileByokStore.open({ filePath, masterKey })
    await reopened.close()
    await writeFile(`${filePath}.lock`, "stale", { mode: 0o600 })
    await expect(FileByokStore.open({ filePath, masterKey })).rejects.toMatchObject({
      code: "STORE_IO_ERROR",
    })
  })

  it("detects ciphertext tampering, a wrong master key, and an AAD mismatch", async () => {
    const filePath = await temporaryStorePath()
    const masterKey = randomBytes(32)
    const store = await FileByokStore.open({ aadContext: "deployment-one", filePath, masterKey })
    await store.create({ key: "ak-tamper-test", provider: "pippit" })
    await store.close()

    await expect(
      FileByokStore.open({ aadContext: "deployment-one", filePath, masterKey: randomBytes(32) }),
    ).rejects.toMatchObject({ code: "STORE_CORRUPT" })
    await expect(
      FileByokStore.open({ aadContext: "deployment-two", filePath, masterKey }),
    ).rejects.toMatchObject({ code: "STORE_CORRUPT" })

    const envelope = JSON.parse(await readFile(filePath, "utf8")) as { ciphertext: string }
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith("A") ? "B" : "A"}`
    await writeFile(filePath, JSON.stringify(envelope), { mode: 0o600 })
    await expect(
      FileByokStore.open({ aadContext: "deployment-one", filePath, masterKey }),
    ).rejects.toMatchObject({ code: "STORE_CORRUPT" })
  })

  it("serializes concurrent mutations without lost credentials or plaintext temporary files", async () => {
    const filePath = await temporaryStorePath()
    const masterKey = randomBytes(32)
    const store = await FileByokStore.open({ filePath, masterKey, maxCredentials: 20 })

    const credentials = await Promise.all(
      Array.from({ length: 20 }, async (_unused, index) =>
        store.create({ key: `ak-concurrent-${index}`, name: `credential-${index}`, provider: "pippit" }),
      ),
    )
    expect(new Set(credentials.map((credential) => credential.id)).size).toBe(20)
    expect((await store.list()).total_count).toBe(20)
    expect((await readdir(join(filePath, ".."))).filter((file) => file.endsWith(".tmp"))).toEqual([])
    expect(await readFile(filePath, "utf8")).not.toContain("ak-concurrent")
    await store.close()

    const reopened = await FileByokStore.open({ filePath, masterKey, maxCredentials: 20 })
    expect((await reopened.list()).total_count).toBe(20)
    await reopened.close()
  })

  it("keeps the last committed state when a file-size-limited update cannot persist", async () => {
    const filePath = await temporaryStorePath()
    const masterKey = randomBytes(32)
    const store = await FileByokStore.open({ filePath, masterKey, maxFileBytes: 512 })

    await expect(
      store.create({ key: `ak-${"x".repeat(400)}`, name: "oversized", provider: "pippit" }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_LIMIT_EXCEEDED" })
    expect((await store.list()).total_count).toBe(0)
    await store.close()

    const reopened = await FileByokStore.open({ filePath, masterKey, maxFileBytes: 512 })
    expect((await reopened.list()).total_count).toBe(0)
    await reopened.close()
  })

  it("fails closed for corrupt files, symlinks, and overly broad file permissions", async () => {
    const filePath = await temporaryStorePath()
    const masterKey = randomBytes(32)
    await writeFile(filePath, "not-an-encrypted-store", { mode: 0o600 })
    await expect(FileByokStore.open({ filePath, masterKey })).rejects.toMatchObject({
      code: "STORE_CORRUPT",
    })

    const directory = join(filePath, "..")
    const actualPath = join(directory, "actual.json")
    const linkedPath = join(directory, "linked.json")
    await writeFile(actualPath, "not-an-encrypted-store", { mode: 0o600 })
    await symlink(actualPath, linkedPath)
    await expect(FileByokStore.open({ filePath: linkedPath, masterKey })).rejects.toMatchObject({
      code: "STORE_IO_ERROR",
    })

    if (process.platform !== "win32") {
      await chmod(actualPath, 0o644)
      await expect(FileByokStore.open({ filePath: actualPath, masterKey })).rejects.toMatchObject({
        code: "STORE_IO_ERROR",
      })
    }
  })

  it("rewrites a store from a previous master key under the active key id", async () => {
    const filePath = await temporaryStorePath()
    const oldKey = randomBytes(32)
    const newKey = randomBytes(32)
    const oldStore = await FileByokStore.open({ filePath, keyId: "old", masterKey: oldKey })
    await oldStore.create({ key: "ak-rotated-at-rest", provider: "pippit" })
    await oldStore.close()

    const rotated = await FileByokStore.open({
      filePath,
      keyId: "new",
      masterKey: newKey,
      previousMasterKeys: { old: oldKey },
    })
    expect((await rotated.list()).total_count).toBe(1)
    await rotated.close()
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ key_id: "new" })
    await expect(FileByokStore.open({ filePath, keyId: "old", masterKey: oldKey })).rejects.toEqual(
      expect.objectContaining<Partial<ByokStoreError>>({ code: "STORE_CORRUPT" }),
    )
  })
})
