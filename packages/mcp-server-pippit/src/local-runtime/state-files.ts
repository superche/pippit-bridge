import { randomBytes } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { chmod, lstat, mkdir, open, type FileHandle } from "node:fs/promises"
import { dirname } from "node:path"
import {
  createPrivateFileIfAbsent,
  ensurePrivateDirectory as ensureSharedPrivateDirectory,
  PrivateFileError,
  readPrivateFile,
} from "@pippit-bridge/core"
import {
  PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION,
  PippitLocalRuntimeError,
  type LocalRuntimeIdempotencySecret,
  type LocalRuntimeSecrets,
} from "./contracts.ts"

export const MAX_STATE_FILE_BYTES = 64 * 1024
export const HEX_KEY_PATTERN = /^[a-f0-9]{64}$/u
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u

export function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function randomHexKey(): string {
  return randomBytes(32).toString("hex")
}

function randomApiKey(): string {
  return randomBytes(32).toString("base64url")
}

export function assertPrivateStats(stats: Stats, label: string, expected: "directory" | "file"): void {
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
    throw new PippitLocalRuntimeError("unsafe_state_permissions", `${label} permissions must not grant access to group or other users.`)
  }
}

export async function ensurePrivateDirectory(path: string, label: string): Promise<void> {
  try {
    await ensureSharedPrivateDirectory(path)
  } catch {
    throw new PippitLocalRuntimeError("unsafe_state_path", `${label} must be a private directory owned by the current user.`)
  }
}

export async function ensureOutputDirectory(path: string): Promise<void> {
  const label = "Pippit output directory"
  let existed = true
  try { await lstat(path) } catch (error) {
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
    throw new PippitLocalRuntimeError("unsafe_state_permissions", `${label} must not be writable by group or other users.`)
  }
}

export async function openPrivateFile(path: string, label: string): Promise<FileHandle> {
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

export async function readPrivateJson(path: string, label: string): Promise<unknown> {
  let contents: Buffer | undefined
  try {
    contents = await readPrivateFile(path, MAX_STATE_FILE_BYTES)
    return JSON.parse(contents.toString("utf8")) as unknown
  } catch (error) {
    if (error instanceof PippitLocalRuntimeError) throw error
    if (error instanceof PrivateFileError) {
      throw new PippitLocalRuntimeError("state_file_unavailable", `${label} is unavailable.`)
    }
    throw new PippitLocalRuntimeError("invalid_state_file", `${label} is not valid JSON.`)
  } finally {
    contents?.fill(0)
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT" }
}

export async function syncParentDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return
  const handle = await open(dirname(path), constants.O_RDONLY)
  try { await handle.sync() } finally { await handle.close() }
}

export async function writePrivateJsonAtomically(path: string, value: unknown): Promise<"created" | "exists"> {
  const contents = Buffer.from(`${JSON.stringify(value)}\n`, "utf8")
  try {
    return await createPrivateFileIfAbsent(path, contents)
  } catch {
    throw new PippitLocalRuntimeError("state_file_unavailable", "Local runtime state could not be created safely.")
  } finally {
    contents.fill(0)
  }
}

export function parseSecrets(value: unknown): LocalRuntimeSecrets {
  if (!isRecord(value)) throw new PippitLocalRuntimeError("invalid_local_secrets", "Local runtime secrets are invalid.")
  const candidate = value as Partial<LocalRuntimeSecrets>
  const hexKeys = [candidate.bootstrap_proof_key_hex, candidate.byok_encryption_key_hex,
    candidate.chatgpt_media_signing_key_hex, candidate.job_signing_key_hex]
  if (candidate.schema_version !== PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION
    || typeof candidate.created_at !== "string" || !Number.isFinite(Date.parse(candidate.created_at))
    || typeof candidate.facade_api_key !== "string" || !API_KEY_PATTERN.test(candidate.facade_api_key)
    || typeof candidate.management_api_key !== "string" || !API_KEY_PATTERN.test(candidate.management_api_key)
    || hexKeys.some(key => typeof key !== "string" || !HEX_KEY_PATTERN.test(key))) {
    throw new PippitLocalRuntimeError("invalid_local_secrets", "Local runtime secrets are invalid.")
  }
  const distinctValues = [candidate.facade_api_key, candidate.management_api_key, ...hexKeys] as string[]
  if (new Set(distinctValues).size !== distinctValues.length) {
    throw new PippitLocalRuntimeError("reused_local_secret", "Local runtime secrets must be independent.")
  }
  return candidate as LocalRuntimeSecrets
}

export function newSecrets(): LocalRuntimeSecrets {
  return {
    bootstrap_proof_key_hex: randomHexKey(), byok_encryption_key_hex: randomHexKey(),
    chatgpt_media_signing_key_hex: randomHexKey(), created_at: new Date().toISOString(),
    facade_api_key: randomApiKey(), job_signing_key_hex: randomHexKey(), management_api_key: randomApiKey(),
    schema_version: PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION,
  }
}

export function parseIdempotencySecret(value: unknown): LocalRuntimeIdempotencySecret {
  if (!isRecord(value) || value.schema_version !== PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION
    || typeof value.idempotency_hmac_key_hex !== "string" || !HEX_KEY_PATTERN.test(value.idempotency_hmac_key_hex)) {
    throw new PippitLocalRuntimeError("invalid_idempotency_secret", "The local idempotency secret is invalid.")
  }
  return value as unknown as LocalRuntimeIdempotencySecret
}
