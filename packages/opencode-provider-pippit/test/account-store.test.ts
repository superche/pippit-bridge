import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  FilePippitAccountStore,
  MemoryPippitAccountStore,
  PippitAccountManager,
  normalizeAccountName,
  storedAuthFingerprint,
} from "../src/account-store.js"
import { PIPPIT_MANAGED_AUTH_SENTINEL, normalizeAccessKey } from "../src/access-key.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

function auth(key: string, accountName: string) {
  return { key, metadata: { account_name: accountName }, type: "api" } as const
}

describe("PippitAccountManager", () => {
  it("uses configure as a pending handoff and imports a new /connect secret", async () => {
    const manager = new PippitAccountManager(new MemoryPippitAccountStore())
    const previous = auth("ak-previous-account-secret", "Previous")

    await manager.beginConfiguration("工作账号", previous)
    await expect(manager.reconcile(previous)).resolves.toBeUndefined()
    expect(await manager.list()).toMatchObject({ accounts: [], pendingAccountName: "工作账号" })

    const imported = await manager.reconcile(auth("ak-work-account-secret", "Ignored prompt name"))
    expect(imported).toMatchObject({ active: true, maskedAccessKey: "ak-****cret", name: "工作账号" })
    expect(await manager.resolveActive()).toMatchObject({
      accessKey: "ak-work-account-secret",
      accountName: "工作账号",
    })
  })

  it("keeps multiple accounts, switches explicitly, and never lists raw AKs", async () => {
    const manager = new PippitAccountManager(new MemoryPippitAccountStore())
    const first = await manager.reconcile(auth("ak-first-account-secret", "工作"))
    const second = await manager.reconcile(auth("ak-second-account-secret", "个人"))
    if (first === undefined || second === undefined) throw new Error("Expected imported accounts")

    const listed = await manager.list()
    expect(listed.accounts).toHaveLength(2)
    expect(listed.activeAccountId).toBe(second.id)
    expect(JSON.stringify(listed)).not.toContain("ak-first-account-secret")
    expect(JSON.stringify(listed)).not.toContain("ak-second-account-secret")

    await expect(manager.switchAccount({ accountName: "工作" })).resolves.toMatchObject({
      active: true,
      id: first.id,
    })
    await expect(manager.deleteAccount({ accountId: first.id })).rejects.toThrow(
      "Switch to another Pippit account",
    )
    await manager.switchAccount({ accountId: second.id })
    await manager.deleteAccount({ accountId: first.id })
    await manager.deleteAccount({ accountId: second.id })
    await expect(manager.resolveActive()).resolves.toBeUndefined()
  })

  it("rotates a named account without creating a duplicate", async () => {
    const manager = new PippitAccountManager(new MemoryPippitAccountStore())
    const original = await manager.reconcile(auth("ak-original-account-secret", "工作"))
    const rotated = await manager.reconcile(auth("ak-rotated-account-secret", "工作"))
    if (original === undefined || rotated === undefined) throw new Error("Expected imported accounts")

    expect(rotated.id).toBe(original.id)
    expect((await manager.list()).accounts).toHaveLength(1)
    await expect(manager.resolveActive()).resolves.toMatchObject({
      accessKey: "ak-rotated-account-secret",
      accountId: original.id,
    })
  })

  it("uses the last observed auth marker as the baseline when the getter is temporarily unavailable", async () => {
    const manager = new PippitAccountManager(new MemoryPippitAccountStore())
    const storedAuth = auth("ak-reused-marker-secret", "Original")
    const original = await manager.reconcile(storedAuth)
    if (original === undefined) throw new Error("Expected imported account")

    await manager.beginConfiguration("Renamed", undefined)
    await expect(manager.reconcile(storedAuth)).resolves.toBeUndefined()

    expect(await manager.list()).toMatchObject({
      accounts: [{ id: original.id, name: "Original" }],
      pendingAccountName: "Renamed",
    })
  })

  it("pins an existing run to its original account across active-account switches", async () => {
    const manager = new PippitAccountManager(new MemoryPippitAccountStore())
    const first = await manager.reconcile(auth("ak-first-run-account-secret", "工作"))
    if (first === undefined) throw new Error("Expected first account")
    await manager.bindRun("run-1", "thread-1", first.id)
    const second = await manager.reconcile(auth("ak-second-run-account-secret", "个人"))
    if (second === undefined) throw new Error("Expected second account")

    await expect(manager.resolveForRun("run-1", "thread-1")).resolves.toMatchObject({
      accessKey: "ak-first-run-account-secret",
      accountId: first.id,
    })
    await manager.deleteAccount({ accountId: first.id })
    await expect(manager.resolveForRun("run-1", "thread-1")).rejects.toThrow(
      "used for this run was deleted",
    )
  })

  it("restores a deleted account id and its old run bindings when the same AK is re-imported", async () => {
    const manager = new PippitAccountManager(new MemoryPippitAccountStore())
    const storedAuth = auth("ak-restored-account-secret", "Original")
    const original = await manager.reconcile(storedAuth)
    if (original === undefined) throw new Error("Expected imported account")
    await manager.bindRun("run-restored", "thread-restored", original.id)

    await expect(manager.deleteAccount({ accountId: original.id })).resolves.toMatchObject({
      boundRunCount: 1,
    })
    await expect(manager.resolveForRun("run-restored", "thread-restored")).rejects.toThrow(
      "used for this run was deleted",
    )

    await manager.beginConfiguration("Restored", undefined)
    const restored = await manager.reconcile(storedAuth)

    expect(restored).toMatchObject({ id: original.id, name: "Restored" })
    await expect(manager.resolveForRun("run-restored", "thread-restored")).resolves.toMatchObject({
      accessKey: "ak-restored-account-secret",
      accountId: original.id,
      accountName: "Restored",
    })
  })

  it("returns only persisted run bindings and inspects accounts without exposing their AK", async () => {
    const manager = new PippitAccountManager(new MemoryPippitAccountStore())
    const firstAuth = auth("ak-inspected-account-secret", "工作")
    const first = await manager.reconcile(firstAuth)
    const second = await manager.reconcile(auth("ak-other-account-secret", "个人"))
    if (first === undefined || second === undefined) throw new Error("Expected imported accounts")
    await manager.bindRun("run-inspected-1", "thread-inspected", first.id)
    await manager.bindRun("run-inspected-2", "thread-inspected", first.id)

    await expect(manager.resolveForRun("run-unbound", "thread-unbound")).resolves.toBeUndefined()
    const inspection = await manager.inspectAccount({ accountId: first.id }, { validateDelete: true })
    expect(inspection).toMatchObject({
      account: { active: false, id: first.id, maskedAccessKey: "ak-****cret", name: "工作" },
      boundRunCount: 2,
      fingerprint: storedAuthFingerprint(firstAuth),
    })
    expect(JSON.stringify(inspection)).not.toContain("ak-inspected-account-secret")
    await expect(
      manager.inspectAccount({ accountId: second.id }, { validateDelete: true }),
    ).rejects.toThrow("Switch to another Pippit account")
    await expect(
      manager.inspectAccount({ accountId: first.id, accountName: "工作" }),
    ).rejects.toThrow("Provide exactly one")
  })

  it("does not treat the managed OpenCode sentinel as an Access Key", () => {
    expect(storedAuthFingerprint({ key: PIPPIT_MANAGED_AUTH_SENTINEL, type: "api" })).toBeUndefined()
    expect(() => normalizeAccessKey(PIPPIT_MANAGED_AUTH_SENTINEL)).toThrow("supported format")
  })

  it("normalizes account names to NFC and rejects invisible Unicode controls", () => {
    expect(normalizeAccountName("  Cafe\u0301  ")).toBe("Caf\u00e9")
    for (const name of ["zero\u200bwidth", "right-to-left\u202ename", "line\u2028separator"]) {
      expect(() => normalizeAccountName(name)).toThrow("visible characters")
    }
  })
})

describe("FilePippitAccountStore", () => {
  it("serializes concurrent imports from independent stores without lock or temp residue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pippit-opencode-accounts-"))
    temporaryDirectories.push(directory)
    const privateDirectory = join(directory, "private")
    const filePath = join(privateDirectory, "access-keys.json")
    const firstManager = new PippitAccountManager(new FilePippitAccountStore(filePath))
    const secondManager = new PippitAccountManager(new FilePippitAccountStore(filePath))

    await Promise.all(
      Array.from({ length: 12 }, async (_value, index) => {
        const manager = index % 2 === 0 ? firstManager : secondManager
        return manager.reconcile(auth(`ak-concurrent-account-${index}-secret`, `account-${index}`))
      }),
    )

    expect((await firstManager.list()).accounts).toHaveLength(12)
    expect((await secondManager.list()).accounts).toHaveLength(12)
    expect((await stat(privateDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    expect((await readdir(privateDirectory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([])
    expect((await readdir(privateDirectory)).filter((entry) => entry.endsWith(".lock"))).toEqual([])
    expect(await readFile(filePath, "utf8")).not.toContain(".tmp")

    const reopened = new PippitAccountManager(new FilePippitAccountStore(filePath))
    expect((await reopened.list()).accounts).toHaveLength(12)
  })

  it("persists a valid maximum-size run binding set larger than the former 1 MiB limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pippit-opencode-large-accounts-"))
    temporaryDirectories.push(directory)
    const filePath = join(directory, "private", "access-keys.json")
    const store = new FilePippitAccountStore(filePath)
    const manager = new PippitAccountManager(store)
    const account = await manager.reconcile(auth("ak-large-store-secret", "large"))
    if (account === undefined) throw new Error("Expected imported account")

    await store.update((state) => ({
      result: undefined,
      state: {
        ...state,
        revision: state.revision + 1,
        run_bindings: Array.from({ length: 1_000 }, (_value, index) => ({
          account_id: account.id,
          created_at: "2026-07-18T00:00:00.000Z",
          run_id: `run-${index}-`.padEnd(512, "r"),
          thread_id: `thread-${index}-`.padEnd(512, "t"),
        })),
      },
    }))

    expect((await stat(filePath)).size).toBeGreaterThan(1024 * 1024)
    expect((await store.read()).run_bindings).toHaveLength(1_000)
  })
})
