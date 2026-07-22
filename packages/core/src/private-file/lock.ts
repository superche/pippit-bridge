import { randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, open, unlink, type FileHandle } from "node:fs/promises"
import { PrivateFileError } from "./errors.js"

const MAX_LOCK_BYTES = 4_096

export interface PrivateLockPayload {
  readonly instanceId: string
  readonly nonce: string
  readonly pid: number
  readonly version: 1
}

export interface OwnedPrivateFileLock {
  readonly path: string
  readonly payload: PrivateLockPayload
  release(): Promise<void>
}

export interface PrivateFileLockOptions {
  readonly instanceId?: string
  readonly retryAttempts?: number
  readonly retryDelayMs?: number
}

function nodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function sameFile(first: Pick<Stats, "dev" | "ino">, second: Pick<Stats, "dev" | "ino">): boolean {
  return first.dev === second.dev && first.ino === second.ino
}

function ownerIsAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return nodeError(error, "EPERM")
  }
}

function parsePayload(value: unknown): PrivateLockPayload {
  if (
    typeof value !== "object"
    || value === null
    || !("version" in value)
    || value.version !== 1
    || !("pid" in value)
    || !Number.isSafeInteger(value.pid)
    || Number(value.pid) <= 0
    || !("instanceId" in value)
    || typeof value.instanceId !== "string"
    || value.instanceId.length < 1
    || !("nonce" in value)
    || typeof value.nonce !== "string"
    || !/^[0-9a-f-]{36}$/u.test(value.nonce)
  ) {
    throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private lock payload is invalid.")
  }
  return value as PrivateLockPayload
}

function parseRecoveryPid(value: unknown): number {
  try {
    return parsePayload(value).pid
  } catch (error) {
    if (
      typeof value === "object"
      && value !== null
      && "pid" in value
      && Number.isSafeInteger(value.pid)
      && Number(value.pid) > 0
      && "created_at" in value
      && typeof value.created_at === "number"
      && Number.isFinite(value.created_at)
    ) return Number(value.pid)
    throw error
  }
}

async function validateLockHandle(handle: FileHandle): Promise<Stats> {
  const metadata = await handle.stat()
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > MAX_LOCK_BYTES) {
    throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private lock metadata is unsafe.")
  }
  if (process.platform !== "win32") {
    if ((metadata.mode & 0o077) !== 0 || (process.getuid !== undefined && metadata.uid !== process.getuid())) {
      throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private lock permissions or owner are unsafe.")
    }
  }
  return metadata
}

async function currentOwnedPath(path: string, owned: Pick<Stats, "dev" | "ino">): Promise<Stats> {
  const current = await lstat(path)
  const unsafeOwner = process.platform !== "win32" && (
    (current.mode & 0o077) !== 0
    || (process.getuid !== undefined && current.uid !== process.getuid())
  )
  if (
    !current.isFile()
    || current.isSymbolicLink()
    || current.nlink !== 1
    || unsafeOwner
    || !sameFile(owned, current)
  ) {
    throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private lock ownership changed.")
  }
  return current
}

async function cleanupFailedAcquisition(path: string, handle: FileHandle): Promise<void> {
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1) return
    await currentOwnedPath(path, opened)
    await currentOwnedPath(path, opened)
    await unlink(path)
  } catch {
    // A failed acquisition must never remove an unverified pathname.
  }
}

async function recoverDeadOwner(path: string): Promise<boolean> {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (nodeError(error, "ENOENT")) return true
    throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private lock could not be inspected.")
  }
  try {
    const opened = await validateLockHandle(handle)
    const ownerPid = parseRecoveryPid(JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown)
    if (ownerIsAlive(ownerPid)) return false
    await currentOwnedPath(path, opened).catch(() => {
      throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private lock changed during stale-owner recovery.")
    })
    await currentOwnedPath(path, opened).catch(() => {
      throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private lock changed during stale-owner recovery.")
    })
    await unlink(path)
    return true
  } catch (error) {
    if (nodeError(error, "ENOENT")) return true
    if (error instanceof PrivateFileError) throw error
    throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private lock payload is malformed.")
  } finally {
    await handle.close()
  }
}

async function releaseOwnedLock(path: string, handle: FileHandle, owned: Stats, payload: PrivateLockPayload): Promise<void> {
  try {
    await currentOwnedPath(path, owned).catch(() => {
      throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private lock ownership changed before release.")
    })
    const verification = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const verified = await validateLockHandle(verification)
      if (!sameFile(owned, verified)) {
        throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private lock ownership changed before release.")
      }
      const currentPayload = parsePayload(JSON.parse(await verification.readFile({ encoding: "utf8" })) as unknown)
      if (currentPayload.nonce !== payload.nonce || currentPayload.instanceId !== payload.instanceId) {
        throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private lock ownership token changed before release.")
      }
    } finally {
      await verification.close()
    }
    await currentOwnedPath(path, owned).catch(() => {
      throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private lock ownership changed before release.")
    })
    await unlink(path)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function acquirePrivateFileLock(
  path: string,
  options: PrivateFileLockOptions = {},
): Promise<OwnedPrivateFileLock> {
  const retryAttempts = options.retryAttempts ?? 40
  const retryDelayMs = options.retryDelayMs ?? 25
  const payload: PrivateLockPayload = {
    instanceId: options.instanceId ?? randomUUID(),
    nonce: randomUUID(),
    pid: process.pid,
    version: 1,
  }
  for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
    let handle: FileHandle
    try {
      handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      if (!nodeError(error, "EEXIST")) {
        throw new PrivateFileError("PRIVATE_FILE_BUSY", "Private file lock could not be acquired.")
      }
      try {
        if (await recoverDeadOwner(path)) {
          attempt -= 1
          continue
        }
      } catch (recoveryError) {
        if (
          !(recoveryError instanceof PrivateFileError)
          || recoveryError.code !== "PRIVATE_FILE_UNSAFE"
          || attempt === retryAttempts - 1
        ) throw recoveryError
        // A peer owns the pathname as soon as O_EXCL succeeds, before its payload write is
        // necessarily visible. Retry boundedly so a zero-byte or partial payload in that
        // creation window is not misclassified as a persistent unsafe lock. A stable unsafe
        // pathname is still rejected on the final attempt and is never removed here.
        await new Promise(resolve => setTimeout(resolve, retryDelayMs))
        continue
      }
      if (attempt === retryAttempts - 1) {
        throw new PrivateFileError("PRIVATE_FILE_BUSY", "Private file is busy in another process.")
      }
      await new Promise(resolve => setTimeout(resolve, retryDelayMs))
      continue
    }
    try {
      await handle.writeFile(`${JSON.stringify(payload)}\n`)
      await handle.sync()
      const owned = await validateLockHandle(handle)
      return {
        path,
        payload,
        release: () => releaseOwnedLock(path, handle, owned, payload),
      }
    } catch (error) {
      await cleanupFailedAcquisition(path, handle)
      await handle.close().catch(() => undefined)
      throw error
    }
  }
  throw new PrivateFileError("PRIVATE_FILE_BUSY", "Private file is busy in another process.")
}
