import { randomUUID } from "node:crypto"
import { chmod, link, mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  FilePippitAccountStore,
  MemoryPippitAccountStore,
  PippitAccountManager,
  normalizeAccountName,
} from "../src/account-store.js"
import { normalizeAccessKey } from "../src/access-key.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("PippitAccountManager", () => {
  it("adds a key directly to the private account store without exposing it in summaries", async () => {
    const manager = new PippitAccountManager(new MemoryPippitAccountStore())

    const added = await manager.addAccount("工作账号", "ak-work-account-secret")

    expect(added).toMatchObject({ active: true, maskedAccessKey: "ak-****cret", name: "工作账号" })
    expect(JSON.stringify(await manager.list())).not.toContain("ak-work-account-secret")
    await expect(manager.resolveActive()).resolves.toMatchObject({
      accessKey: "ak-work-account-secret",
      accountName: "工作账号",
    })
  })

  it("keeps multiple accounts, switches explicitly, and never lists raw AKs", async () => {
    const manager = new PippitAccountManager(new MemoryPippitAccountStore())
    const first = await manager.addAccount("工作", "ak-first-account-secret")
    const second = await manager.addAccount("个人", "ak-second-account-secret")

    const listed = await manager.list()
    expect(listed.accounts).toHaveLength(2)
    expect(listed.activeAccountId).toBe(second.id)
    expect(JSON.stringify(listed)).not.toContain("ak-first-account-secret")
    expect(JSON.stringify(listed)).not.toContain("ak-second-account-secret")

    await expect(manager.switchAccount({ accountName: "工作" })).resolves.toMatchObject({ active: true, id: first.id })
    await expect(manager.deleteAccount({ accountId: first.id })).rejects.toThrow("Switch to another Pippit account")
    await manager.switchAccount({ accountId: second.id })
    await manager.deleteAccount({ accountId: first.id })
    await manager.deleteAccount({ accountId: second.id })
    await expect(manager.resolveActive()).resolves.toBeUndefined()
  })

  it("rotates a named account without creating a duplicate", async () => {
    const manager = new PippitAccountManager(new MemoryPippitAccountStore())
    const original = await manager.addAccount("工作", "ak-original-account-secret")
    const rotated = await manager.addAccount("工作", "ak-rotated-account-secret")

    expect(rotated.id).toBe(original.id)
    expect((await manager.list()).accounts).toHaveLength(1)
    await expect(manager.resolveActive()).resolves.toMatchObject({
      accessKey: "ak-rotated-account-secret",
      accountId: original.id,
    })
  })

  it("pins an existing run to its original account across active-account switches", async () => {
    const manager = new PippitAccountManager(new MemoryPippitAccountStore())
    const first = await manager.addAccount("工作", "ak-first-run-account-secret")
    await manager.bindRun("run-1", "thread-1", first.id)
    await manager.addAccount("个人", "ak-second-run-account-secret")

    await expect(manager.resolveForRun("run-1", "thread-1")).resolves.toMatchObject({
      accessKey: "ak-first-run-account-secret",
      accountId: first.id,
    })
    await manager.deleteAccount({ accountId: first.id })
    await expect(manager.resolveForRun("run-1", "thread-1")).rejects.toThrow("used for this run was deleted")
  })

  it("restores a deleted account id and its old run bindings when the same AK is added again", async () => {
    const manager = new PippitAccountManager(new MemoryPippitAccountStore())
    const original = await manager.addAccount("Original", "ak-restored-account-secret")
    await manager.bindRun("run-restored", "thread-restored", original.id)
    await manager.deleteAccount({ accountId: original.id })

    const restored = await manager.addAccount("Restored", "ak-restored-account-secret")

    expect(restored).toMatchObject({ id: original.id, name: "Restored" })
    await expect(manager.resolveForRun("run-restored", "thread-restored")).resolves.toMatchObject({
      accessKey: "ak-restored-account-secret",
      accountId: original.id,
      accountName: "Restored",
    })
  })

  it("inspects accounts without exposing their AK", async () => {
    const manager = new PippitAccountManager(new MemoryPippitAccountStore())
    const first = await manager.addAccount("工作", "ak-inspected-account-secret")
    const second = await manager.addAccount("个人", "ak-other-account-secret")
    await manager.bindRun("run-inspected-1", "thread-inspected", first.id)
    await manager.bindRun("run-inspected-2", "thread-inspected", first.id)

    const inspection = await manager.inspectAccount({ accountId: first.id }, { validateDelete: true })
    expect(inspection).toMatchObject({
      account: { active: false, id: first.id, maskedAccessKey: "ak-****cret", name: "工作" },
      boundRunCount: 2,
    })
    expect(JSON.stringify(inspection)).not.toContain("ak-inspected-account-secret")
    await expect(manager.inspectAccount({ accountId: second.id }, { validateDelete: true })).rejects.toThrow(
      "Switch to another Pippit account",
    )
  })

  it("normalizes account names and validates key format", () => {
    expect(normalizeAccountName("  Cafe\u0301  ")).toBe("Caf\u00e9")
    for (const name of ["zero\u200bwidth", "right-to-left\u202ename", "line\u2028separator"]) {
      expect(() => normalizeAccountName(name)).toThrow("visible characters")
    }
    expect(() => normalizeAccessKey("contains spaces")).toThrow("supported format")
  })
})

describe("FilePippitAccountStore", () => {
  it("recovers a transaction lock left by a crashed process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pippit-opencode-crashed-lock-"))
    temporaryDirectories.push(directory)
    const privateDirectory = join(directory, "private")
    const filePath = join(privateDirectory, "access-keys.json")
    await mkdir(privateDirectory, { mode: 0o700 })
    await writeFile(`${filePath}.lock`, `${JSON.stringify({
      instanceId: "crashed-opencode-process",
      nonce: randomUUID(),
      pid: 2_147_483_647,
      version: 1,
    })}\n`, { mode: 0o600 })

    const manager = new PippitAccountManager(new FilePippitAccountStore(filePath))
    await expect(manager.addAccount("recovered", "ak-recovered-after-crash-secret")).resolves.toMatchObject({
      active: true,
      name: "recovered",
    })
    await expect(stat(`${filePath}.lock`)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("serializes concurrent additions without lock or temp residue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pippit-opencode-accounts-"))
    temporaryDirectories.push(directory)
    const privateDirectory = join(directory, "private")
    const filePath = join(privateDirectory, "access-keys.json")
    const firstManager = new PippitAccountManager(new FilePippitAccountStore(filePath))
    const secondManager = new PippitAccountManager(new FilePippitAccountStore(filePath))

    await Promise.all(
      Array.from({ length: 12 }, async (_value, index) => {
        const manager = index % 2 === 0 ? firstManager : secondManager
        return manager.addAccount(`account-${index}`, `ak-concurrent-account-${index}-secret`)
      }),
    )

    expect((await firstManager.list()).accounts).toHaveLength(12)
    expect((await secondManager.list()).accounts).toHaveLength(12)
    expect((await stat(privateDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    expect((await readdir(privateDirectory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([])
    expect((await readdir(privateDirectory)).filter((entry) => entry.endsWith(".lock"))).toEqual([])
  })

  it("maps shared bounded-read safety failures to the account-store domain error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pippit-opencode-unsafe-accounts-"))
    temporaryDirectories.push(directory)
    const privateDirectory = join(directory, "private")
    const filePath = join(privateDirectory, "access-keys.json")
    const store = new FilePippitAccountStore(filePath)
    await new PippitAccountManager(store).addAccount("safe", "ak-safe-account-secret")

    if (process.platform !== "win32") {
      await chmod(filePath, 0o644)
      await expect(store.read()).rejects.toThrow("The Pippit account store could not be opened.")
      await chmod(filePath, 0o600)
    }

    const hardlinkPath = join(privateDirectory, "hardlink.json")
    await link(filePath, hardlinkPath)
    await expect(store.read()).rejects.toThrow("The Pippit account store could not be opened.")

    const symlinkPath = join(privateDirectory, "symlink.json")
    await symlink(filePath, symlinkPath)
    await expect(new FilePippitAccountStore(symlinkPath).read()).rejects.toThrow(
      "The Pippit account store could not be opened.",
    )
  })

  it("migrates the auth-slot fields out of a v1 store on the next write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pippit-opencode-v1-accounts-"))
    temporaryDirectories.push(directory)
    const privateDirectory = join(directory, "private")
    const filePath = join(privateDirectory, "access-keys.json")
    await mkdir(privateDirectory, { mode: 0o700 })
    await writeFile(filePath, JSON.stringify({
      accounts: [],
      active_account_id: null,
      format: "pippit-opencode-account-store",
      last_seen_auth_marker: null,
      pending_configuration: null,
      revision: 0,
      run_bindings: [],
      tombstones: [],
      version: 1,
    }), { mode: 0o600 })
    const manager = new PippitAccountManager(new FilePippitAccountStore(filePath))

    await manager.addAccount("migrated", "ak-migrated-account-secret")

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>
    expect(persisted.version).toBe(2)
    expect(persisted).not.toHaveProperty("last_seen_auth_marker")
    expect(persisted).not.toHaveProperty("pending_configuration")
  })

  it("persists a valid maximum-size run binding set larger than 1 MiB", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pippit-opencode-large-accounts-"))
    temporaryDirectories.push(directory)
    const filePath = join(directory, "private", "access-keys.json")
    const store = new FilePippitAccountStore(filePath)
    const manager = new PippitAccountManager(store)
    const account = await manager.addAccount("large", "ak-large-store-secret")

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
