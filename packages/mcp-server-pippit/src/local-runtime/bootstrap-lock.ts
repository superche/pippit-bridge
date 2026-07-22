import { randomBytes } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { link, lstat, open, readdir, unlink, type FileHandle } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"
import {
  PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION,
  PippitLocalRuntimeError,
  type BootstrapLockPayload,
  type ByokStoreLockPayload,
} from "./contracts.ts"
import { RUNTIME_VERSION_PATTERN } from "./ready-proof.ts"
import {
  assertPrivateStats,
  currentUid,
  isRecord,
  MAX_STATE_FILE_BYTES,
  openPrivateFile,
  pathExists,
  syncParentDirectory,
} from "./state-files.ts"

const BOOTSTRAP_TIMEOUT_MS = 15_000
const LOCK_STALE_AFTER_MS = 1_000

export interface BootstrapLock { readonly handle: FileHandle; readonly stats: Stats }

function parseLock(value: unknown): BootstrapLockPayload {
  if (!isRecord(value)) throw new PippitLocalRuntimeError("invalid_bootstrap_lock", "Local runtime bootstrap lock is invalid.")
  const candidate = value as Partial<BootstrapLockPayload>
  if (candidate.schema_version !== PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION
    || typeof candidate.pid !== "number" || !Number.isSafeInteger(candidate.pid) || candidate.pid < 1
    || typeof candidate.created_at !== "string" || !Number.isFinite(Date.parse(candidate.created_at))) {
    throw new PippitLocalRuntimeError("invalid_bootstrap_lock", "Local runtime bootstrap lock is invalid.")
  }
  return candidate as BootstrapLockPayload
}

function parseByokStoreLock(value: unknown): ByokStoreLockPayload {
  if (!isRecord(value)) throw new PippitLocalRuntimeError("invalid_byok_lock", "The Pippit BYOK store lock is invalid.")
  const candidate = value as Partial<ByokStoreLockPayload> & {
    readonly created_at?: unknown; readonly instanceId?: unknown; readonly nonce?: unknown; readonly version?: unknown
  }
  const legacy = typeof candidate.created_at === "string" && Number.isFinite(Date.parse(candidate.created_at))
  const owned = candidate.version === 1 && typeof candidate.instanceId === "string" && candidate.instanceId.length > 0
    && typeof candidate.nonce === "string" && /^[0-9a-f-]{36}$/u.test(candidate.nonce)
  if (typeof candidate.pid !== "number" || !Number.isSafeInteger(candidate.pid) || candidate.pid < 1 || (!legacy && !owned)) {
    throw new PippitLocalRuntimeError("invalid_byok_lock", "The Pippit BYOK store lock is invalid.")
  }
  return candidate as ByokStoreLockPayload
}

export function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH" }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

export function compareRuntimeVersions(left: string, right: string): number {
  const leftParts = RUNTIME_VERSION_PATTERN.exec(left)
  const rightParts = RUNTIME_VERSION_PATTERN.exec(right)
  if (leftParts === null || rightParts === null) {
    throw new PippitLocalRuntimeError("invalid_runtime_version", "The local Pippit Facade runtime version is invalid.")
  }
  for (let index = 1; index <= 3; index += 1) {
    const leftPart = BigInt(leftParts[index] ?? "0")
    const rightPart = BigInt(rightParts[index] ?? "0")
    if (leftPart < rightPart) return -1
    if (leftPart > rightPart) return 1
  }
  return 0
}

function assertBootstrapLockStats(stats: Stats, label: string): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new PippitLocalRuntimeError("unsafe_state_path", `${label} must be a real file.`)
  }
  const uid = currentUid()
  if (uid !== undefined && stats.uid !== uid) {
    throw new PippitLocalRuntimeError("unsafe_state_owner", `${label} must be owned by the current user.`)
  }
  if (stats.nlink !== 1 && stats.nlink !== 2) {
    throw new PippitLocalRuntimeError("unsafe_state_link", `${label} has an unexpected hard-link count.`)
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new PippitLocalRuntimeError("unsafe_state_permissions", `${label} permissions must not grant access to group or other users.`)
  }
  if (stats.size > MAX_STATE_FILE_BYTES) {
    throw new PippitLocalRuntimeError("state_file_too_large", `${label} is unexpectedly large.`)
  }
}

async function findBootstrapLockCandidate(path: string, expected: Stats): Promise<string | undefined> {
  if (expected.nlink === 1) return undefined
  const candidatePrefix = `${basename(path)}.candidate-`
  const matchingCandidates: string[] = []
  for (const entry of await readdir(dirname(path), { withFileTypes: true })) {
    if (!entry.name.startsWith(candidatePrefix)) continue
    const candidatePath = join(dirname(path), entry.name)
    let candidateStats: Stats
    try { candidateStats = await lstat(candidatePath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    if (!sameFile(candidateStats, expected)) continue
    assertBootstrapLockStats(candidateStats, "Local runtime bootstrap lock candidate")
    matchingCandidates.push(candidatePath)
  }
  if (matchingCandidates.length > 1) {
    throw new PippitLocalRuntimeError("unsafe_bootstrap_lock_link", "The Pippit local runtime bootstrap lock has multiple candidate hard links.")
  }
  return matchingCandidates[0]
}

export async function removeFileIfUnchanged(path: string, expected: Stats): Promise<void> {
  const current = await lstat(path)
  assertPrivateStats(current, "Local runtime state file", "file")
  if (!sameFile(current, expected)) {
    throw new PippitLocalRuntimeError("state_file_changed", "Local runtime state changed during bootstrap.")
  }
  await unlink(path)
  await syncParentDirectory(path)
}

async function readLock(path: string): Promise<{ readonly payload: BootstrapLockPayload; readonly stats: Stats }> {
  let handle: FileHandle
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PippitLocalRuntimeError("state_file_missing", "Local runtime bootstrap lock no longer exists.")
    }
    throw new PippitLocalRuntimeError("state_file_unavailable", "Local runtime bootstrap lock is unavailable.")
  }
  try {
    const stats = await handle.stat()
    if (stats.nlink === 0) throw new PippitLocalRuntimeError("state_file_missing", "Local runtime bootstrap lock was released while being inspected.")
    assertBootstrapLockStats(stats, "Local runtime bootstrap lock")
    const payload = parseLock(JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown)
    return { payload, stats }
  } catch (error) {
    if (error instanceof PippitLocalRuntimeError) throw error
    throw new PippitLocalRuntimeError("invalid_bootstrap_lock", "Local runtime bootstrap lock is invalid.")
  } finally { await handle.close() }
}

async function removeSingleLinkBootstrapLockIfUnchanged(path: string, expected: Stats): Promise<boolean> {
  let current: Stats
  try { current = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
  if (!sameFile(current, expected)) return false
  assertBootstrapLockStats(current, "Local runtime bootstrap lock")
  if (current.nlink !== 1) {
    throw new PippitLocalRuntimeError("unsafe_bootstrap_lock_link", "The Pippit local runtime bootstrap lock has an unrecognized hard link.")
  }
  try { await unlink(path); await syncParentDirectory(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function removeStaleBootstrapLock(path: string, existing: Awaited<ReturnType<typeof readLock>>): Promise<boolean> {
  const candidatePath = await findBootstrapLockCandidate(path, existing.stats)
  if (candidatePath !== undefined) {
    let candidateStats: Stats
    try { candidateStats = await lstat(candidatePath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return removeSingleLinkBootstrapLockIfUnchanged(path, existing.stats)
      throw error
    }
    assertBootstrapLockStats(candidateStats, "Local runtime bootstrap lock candidate")
    if (!sameFile(candidateStats, existing.stats)) {
      return removeSingleLinkBootstrapLockIfUnchanged(path, existing.stats)
    }
    if (candidateStats.nlink === 1) {
      const removedLock = await removeSingleLinkBootstrapLockIfUnchanged(path, existing.stats)
      if (removedLock) return true
      const currentCandidate = await lstat(candidatePath).catch(() => undefined)
      if (currentCandidate !== undefined && sameFile(currentCandidate, candidateStats) && currentCandidate.nlink === 1) {
        await unlink(candidatePath)
        await syncParentDirectory(candidatePath)
      }
      return false
    }
    try { await unlink(candidatePath); await syncParentDirectory(candidatePath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return removeSingleLinkBootstrapLockIfUnchanged(path, existing.stats)
}

export async function acquireBootstrapLock(path: string): Promise<BootstrapLock> {
  const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const candidatePath = `${path}.candidate-${process.pid}-${randomBytes(8).toString("hex")}`
    let candidateHandle: FileHandle | undefined
    let candidateStats: Stats | undefined
    try {
      candidateHandle = await open(candidatePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      const payload: BootstrapLockPayload = {
        created_at: new Date().toISOString(), pid: process.pid, schema_version: PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION,
      }
      await candidateHandle.writeFile(`${JSON.stringify(payload)}\n`, { encoding: "utf8" })
      await candidateHandle.sync()
      candidateStats = await candidateHandle.stat()
      try { await link(candidatePath, path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        await candidateHandle.close(); candidateHandle = undefined; await unlink(candidatePath)
        let existing: Awaited<ReturnType<typeof readLock>>
        try { existing = await readLock(path) } catch (readError) {
          if (readError instanceof PippitLocalRuntimeError && readError.code === "state_file_missing") continue
          throw readError
        }
        const age = Date.now() - Date.parse(existing.payload.created_at)
        if (!processIsAlive(existing.payload.pid) && age >= LOCK_STALE_AFTER_MS) {
          await removeStaleBootstrapLock(path, existing); continue
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 50)); continue
      }
      await unlink(candidatePath); await syncParentDirectory(path)
      return { handle: candidateHandle, stats: candidateStats }
    } catch (error) {
      await candidateHandle?.close().catch(() => undefined)
      await unlink(candidatePath).catch(() => undefined)
      if (candidateStats !== undefined) {
        try {
          const current = await lstat(path)
          if (sameFile(current, candidateStats)) { await unlink(path); await syncParentDirectory(path) }
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new PippitLocalRuntimeError("bootstrap_lock_cleanup_failed", "The Pippit local runtime bootstrap lock could not be cleaned up safely.")
          }
        }
      }
      throw error
    }
  }
  throw new PippitLocalRuntimeError("bootstrap_lock_timeout", "Another Pippit local runtime bootstrap is still in progress.")
}

export async function releaseBootstrapLock(path: string, lock: BootstrapLock): Promise<void> {
  await lock.handle.close()
  try { await removeFileIfUnchanged(path, lock.stats) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

export async function removeStalePippitByokLockForDaemon(lockPath: string): Promise<void> {
  if (!isAbsolute(lockPath)) {
    throw new PippitLocalRuntimeError("invalid_byok_lock_path", "The Pippit BYOK lock path must be absolute.")
  }
  if (!(await pathExists(lockPath))) return
  const handle = await openPrivateFile(lockPath, "Pippit BYOK store lock")
  let payload: ByokStoreLockPayload
  let stats: Stats
  try {
    stats = await handle.stat()
    payload = parseByokStoreLock(JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown)
  } catch (error) {
    if (error instanceof PippitLocalRuntimeError) throw error
    throw new PippitLocalRuntimeError("invalid_byok_lock", "The Pippit BYOK store lock is invalid.")
  } finally { await handle.close() }
  if (processIsAlive(payload.pid)) return
  await removeFileIfUnchanged(lockPath, stats)
}
