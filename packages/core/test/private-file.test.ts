import { randomUUID } from "node:crypto"
import { renameSync, writeFileSync } from "node:fs"
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  acquirePrivateFileLock,
  atomicReplacePrivateFile,
  createPrivateFileIfAbsent,
  ensurePrivateDirectory,
  PrivateFileError,
  readPrivateFile,
  removePrivateFileIf,
} from "../src/private-file/index.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pippit-private-file-"))
  temporaryDirectories.push(root)
  const path = join(root, "private")
  await ensurePrivateDirectory(path)
  return path
}

describe("private-file primitives", () => {
  it("recovers a dead owned lock and preserves a live lock", async () => {
    const root = await privateRoot()
    const lockPath = join(root, "state.lock")
    await writeFile(lockPath, `${JSON.stringify({
      instanceId: "crashed-instance",
      nonce: randomUUID(),
      pid: 2_147_483_647,
      version: 1,
    })}\n`, { mode: 0o600 })

    const recovered = await acquirePrivateFileLock(lockPath, { retryAttempts: 2, retryDelayMs: 1 })
    expect(recovered.payload.pid).toBe(process.pid)
    await expect(acquirePrivateFileLock(lockPath, { retryAttempts: 1 })).rejects.toMatchObject({
      code: "PRIVATE_FILE_BUSY",
    })
    await recovered.release()
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("waits through a peer's incomplete lock creation window", async () => {
    const root = await privateRoot()
    const lockPath = join(root, "state.lock")
    const peer = await open(lockPath, "wx", 0o600)
    const releasePeer = (async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      await peer.writeFile(`${JSON.stringify({
        instanceId: "peer-instance",
        nonce: randomUUID(),
        pid: process.pid,
        version: 1,
      })}\n`)
      await peer.close()
      await unlink(lockPath)
    })()

    const acquired = await acquirePrivateFileLock(lockPath, { retryAttempts: 20, retryDelayMs: 5 })
    await releasePeer
    await acquired.release()
  })

  it("refuses symlink and hardlink lock recovery", async () => {
    const root = await privateRoot()
    const target = join(root, "target")
    const payload = `${JSON.stringify({
      instanceId: "crashed-instance",
      nonce: randomUUID(),
      pid: 2_147_483_647,
      version: 1,
    })}\n`
    await writeFile(target, payload, { mode: 0o600 })
    const hardlinkPath = join(root, "hard.lock")
    await link(target, hardlinkPath)
    await expect(acquirePrivateFileLock(hardlinkPath, { retryAttempts: 1 })).rejects.toMatchObject({
      code: "PRIVATE_FILE_UNSAFE",
    })
    const symlinkPath = join(root, "symbolic.lock")
    await symlink(target, symlinkPath)
    await expect(acquirePrivateFileLock(symlinkPath, { retryAttempts: 1 })).rejects.toMatchObject({
      code: "PRIVATE_FILE_UNSAFE",
    })
  })

  it("refuses permissive-mode and wrong-owner lock recovery", async () => {
    if (process.platform === "win32") return
    const root = await privateRoot()
    const lockPath = join(root, "state.lock")
    const payload = `${JSON.stringify({
      instanceId: "crashed-instance",
      nonce: randomUUID(),
      pid: 2_147_483_647,
      version: 1,
    })}\n`
    await writeFile(lockPath, payload, { mode: 0o600 })
    await chmod(lockPath, 0o644)
    await expect(acquirePrivateFileLock(lockPath, { retryAttempts: 1 })).rejects.toMatchObject({
      code: "PRIVATE_FILE_UNSAFE",
    })
    await chmod(lockPath, 0o600)

    const actualUid = process.getuid?.()
    if (actualUid === undefined) return
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(actualUid + 1)
    try {
      await expect(acquirePrivateFileLock(lockPath, { retryAttempts: 1 })).rejects.toMatchObject({
        code: "PRIVATE_FILE_UNSAFE",
      })
    } finally {
      getuid.mockRestore()
    }
  })

  it("does not unlink a replacement lock during owned release", async () => {
    const root = await privateRoot()
    const lockPath = join(root, "state.lock")
    const acquired = await acquirePrivateFileLock(lockPath)
    await rm(lockPath)
    const replacement = `${JSON.stringify({
      instanceId: "replacement-instance",
      nonce: randomUUID(),
      pid: process.pid,
      version: 1,
    })}\n`
    await writeFile(lockPath, replacement, { mode: 0o600 })

    await expect(acquired.release()).rejects.toMatchObject({ code: "PRIVATE_FILE_UNSAFE" })
    await expect(readFile(lockPath, "utf8")).resolves.toBe(replacement)
  })

  it("does not unlink a lock whose ownership token changes in place", async () => {
    const root = await privateRoot()
    const lockPath = join(root, "state.lock")
    const acquired = await acquirePrivateFileLock(lockPath)
    const replacement = `${JSON.stringify({
      instanceId: "replacement-instance",
      nonce: randomUUID(),
      pid: process.pid,
      version: 1,
    })}\n`
    await writeFile(lockPath, replacement, { mode: 0o600 })

    await expect(acquired.release()).rejects.toMatchObject({ code: "PRIVATE_FILE_UNSAFE" })
    await expect(readFile(lockPath, "utf8")).resolves.toBe(replacement)
  })

  it("atomically replaces and bounds a private regular file", async () => {
    const root = await privateRoot()
    const path = join(root, "state.json")
    await atomicReplacePrivateFile(path, Buffer.from("secret-state"))
    expect(await readPrivateFile(path, 64)).toEqual(Buffer.from("secret-state"))
    expect((await lstat(path)).mode & 0o777).toBe(0o600)
    await expect(readPrivateFile(path, 4)).rejects.toBeInstanceOf(PrivateFileError)
    expect(await readFile(path, "utf8")).toBe("secret-state")
  })

  it("rejects symlink, hardlink, permissive mode, and owner mismatches when reading", async () => {
    if (process.platform === "win32") return
    const root = await privateRoot()
    const target = join(root, "state.json")
    await writeFile(target, "secret-state", { mode: 0o600 })

    const symbolicPath = join(root, "symbolic.json")
    await symlink(target, symbolicPath)
    await expect(readPrivateFile(symbolicPath, 64)).rejects.toMatchObject({ code: "PRIVATE_FILE_INVALID" })

    const hardlinkPath = join(root, "hardlink.json")
    await link(target, hardlinkPath)
    await expect(readPrivateFile(target, 64)).rejects.toMatchObject({ code: "PRIVATE_FILE_UNSAFE" })
    await unlink(hardlinkPath)

    await chmod(target, 0o644)
    await expect(readPrivateFile(target, 64)).rejects.toMatchObject({ code: "PRIVATE_FILE_UNSAFE" })
    await chmod(target, 0o600)

    const actualUid = process.getuid?.()
    if (actualUid === undefined) return
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(actualUid + 1)
    try {
      await expect(readPrivateFile(target, 64)).rejects.toMatchObject({ code: "PRIVATE_FILE_UNSAFE" })
      await expect(ensurePrivateDirectory(root)).rejects.toMatchObject({ code: "PRIVATE_FILE_UNSAFE" })
    } finally {
      getuid.mockRestore()
    }
  })

  it("creates a private file once without replacing a peer value", async () => {
    const root = await privateRoot()
    const path = join(root, "secret.json")
    await expect(createPrivateFileIfAbsent(path, Buffer.from("first"))).resolves.toBe("created")
    await expect(createPrivateFileIfAbsent(path, Buffer.from("second"))).resolves.toBe("exists")
    expect(await readFile(path, "utf8")).toBe("first")
    expect((await lstat(path)).nlink).toBe(1)
  })

  it("reports durability uncertainty after replace, create, or remove has mutated the pathname", async () => {
    const root = await privateRoot()
    const replacePath = join(root, "replace.json")
    const createPath = join(root, "create.json")
    const removePath = join(root, "remove.json")
    const failDirectorySync = async (): Promise<void> => {
      throw new Error("injected directory sync failure")
    }

    await expect(
      atomicReplacePrivateFile(
        replacePath,
        Buffer.from("replacement"),
        { syncDirectory: failDirectorySync },
      ),
    ).rejects.toMatchObject({ code: "DURABILITY_UNCERTAIN" })
    await expect(readFile(replacePath, "utf8")).resolves.toBe("replacement")

    await expect(
      createPrivateFileIfAbsent(
        createPath,
        Buffer.from("created"),
        { syncDirectory: failDirectorySync },
      ),
    ).rejects.toMatchObject({ code: "DURABILITY_UNCERTAIN" })
    await expect(readFile(createPath, "utf8")).resolves.toBe("created")

    await writeFile(removePath, "removed", { mode: 0o600 })
    await expect(
      removePrivateFileIf(
        removePath,
        64,
        () => true,
        { syncDirectory: failDirectorySync },
      ),
    ).rejects.toMatchObject({ code: "DURABILITY_UNCERTAIN" })
    await expect(lstat(removePath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not unlink a replacement selected during conditional removal", async () => {
    const root = await privateRoot()
    const path = join(root, "ready.json")
    const moved = join(root, "ready.original.json")
    await writeFile(path, "original", { mode: 0o600 })
    await expect(removePrivateFileIf(path, 64, contents => {
      expect(contents.toString("utf8")).toBe("original")
      renameSync(path, moved)
      writeFileSync(path, "replacement", { mode: 0o600 })
      return true
    })).rejects.toMatchObject({ code: "PRIVATE_FILE_UNSAFE" })
    await expect(readFile(path, "utf8")).resolves.toBe("replacement")
  })

  it("rejects a private directory that becomes group-readable", async () => {
    if (process.platform === "win32") return
    const root = await mkdtemp(join(tmpdir(), "pippit-private-mode-"))
    temporaryDirectories.push(root)
    const path = join(root, "private")
    await mkdir(path, { mode: 0o755 })
    await expect(ensurePrivateDirectory(path)).rejects.toMatchObject({ code: "PRIVATE_FILE_UNSAFE" })
  })
})
