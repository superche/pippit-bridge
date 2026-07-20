import { spawn } from "node:child_process"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { constants, type Stats } from "node:fs"
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defaultPippitOutputDirectory } from "./options.ts"

export const PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION = 1
// Advance only when the bundled daemon changes; the package/plugin version may move independently.
export const PIPPIT_LOCAL_RUNTIME_VERSION = "0.2.5"

const CONFIG_FILE_NAME = "runtime-secrets.json"
const READY_FILE_NAME = "facade-ready.json"
const LOCK_FILE_NAME = "bootstrap.lock"
const MAX_STATE_FILE_BYTES = 64 * 1024
const BOOTSTRAP_TIMEOUT_MS = 15_000
const LOCK_STALE_AFTER_MS = 1_000
const PROOF_TIMEOUT_MS = 1_500
const INCOMPATIBLE_DAEMON_STOP_TIMEOUT_MS = 5_000
const PROOF_PATH = "/.well-known/pippit-bridge-local-runtime"
const HEX_KEY_PATTERN = /^[a-f0-9]{64}$/u
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const RUNTIME_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
const LEGACY_PROOF_WITHOUT_PID_VERSIONS = new Set(["0.2.0"])

interface LocalRuntimeSecrets {
  readonly bootstrap_proof_key_hex: string
  readonly byok_encryption_key_hex: string
  readonly chatgpt_media_signing_key_hex: string
  readonly created_at: string
  readonly facade_api_key: string
  readonly job_signing_key_hex: string
  readonly management_api_key: string
  readonly schema_version: 1
}

interface LocalRuntimeReadyPayload {
  readonly instance_id: string
  readonly pid: number
  readonly port: number
  readonly runtime_version: string
  readonly schema_version: 1
  readonly started_at: string
}

interface LocalRuntimeReadyDescriptor extends LocalRuntimeReadyPayload {
  readonly signature: string
}

interface BootstrapLockPayload {
  readonly created_at: string
  readonly pid: number
  readonly schema_version: 1
}

interface ByokStoreLockPayload {
  readonly created_at: string
  readonly pid: number
}

export interface PippitLocalRuntimePaths {
  readonly bootstrapLockPath: string
  readonly byokDirectory: string
  readonly byokStorePath: string
  readonly configPath: string
  readonly dataRoot: string
  readonly outputRoot: string
  readonly readyPath: string
}

export interface PippitResolvedRuntimeEnvironment {
  readonly environment: NodeJS.ProcessEnv
  readonly local?: {
    readonly dataRoot: string
    readonly mediaSigningKeyHex: string
  }
  readonly mode: "external" | "local"
}

export class PippitLocalRuntimeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "PippitLocalRuntimeError"
    this.code = code
  }
}

interface BootstrapLock {
  readonly handle: FileHandle
  readonly stats: Stats
}

interface LocalRuntimeReadyConnection {
  readonly baseUrl: string
  readonly descriptor: LocalRuntimeReadyDescriptor
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function randomHexKey(): string {
  return randomBytes(32).toString("hex")
}

function randomApiKey(): string {
  return randomBytes(32).toString("base64url")
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined
}

function assertPrivateStats(stats: Stats, label: string, expected: "directory" | "file"): void {
  const correctType = expected === "directory" ? stats.isDirectory() : stats.isFile()
  if (!correctType || stats.isSymbolicLink()) {
    throw new PippitLocalRuntimeError("unsafe_state_path", `${label} must be a real ${expected}.`)
  }
  const uid = currentUid()
  if (uid !== undefined && stats.uid !== uid) {
    throw new PippitLocalRuntimeError("unsafe_state_owner", `${label} must be owned by the current user.`)
  }
  if (expected === "file" && stats.nlink !== 1) {
    throw new PippitLocalRuntimeError("unsafe_state_link", `${label} must not be hard-linked.`)
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new PippitLocalRuntimeError(
      "unsafe_state_permissions",
      `${label} permissions must not grant access to group or other users.`,
    )
  }
}

async function ensurePrivateDirectory(path: string, label: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true })
  let stats = await lstat(path)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new PippitLocalRuntimeError("unsafe_state_path", `${label} must be a real directory.`)
  }
  const uid = currentUid()
  if (uid !== undefined && stats.uid !== uid) {
    throw new PippitLocalRuntimeError("unsafe_state_owner", `${label} must be owned by the current user.`)
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    await chmod(path, 0o700)
    stats = await lstat(path)
  }
  assertPrivateStats(stats, label, "directory")
}

async function ensureOutputDirectory(path: string): Promise<void> {
  const label = "Pippit output directory"
  let existed = true
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    existed = false
    await mkdir(path, { mode: 0o700, recursive: true })
  }
  let stats = await lstat(path)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new PippitLocalRuntimeError("unsafe_state_path", `${label} must be a real directory.`)
  }
  const uid = currentUid()
  if (uid !== undefined && stats.uid !== uid) {
    throw new PippitLocalRuntimeError("unsafe_state_owner", `${label} must be owned by the current user.`)
  }
  if (!existed && process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    await chmod(path, 0o700)
    stats = await lstat(path)
  }
  if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) {
    throw new PippitLocalRuntimeError(
      "unsafe_state_permissions",
      `${label} must not be writable by group or other users.`,
    )
  }
}

async function openPrivateFile(path: string, label: string): Promise<FileHandle> {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PippitLocalRuntimeError("state_file_missing", `${label} no longer exists.`)
    }
    throw new PippitLocalRuntimeError("state_file_unavailable", `${label} is unavailable.`)
  }
  try {
    const stats = await handle.stat()
    assertPrivateStats(stats, label, "file")
    if (stats.size > MAX_STATE_FILE_BYTES) {
      throw new PippitLocalRuntimeError("state_file_too_large", `${label} is unexpectedly large.`)
    }
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function readPrivateJson(path: string, label: string): Promise<unknown> {
  const handle = await openPrivateFile(path, label)
  try {
    const text = await handle.readFile({ encoding: "utf8" })
    return JSON.parse(text) as unknown
  } catch (error) {
    if (error instanceof PippitLocalRuntimeError) throw error
    throw new PippitLocalRuntimeError("invalid_state_file", `${label} is not valid JSON.`)
  } finally {
    await handle.close()
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT"
  }
}

async function syncParentDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return
  const handle = await open(dirname(path), constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writePrivateJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`
  let handle: FileHandle | undefined
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: "utf8" })
    await handle.sync()
    await handle.close()
    handle = undefined
    if (await pathExists(path)) {
      throw new PippitLocalRuntimeError("state_already_exists", "Local runtime state already exists.")
    }
    await rename(temporaryPath, path)
    await syncParentDirectory(path)
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
  }
}

function parseSecrets(value: unknown): LocalRuntimeSecrets {
  if (!isRecord(value)) {
    throw new PippitLocalRuntimeError("invalid_local_secrets", "Local runtime secrets are invalid.")
  }
  const candidate = value as Partial<LocalRuntimeSecrets>
  const hexKeys = [
    candidate.bootstrap_proof_key_hex,
    candidate.byok_encryption_key_hex,
    candidate.chatgpt_media_signing_key_hex,
    candidate.job_signing_key_hex,
  ]
  if (
    candidate.schema_version !== PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION ||
    typeof candidate.created_at !== "string" ||
    !Number.isFinite(Date.parse(candidate.created_at)) ||
    typeof candidate.facade_api_key !== "string" ||
    !API_KEY_PATTERN.test(candidate.facade_api_key) ||
    typeof candidate.management_api_key !== "string" ||
    !API_KEY_PATTERN.test(candidate.management_api_key) ||
    hexKeys.some((key) => typeof key !== "string" || !HEX_KEY_PATTERN.test(key))
  ) {
    throw new PippitLocalRuntimeError("invalid_local_secrets", "Local runtime secrets are invalid.")
  }
  const distinctValues = [candidate.facade_api_key, candidate.management_api_key, ...hexKeys] as string[]
  if (new Set(distinctValues).size !== distinctValues.length) {
    throw new PippitLocalRuntimeError("reused_local_secret", "Local runtime secrets must be independent.")
  }
  return candidate as LocalRuntimeSecrets
}

function newSecrets(): LocalRuntimeSecrets {
  return {
    bootstrap_proof_key_hex: randomHexKey(),
    byok_encryption_key_hex: randomHexKey(),
    chatgpt_media_signing_key_hex: randomHexKey(),
    created_at: new Date().toISOString(),
    facade_api_key: randomApiKey(),
    job_signing_key_hex: randomHexKey(),
    management_api_key: randomApiKey(),
    schema_version: PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION,
  }
}

function readyPayload(value: LocalRuntimeReadyDescriptor): LocalRuntimeReadyPayload {
  return {
    instance_id: value.instance_id,
    pid: value.pid,
    port: value.port,
    runtime_version: value.runtime_version,
    schema_version: value.schema_version,
    started_at: value.started_at,
  }
}

function readyPayloadString(value: LocalRuntimeReadyPayload): string {
  return [
    value.schema_version,
    value.runtime_version,
    value.pid,
    value.port,
    value.instance_id,
    value.started_at,
  ].join("\n")
}

export function signLocalRuntimeReadyPayload(
  payload: LocalRuntimeReadyPayload,
  proofKeyHex: string,
): string {
  return createHmac("sha256", Buffer.from(proofKeyHex, "hex"))
    .update(readyPayloadString(payload), "utf8")
    .digest("hex")
}

export function createLocalRuntimeProof(
  instanceId: string,
  challenge: string,
  proofKeyHex: string,
): string {
  return createHmac("sha256", Buffer.from(proofKeyHex, "hex"))
    .update(`pippit-local-runtime\nv1\n${instanceId}\n${challenge}`, "utf8")
    .digest("hex")
}

function parseReadyDescriptor(value: unknown, proofKeyHex: string): LocalRuntimeReadyDescriptor {
  if (!isRecord(value)) {
    throw new PippitLocalRuntimeError("invalid_ready_descriptor", "Local runtime readiness state is invalid.")
  }
  const candidate = value as Partial<LocalRuntimeReadyDescriptor>
  if (
    candidate.schema_version !== PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION ||
    typeof candidate.runtime_version !== "string" ||
    candidate.runtime_version.length > 64 ||
    !RUNTIME_VERSION_PATTERN.test(candidate.runtime_version) ||
    typeof candidate.pid !== "number" ||
    !Number.isSafeInteger(candidate.pid) ||
    candidate.pid < 1 ||
    typeof candidate.port !== "number" ||
    !Number.isSafeInteger(candidate.port) ||
    candidate.port < 1 ||
    candidate.port > 65_535 ||
    typeof candidate.instance_id !== "string" ||
    !UUID_PATTERN.test(candidate.instance_id) ||
    typeof candidate.started_at !== "string" ||
    !Number.isFinite(Date.parse(candidate.started_at)) ||
    typeof candidate.signature !== "string" ||
    !HEX_KEY_PATTERN.test(candidate.signature)
  ) {
    throw new PippitLocalRuntimeError("invalid_ready_descriptor", "Local runtime readiness state is invalid.")
  }
  const expected = Buffer.from(signLocalRuntimeReadyPayload(readyPayload(candidate as LocalRuntimeReadyDescriptor), proofKeyHex), "hex")
  const actual = Buffer.from(candidate.signature, "hex")
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new PippitLocalRuntimeError("invalid_ready_signature", "Local runtime readiness state is not authentic.")
  }
  return candidate as LocalRuntimeReadyDescriptor
}

function parseLock(value: unknown): BootstrapLockPayload {
  if (!isRecord(value)) {
    throw new PippitLocalRuntimeError("invalid_bootstrap_lock", "Local runtime bootstrap lock is invalid.")
  }
  const candidate = value as Partial<BootstrapLockPayload>
  if (
    candidate.schema_version !== PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION ||
    typeof candidate.pid !== "number" ||
    !Number.isSafeInteger(candidate.pid) ||
    candidate.pid < 1 ||
    typeof candidate.created_at !== "string" ||
    !Number.isFinite(Date.parse(candidate.created_at))
  ) {
    throw new PippitLocalRuntimeError("invalid_bootstrap_lock", "Local runtime bootstrap lock is invalid.")
  }
  return candidate as BootstrapLockPayload
}

function parseByokStoreLock(value: unknown): ByokStoreLockPayload {
  if (!isRecord(value)) {
    throw new PippitLocalRuntimeError("invalid_byok_lock", "The Pippit BYOK store lock is invalid.")
  }
  const candidate = value as Partial<ByokStoreLockPayload>
  if (
    typeof candidate.pid !== "number" ||
    !Number.isSafeInteger(candidate.pid) ||
    candidate.pid < 1 ||
    typeof candidate.created_at !== "string" ||
    !Number.isFinite(Date.parse(candidate.created_at))
  ) {
    throw new PippitLocalRuntimeError("invalid_byok_lock", "The Pippit BYOK store lock is invalid.")
  }
  return candidate as ByokStoreLockPayload
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function compareRuntimeVersions(left: string, right: string): number {
  const leftParts = RUNTIME_VERSION_PATTERN.exec(left)
  const rightParts = RUNTIME_VERSION_PATTERN.exec(right)
  if (leftParts === null || rightParts === null) {
    throw new PippitLocalRuntimeError(
      "invalid_runtime_version",
      "The local Pippit Facade runtime version is invalid.",
    )
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
    throw new PippitLocalRuntimeError(
      "unsafe_state_link",
      `${label} has an unexpected hard-link count.`,
    )
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new PippitLocalRuntimeError(
      "unsafe_state_permissions",
      `${label} permissions must not grant access to group or other users.`,
    )
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
    try {
      candidateStats = await lstat(candidatePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    if (!sameFile(candidateStats, expected)) continue
    assertBootstrapLockStats(candidateStats, "Local runtime bootstrap lock candidate")
    if (candidateStats.nlink !== 2) {
      throw new PippitLocalRuntimeError(
        "unsafe_bootstrap_lock_link",
        "The Pippit local runtime bootstrap lock candidate changed unexpectedly.",
      )
    }
    matchingCandidates.push(candidatePath)
  }
  if (matchingCandidates.length > 1) {
    throw new PippitLocalRuntimeError(
      "unsafe_bootstrap_lock_link",
      "The Pippit local runtime bootstrap lock has multiple candidate hard links.",
    )
  }
  return matchingCandidates[0]
}

async function removeFileIfUnchanged(path: string, expected: Stats): Promise<void> {
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
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PippitLocalRuntimeError(
        "state_file_missing",
        "Local runtime bootstrap lock no longer exists.",
      )
    }
    throw new PippitLocalRuntimeError(
      "state_file_unavailable",
      "Local runtime bootstrap lock is unavailable.",
    )
  }
  try {
    const stats = await handle.stat()
    if (stats.nlink === 0) {
      throw new PippitLocalRuntimeError(
        "state_file_missing",
        "Local runtime bootstrap lock was released while being inspected.",
      )
    }
    assertBootstrapLockStats(stats, "Local runtime bootstrap lock")
    const payload = parseLock(JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown)
    return { payload, stats }
  } catch (error) {
    if (error instanceof PippitLocalRuntimeError) throw error
    throw new PippitLocalRuntimeError("invalid_bootstrap_lock", "Local runtime bootstrap lock is invalid.")
  } finally {
    await handle.close()
  }
}

async function removeStaleBootstrapLock(
  path: string,
  existing: Awaited<ReturnType<typeof readLock>>,
): Promise<boolean> {
  const candidatePath = await findBootstrapLockCandidate(path, existing.stats)
  if (candidatePath !== undefined) {
    let candidateStats: Stats
    try {
      candidateStats = await lstat(candidatePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return removeSingleLinkBootstrapLockIfUnchanged(path, existing.stats)
      }
      throw error
    }
    assertBootstrapLockStats(candidateStats, "Local runtime bootstrap lock candidate")
    if (!sameFile(candidateStats, existing.stats) || candidateStats.nlink !== 2) {
      return removeSingleLinkBootstrapLockIfUnchanged(path, existing.stats)
    }
    try {
      await unlink(candidatePath)
      await syncParentDirectory(candidatePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return removeSingleLinkBootstrapLockIfUnchanged(path, existing.stats)
}

async function removeSingleLinkBootstrapLockIfUnchanged(
  path: string,
  expected: Stats,
): Promise<boolean> {
  let current: Stats
  try {
    current = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
  if (!sameFile(current, expected)) return false
  assertBootstrapLockStats(current, "Local runtime bootstrap lock")
  if (current.nlink !== 1) {
    throw new PippitLocalRuntimeError(
      "unsafe_bootstrap_lock_link",
      "The Pippit local runtime bootstrap lock has an unrecognized hard link.",
    )
  }
  try {
    await unlink(path)
    await syncParentDirectory(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function acquireBootstrapLock(path: string): Promise<BootstrapLock> {
  const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const candidatePath = `${path}.candidate-${process.pid}-${randomBytes(8).toString("hex")}`
    let candidateHandle: FileHandle | undefined
    let candidateStats: Stats | undefined
    try {
      candidateHandle = await open(
        candidatePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      const payload: BootstrapLockPayload = {
        created_at: new Date().toISOString(),
        pid: process.pid,
        schema_version: PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION,
      }
      await candidateHandle.writeFile(`${JSON.stringify(payload)}\n`, { encoding: "utf8" })
      await candidateHandle.sync()
      candidateStats = await candidateHandle.stat()
      try {
        await link(candidatePath, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        await candidateHandle.close()
        candidateHandle = undefined
        await unlink(candidatePath)
        let existing: Awaited<ReturnType<typeof readLock>>
        try {
          existing = await readLock(path)
        } catch (error) {
          if (error instanceof PippitLocalRuntimeError && error.code === "state_file_missing") {
            continue
          }
          throw error
        }
        const age = Date.now() - Date.parse(existing.payload.created_at)
        if (!processIsAlive(existing.payload.pid) && age >= LOCK_STALE_AFTER_MS) {
          await removeStaleBootstrapLock(path, existing)
          continue
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
        continue
      }
      await unlink(candidatePath)
      await syncParentDirectory(path)
      return { handle: candidateHandle, stats: candidateStats }
    } catch (error) {
      await candidateHandle?.close().catch(() => undefined)
      await unlink(candidatePath).catch(() => undefined)
      if (candidateStats !== undefined) {
        try {
          const current = await lstat(path)
          if (sameFile(current, candidateStats)) {
            await unlink(path)
            await syncParentDirectory(path)
          }
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new PippitLocalRuntimeError(
              "bootstrap_lock_cleanup_failed",
              "The Pippit local runtime bootstrap lock could not be cleaned up safely.",
            )
          }
        }
      }
      throw error
    }
  }
  throw new PippitLocalRuntimeError(
    "bootstrap_lock_timeout",
    "Another Pippit local runtime bootstrap is still in progress.",
  )
}

async function releaseBootstrapLock(path: string, lock: BootstrapLock): Promise<void> {
  await lock.handle.close()
  try {
    await removeFileIfUnchanged(path, lock.stats)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

export function resolvePippitLocalRuntimePaths(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): PippitLocalRuntimePaths {
  const override = nonEmpty(env.PIPPIT_BRIDGE_HOME)
  let dataRoot: string
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new PippitLocalRuntimeError("invalid_data_root", "PIPPIT_BRIDGE_HOME must be an absolute path.")
    }
    dataRoot = resolve(override)
  } else if (platform === "darwin") {
    dataRoot = join(userHome, "Library", "Application Support", "Pippit Bridge")
  } else if (platform === "win32") {
    const localAppData = nonEmpty(env.LOCALAPPDATA)
    if (localAppData === undefined) {
      throw new PippitLocalRuntimeError("missing_data_root", "LOCALAPPDATA is required for local runtime setup.")
    }
    dataRoot = join(localAppData, "Pippit Bridge")
  } else {
    dataRoot = join(nonEmpty(env.XDG_DATA_HOME) ?? join(userHome, ".local", "share"), "pippit-bridge")
  }
  if (!isAbsolute(dataRoot)) {
    throw new PippitLocalRuntimeError("invalid_data_root", "The Pippit local runtime data root must be absolute.")
  }
  const byokDirectory = join(dataRoot, "byok")
  const configuredOutputRoot = nonEmpty(env.PIPPIT_MCP_OUTPUT_ROOT)
  const outputRoot = configuredOutputRoot !== undefined
    ? resolve(configuredOutputRoot)
    : override !== undefined
      ? join(dataRoot, "outputs")
      : defaultPippitOutputDirectory(userHome, platform)
  return {
    bootstrapLockPath: join(dataRoot, LOCK_FILE_NAME),
    byokDirectory,
    byokStorePath: join(byokDirectory, "credentials.json"),
    configPath: join(dataRoot, CONFIG_FILE_NAME),
    dataRoot,
    outputRoot,
    readyPath: join(dataRoot, READY_FILE_NAME),
  }
}

async function readOrCreateSecrets(paths: PippitLocalRuntimePaths): Promise<LocalRuntimeSecrets> {
  if (await pathExists(paths.configPath)) {
    return parseSecrets(await readPrivateJson(paths.configPath, "Local runtime secrets"))
  }
  if (await pathExists(paths.byokStorePath)) {
    throw new PippitLocalRuntimeError(
      "missing_encryption_keys",
      "An existing Pippit BYOK store has no matching local runtime secrets; refusing to replace its encryption key.",
    )
  }
  const secrets = newSecrets()
  await writePrivateJsonAtomically(paths.configPath, secrets)
  return secrets
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
  } finally {
    await handle.close()
  }
  if (processIsAlive(payload.pid)) return
  await removeFileIfUnchanged(lockPath, stats)
}

async function rejectOrRemoveUnverifiedDaemon(
  paths: PippitLocalRuntimePaths,
  descriptor: LocalRuntimeReadyDescriptor,
  stats: Stats,
): Promise<undefined> {
  if (!processIsAlive(descriptor.pid)) {
    try {
      await removeFileIfUnchanged(paths.readyPath, stats)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return undefined
  }
  throw new PippitLocalRuntimeError(
    "live_daemon_verification_failed",
    "A live local Pippit Facade could not be authenticated; refusing to start a second daemon.",
  )
}

async function readReadyConnection(
  paths: PippitLocalRuntimePaths,
  secrets: LocalRuntimeSecrets,
  fetchImplementation: typeof fetch,
): Promise<LocalRuntimeReadyConnection | undefined> {
  if (!(await pathExists(paths.readyPath))) return undefined
  let handle: FileHandle
  try {
    handle = await openPrivateFile(paths.readyPath, "Local runtime readiness state")
  } catch (error) {
    if (error instanceof PippitLocalRuntimeError && error.code === "state_file_missing") return undefined
    throw error
  }
  let descriptor: LocalRuntimeReadyDescriptor
  let stats: Stats
  try {
    stats = await handle.stat()
    descriptor = parseReadyDescriptor(
      JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown,
      secrets.bootstrap_proof_key_hex,
    )
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
  await handle.close()
  if (!processIsAlive(descriptor.pid)) {
    await removeFileIfUnchanged(paths.readyPath, stats)
    return undefined
  }

  const challenge = randomHexKey()
  const baseUrl = `http://127.0.0.1:${descriptor.port}`
  let response: Response
  try {
    response = await fetchImplementation(`${baseUrl}${PROOF_PATH}?challenge=${challenge}`, {
      redirect: "error",
      signal: AbortSignal.timeout(PROOF_TIMEOUT_MS),
    })
  } catch {
    return rejectOrRemoveUnverifiedDaemon(paths, descriptor, stats)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return rejectOrRemoveUnverifiedDaemon(paths, descriptor, stats)
  }
  const text = await response.text()
  if (Buffer.byteLength(text, "utf8") > 8 * 1024) {
    return rejectOrRemoveUnverifiedDaemon(paths, descriptor, stats)
  }
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    return rejectOrRemoveUnverifiedDaemon(paths, descriptor, stats)
  }
  const proofPidMatches = isRecord(body) && (
    body.pid === descriptor.pid ||
    (body.pid === undefined && LEGACY_PROOF_WITHOUT_PID_VERSIONS.has(descriptor.runtime_version))
  )
  if (
    !isRecord(body) ||
    body.instance_id !== descriptor.instance_id ||
    body.runtime_version !== descriptor.runtime_version ||
    typeof body.proof !== "string" ||
    !proofPidMatches
  ) {
    return rejectOrRemoveUnverifiedDaemon(paths, descriptor, stats)
  }
  const expected = Buffer.from(
    createLocalRuntimeProof(descriptor.instance_id, challenge, secrets.bootstrap_proof_key_hex),
    "hex",
  )
  const actual = HEX_KEY_PATTERN.test(body.proof) ? Buffer.from(body.proof, "hex") : Buffer.alloc(0)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return rejectOrRemoveUnverifiedDaemon(paths, descriptor, stats)
  }
  const versionComparison = compareRuntimeVersions(
    PIPPIT_LOCAL_RUNTIME_VERSION,
    descriptor.runtime_version,
  )
  if (versionComparison > 0) {
    if (descriptor.pid <= 1 || descriptor.pid === process.pid) {
      throw new PippitLocalRuntimeError(
        "unsafe_incompatible_daemon_pid",
        "The outdated local Pippit Facade advertised an unsafe process identifier.",
      )
    }
    try {
      process.kill(descriptor.pid, "SIGTERM")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw new PippitLocalRuntimeError(
          "incompatible_daemon_stop_failed",
          "The outdated local Pippit Facade could not be stopped safely.",
        )
      }
    }
    const deadline = Date.now() + INCOMPATIBLE_DAEMON_STOP_TIMEOUT_MS
    while (processIsAlive(descriptor.pid) && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
    }
    if (processIsAlive(descriptor.pid)) {
      throw new PippitLocalRuntimeError(
        "incompatible_daemon_stop_timeout",
        "The outdated local Pippit Facade did not stop in time.",
      )
    }
    try {
      await removeFileIfUnchanged(paths.readyPath, stats)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return undefined
  }
  return { baseUrl, descriptor }
}

function resolveDaemonEntry(moduleUrl: string = import.meta.url): string {
  const besideCompiledModule = fileURLToPath(new URL("./local-facade-daemon.mjs", moduleUrl))
  const fromSourceCheckout = fileURLToPath(new URL("../dist/local-facade-daemon.mjs", moduleUrl))
  return basename(dirname(fileURLToPath(moduleUrl))) === "src"
    ? fromSourceCheckout
    : besideCompiledModule
}

async function startLocalFacadeDaemon(paths: PippitLocalRuntimePaths, moduleUrl?: string): Promise<number> {
  const daemonEntry = resolveDaemonEntry(moduleUrl)
  let entryStats: Stats
  try {
    entryStats = await lstat(daemonEntry)
  } catch {
    throw new PippitLocalRuntimeError(
      "missing_local_daemon",
      "The installed Pippit package is missing its local Facade runtime bundle.",
    )
  }
  if (!entryStats.isFile() || entryStats.isSymbolicLink()) {
    throw new PippitLocalRuntimeError("unsafe_local_daemon", "The local Facade runtime bundle is invalid.")
  }
  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    env: {
      PIPPIT_LOCAL_RUNTIME_CONFIG_PATH: paths.configPath,
      PIPPIT_LOCAL_RUNTIME_DATA_ROOT: paths.dataRoot,
      PIPPIT_LOCAL_RUNTIME_READY_PATH: paths.readyPath,
    },
    stdio: "ignore",
  })
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("error", rejectSpawn)
    child.once("spawn", resolveSpawn)
  }).catch(() => {
    throw new PippitLocalRuntimeError("local_daemon_start_failed", "The local Pippit Facade could not start.")
  })
  const pid = child.pid
  if (pid === undefined) {
    throw new PippitLocalRuntimeError("local_daemon_start_failed", "The local Pippit Facade could not start.")
  }
  child.unref()
  return pid
}

async function waitForReadyConnection(
  paths: PippitLocalRuntimePaths,
  secrets: LocalRuntimeSecrets,
  fetchImplementation: typeof fetch,
  startedPid: number,
): Promise<LocalRuntimeReadyConnection> {
  const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const ready = await readReadyConnection(paths, secrets, fetchImplementation)
    if (ready !== undefined) return ready
    if (!processIsAlive(startedPid)) {
      throw new PippitLocalRuntimeError(
        "local_daemon_start_failed",
        "The local Pippit Facade exited before it became ready.",
      )
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
  }
  throw new PippitLocalRuntimeError(
    "local_daemon_ready_timeout",
    "The local Pippit Facade did not become ready in time.",
  )
}

export async function ensurePippitLocalRuntime(options: {
  readonly daemonModuleUrl?: string
  readonly env?: NodeJS.ProcessEnv
  readonly fetchImplementation?: typeof fetch
} = {}): Promise<PippitResolvedRuntimeEnvironment> {
  const env = options.env ?? process.env
  const fetchImplementation = options.fetchImplementation ?? fetch
  const paths = resolvePippitLocalRuntimePaths(env)
  await ensurePrivateDirectory(paths.dataRoot, "Pippit local runtime data directory")
  await ensurePrivateDirectory(paths.byokDirectory, "Pippit BYOK directory")
  await ensureOutputDirectory(paths.outputRoot)

  const lock = await acquireBootstrapLock(paths.bootstrapLockPath)
  try {
    const secrets = await readOrCreateSecrets(paths)
    let ready = await readReadyConnection(paths, secrets, fetchImplementation)
    if (ready === undefined) {
      const startedPid = await startLocalFacadeDaemon(paths, options.daemonModuleUrl)
      ready = await waitForReadyConnection(paths, secrets, fetchImplementation, startedPid)
    }
    return {
      environment: {
        ...env,
        PIPPIT_FACADE_API_KEY: secrets.facade_api_key,
        PIPPIT_FACADE_BASE_URL: ready.baseUrl,
        PIPPIT_FACADE_MANAGEMENT_API_KEY: secrets.management_api_key,
        PIPPIT_MCP_OUTPUT_ROOT: paths.outputRoot,
      },
      local: {
        dataRoot: paths.dataRoot,
        mediaSigningKeyHex: secrets.chatgpt_media_signing_key_hex,
      },
      mode: "local",
    }
  } finally {
    await releaseBootstrapLock(paths.bootstrapLockPath, lock)
  }
}

export async function resolvePippitRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PippitResolvedRuntimeEnvironment> {
  const facadeApiKey = nonEmpty(env.PIPPIT_FACADE_API_KEY)
  const facadeBaseUrl = nonEmpty(env.PIPPIT_FACADE_BASE_URL)
  const managementApiKey = nonEmpty(env.PIPPIT_FACADE_MANAGEMENT_API_KEY)
  if (facadeApiKey !== undefined && facadeBaseUrl !== undefined) {
    return { environment: { ...env }, mode: "external" }
  }
  if (facadeApiKey !== undefined || facadeBaseUrl !== undefined || managementApiKey !== undefined) {
    throw new PippitLocalRuntimeError(
      "partial_external_configuration",
      "PIPPIT_FACADE_API_KEY and PIPPIT_FACADE_BASE_URL are both required when any external Facade setting is configured.",
    )
  }
  if (nonEmpty(env.PIPPIT_LOCAL_RUNTIME_AUTO_START)?.toLowerCase() === "false") {
    throw new PippitLocalRuntimeError(
      "local_runtime_disabled",
      "No external Facade is configured and automatic local runtime setup is disabled.",
    )
  }
  return ensurePippitLocalRuntime({ env })
}

export async function readPippitLocalRuntimeSecretsForDaemon(
  configPath: string,
): Promise<LocalRuntimeSecrets> {
  if (!isAbsolute(configPath)) {
    throw new PippitLocalRuntimeError("invalid_config_path", "Local runtime config path must be absolute.")
  }
  return parseSecrets(await readPrivateJson(configPath, "Local runtime secrets"))
}

export async function writePippitLocalRuntimeReadyDescriptor(
  path: string,
  payload: LocalRuntimeReadyPayload,
  proofKeyHex: string,
): Promise<void> {
  const descriptor: LocalRuntimeReadyDescriptor = {
    ...payload,
    signature: signLocalRuntimeReadyPayload(payload, proofKeyHex),
  }
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`
  let handle: FileHandle | undefined
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    await handle.writeFile(`${JSON.stringify(descriptor)}\n`, { encoding: "utf8" })
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, path)
    await syncParentDirectory(path)
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
  }
}

export async function removePippitLocalRuntimeReadyDescriptor(path: string, pid: number): Promise<void> {
  try {
    const value = await readPrivateJson(path, "Local runtime readiness state")
    if (!isRecord(value) || value.pid !== pid) return
    await unlink(path)
    await syncParentDirectory(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return
  }
}
