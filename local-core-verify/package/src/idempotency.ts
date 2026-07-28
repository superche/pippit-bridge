import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { dirname, resolve } from "node:path"
import {
  atomicReplacePrivateFile,
  ensurePrivateDirectory,
  PrivateFileError,
  readPrivateFileIfExists,
  withPrivateFileTransaction,
} from "./private-file/index.js"

export type IdempotencyPhase =
  | "preparing"
  | "submitting"
  | "submitted"
  | "failed"
  | "indeterminate"

export type IdempotencyBeginResult =
  | { readonly kind: "started"; readonly recordId: string }
  | { readonly kind: "replay"; readonly recordId: string; readonly response: unknown }
  | { readonly kind: "failed"; readonly errorCode: string; readonly recordId: string }
  | { readonly kind: "conflict"; readonly recordId: string }
  | { readonly kind: "in_progress"; readonly phase: "preparing" | "submitting"; readonly recordId: string }
  | { readonly kind: "indeterminate"; readonly recordId: string }

export interface IdempotencyBeginInput {
  readonly key: string
  readonly operation: string
  readonly request: unknown
  readonly scope: string
}

export interface IdempotencyStore {
  begin(input: IdempotencyBeginInput): Promise<IdempotencyBeginResult>
  markFailed(recordId: string, errorCode: string): Promise<void>
  markIndeterminate(recordId: string): Promise<void>
  markPreparing(recordId: string): Promise<void>
  markSubmitted(recordId: string, response: unknown): Promise<void>
  markSubmitting(recordId: string): Promise<void>
  close(): Promise<void>
}

export interface IdempotencyStoreOptions {
  readonly hmacKey: Buffer
  readonly maxRecords?: number
  readonly ownerInstanceId?: string
  readonly ownerPid?: number
  readonly retentionMs?: number
}

export interface FileIdempotencyStoreOptions extends IdempotencyStoreOptions {
  readonly filePath: string
  readonly lockRetryCount?: number
  readonly lockRetryMs?: number
  readonly maxFileBytes?: number
}

export type IdempotencyStoreErrorCode =
  | "INVALID_INPUT"
  | "INVALID_STATE"
  | "LOCK_BUSY"
  | "OWNER_MISMATCH"
  | "STORE_FULL"

export class IdempotencyStoreError extends Error {
  readonly code: IdempotencyStoreErrorCode

  constructor(code: IdempotencyStoreErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "IdempotencyStoreError"
    this.code = code
  }
}

interface IdempotencyRecord {
  created_at: number
  error_code?: string
  expires_at: number
  id: string
  key_hash: string
  operation: string
  owner_instance_id: string
  owner_pid: number
  phase: IdempotencyPhase
  request_hash: string
  response?: unknown
  scope_hash: string
  updated_at: number
}

interface IdempotencyStatePayload {
  format: "pippit-idempotency"
  records: IdempotencyRecord[]
  version: 1
}

interface IdempotencyState extends IdempotencyStatePayload {
  integrity: string
}

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_RECORDS = 1_000
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
const FORMAT = "pippit-idempotency"
const VERSION = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new IdempotencyStoreError("INVALID_INPUT", "Idempotency values must contain only finite numbers.")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const item = value[key]
        if (item === undefined) throw new IdempotencyStoreError("INVALID_INPUT", "Idempotency values must not contain undefined properties.")
        return `${JSON.stringify(key)}:${canonicalJson(item)}`
      })
    return `{${entries.join(",")}}`
  }
  throw new IdempotencyStoreError("INVALID_INPUT", "Idempotency values must be JSON-compatible.")
}

function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

function normalizeOptions(options: IdempotencyStoreOptions): Required<IdempotencyStoreOptions> {
  if (!Buffer.isBuffer(options.hmacKey) || options.hmacKey.length !== 32) {
    throw new IdempotencyStoreError("INVALID_INPUT", "The idempotency HMAC key must contain exactly 32 bytes.")
  }
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS
  const ownerPid = options.ownerPid ?? process.pid
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) throw new IdempotencyStoreError("INVALID_INPUT", "maxRecords must be a positive integer.")
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new IdempotencyStoreError("INVALID_INPUT", "retentionMs must be a positive integer.")
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) throw new IdempotencyStoreError("INVALID_INPUT", "ownerPid must be a positive integer.")
  return {
    hmacKey: Buffer.from(options.hmacKey),
    maxRecords,
    ownerInstanceId: options.ownerInstanceId ?? randomUUID(),
    ownerPid,
    retentionMs,
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isRecord(error) && error.code === "EPERM"
  }
}

abstract class BaseIdempotencyStore implements IdempotencyStore {
  readonly #options: Required<IdempotencyStoreOptions>

  protected constructor(options: IdempotencyStoreOptions) {
    this.#options = normalizeOptions(options)
  }

  protected abstract transact<T>(operation: (records: IdempotencyRecord[]) => { changed: boolean; result: T }): Promise<T>

  #hmac(domain: string, value: unknown): string {
    return createHmac("sha256", this.#options.hmacKey)
      .update(`pippit-idempotency-v1:${domain}\0`, "utf8")
      .update(canonicalJson(value), "utf8")
      .digest("hex")
  }

  #owned(record: IdempotencyRecord): boolean {
    return record.owner_pid === this.#options.ownerPid && record.owner_instance_id === this.#options.ownerInstanceId
  }

  #assertOwned(record: IdempotencyRecord): void {
    if (!this.#owned(record)) {
      throw new IdempotencyStoreError("OWNER_MISMATCH", "The idempotency record is owned by another live submission.")
    }
  }

  async begin(input: IdempotencyBeginInput): Promise<IdempotencyBeginResult> {
    const key = input.key.trim()
    const operation = input.operation.trim()
    const scope = input.scope.trim()
    if (key.length < 1 || key.length > 200 || hasControlCharacter(key)) {
      throw new IdempotencyStoreError("INVALID_INPUT", "Idempotency keys must contain 1 to 200 non-control characters.")
    }
    if (!operation || !scope) throw new IdempotencyStoreError("INVALID_INPUT", "Idempotency operation and scope are required.")
    const keyHash = this.#hmac("key", key)
    const scopeHash = this.#hmac("scope", scope)
    const requestHash = this.#hmac("request", input.request)
    const recordId = this.#hmac("record", { key_hash: keyHash, operation, scope_hash: scopeHash })
    const now = Date.now()

    return this.transact<IdempotencyBeginResult>((records) => {
      let changed = false
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index]
        if (record !== undefined && record.expires_at <= now && ["submitted", "failed", "indeterminate"].includes(record.phase)) {
          records.splice(index, 1)
          changed = true
        }
      }
      const existing = records.find((record) => record.id === recordId)
      if (existing !== undefined) {
        if (existing.request_hash !== requestHash) return { changed, result: { kind: "conflict", recordId } as const }
        if (existing.phase === "submitted") return { changed, result: { kind: "replay", recordId, response: cloneValue(existing.response) } as const }
        if (existing.phase === "failed") return { changed, result: { errorCode: existing.error_code ?? "submission_failed", kind: "failed", recordId } as const }
        if (existing.phase === "indeterminate") return { changed, result: { kind: "indeterminate", recordId } as const }
        if (this.#owned(existing) || isProcessAlive(existing.owner_pid)) {
          return { changed, result: { kind: "in_progress", phase: existing.phase, recordId } as const }
        }
        if (existing.phase === "submitting") {
          existing.phase = "indeterminate"
          existing.updated_at = now
          changed = true
          return { changed, result: { kind: "indeterminate", recordId } as const }
        }
        existing.owner_instance_id = this.#options.ownerInstanceId
        existing.owner_pid = this.#options.ownerPid
        existing.updated_at = now
        changed = true
        return { changed, result: { kind: "started", recordId } as const }
      }
      if (records.length >= this.#options.maxRecords) {
        throw new IdempotencyStoreError("STORE_FULL", "The idempotency store is full; no paid request was submitted.")
      }
      records.push({
        created_at: now,
        expires_at: now + this.#options.retentionMs,
        id: recordId,
        key_hash: keyHash,
        operation,
        owner_instance_id: this.#options.ownerInstanceId,
        owner_pid: this.#options.ownerPid,
        phase: "preparing",
        request_hash: requestHash,
        scope_hash: scopeHash,
        updated_at: now,
      })
      return { changed: true, result: { kind: "started", recordId } as const }
    })
  }

  async #transition(recordId: string, phase: IdempotencyPhase, options: { errorCode?: string; response?: unknown } = {}): Promise<void> {
    await this.transact((records) => {
      const record = records.find((candidate) => candidate.id === recordId)
      if (record === undefined) throw new IdempotencyStoreError("INVALID_STATE", "The idempotency record does not exist.")
      this.#assertOwned(record)
      if (["submitted", "failed", "indeterminate"].includes(record.phase)) {
        throw new IdempotencyStoreError("INVALID_STATE", `The idempotency record is already ${record.phase}.`)
      }
      record.phase = phase
      record.updated_at = Date.now()
      if (options.errorCode !== undefined) record.error_code = options.errorCode
      if (options.response !== undefined) record.response = cloneValue(options.response)
      return { changed: true, result: undefined }
    })
  }

  async markFailed(recordId: string, errorCode: string): Promise<void> {
    await this.#transition(recordId, "failed", { errorCode })
  }

  async markIndeterminate(recordId: string): Promise<void> {
    await this.#transition(recordId, "indeterminate")
  }

  async markPreparing(recordId: string): Promise<void> {
    await this.#transition(recordId, "preparing")
  }

  async markSubmitted(recordId: string, response: unknown): Promise<void> {
    canonicalJson(response)
    await this.#transition(recordId, "submitted", { response })
  }

  async markSubmitting(recordId: string): Promise<void> {
    await this.#transition(recordId, "submitting")
  }

  async close(): Promise<void> {}

  protected stateIntegrity(payload: IdempotencyStatePayload): string {
    return this.#hmac("state", payload)
  }
}

export class MemoryIdempotencyStore extends BaseIdempotencyStore {
  #records: IdempotencyRecord[] = []
  #queue: Promise<void> = Promise.resolve()

  constructor(options: IdempotencyStoreOptions) {
    super(options)
  }

  protected async transact<T>(operation: (records: IdempotencyRecord[]) => { changed: boolean; result: T }): Promise<T> {
    const previous = this.#queue
    let release = (): void => {}
    this.#queue = new Promise<void>((resolvePromise) => { release = resolvePromise })
    await previous
    try {
      const records = cloneValue(this.#records)
      const outcome = operation(records)
      if (outcome.changed) this.#records = records
      return cloneValue(outcome.result)
    } finally {
      release()
    }
  }
}

export class FileIdempotencyStore extends BaseIdempotencyStore {
  readonly #filePath: string
  readonly #lockPath: string
  readonly #lockRetryCount: number
  readonly #lockRetryMs: number
  readonly #maxFileBytes: number

  constructor(options: FileIdempotencyStoreOptions) {
    super(options)
    this.#filePath = resolve(options.filePath)
    this.#lockPath = `${this.#filePath}.lock`
    this.#lockRetryCount = options.lockRetryCount ?? 80
    this.#lockRetryMs = options.lockRetryMs ?? 25
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  }

  async #readState(): Promise<IdempotencyRecord[]> {
    let raw: Buffer | undefined
    try {
      raw = await readPrivateFileIfExists(this.#filePath, this.#maxFileBytes)
      if (raw === undefined) return []
      const parsed: unknown = JSON.parse(raw.toString("utf8"))
      if (!isRecord(parsed) || parsed.format !== FORMAT || parsed.version !== VERSION || !Array.isArray(parsed.records) || typeof parsed.integrity !== "string") {
        throw new IdempotencyStoreError("INVALID_STATE", "The idempotency store has an unsupported format.")
      }
      const payload: IdempotencyStatePayload = { format: FORMAT, records: parsed.records as IdempotencyRecord[], version: VERSION }
      const expected = Buffer.from(this.stateIntegrity(payload), "hex")
      const actual = Buffer.from(parsed.integrity, "hex")
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new IdempotencyStoreError("INVALID_STATE", "The idempotency store integrity check failed.")
      return cloneValue(payload.records)
    } catch (error) {
      if (error instanceof IdempotencyStoreError) throw error
      throw new IdempotencyStoreError("INVALID_STATE", "The idempotency store could not be read safely.", error)
    } finally {
      raw?.fill(0)
    }
  }

  async #writeState(records: IdempotencyRecord[]): Promise<void> {
    const payload: IdempotencyStatePayload = { format: FORMAT, records, version: VERSION }
    const state: IdempotencyState = { ...payload, integrity: this.stateIntegrity(payload) }
    const serialized = `${canonicalJson(state)}\n`
    if (Buffer.byteLength(serialized) > this.#maxFileBytes) throw new IdempotencyStoreError("STORE_FULL", "The idempotency store reached its file-size limit.")
    const contents = Buffer.from(serialized, "utf8")
    try {
      await atomicReplacePrivateFile(this.#filePath, contents)
    } catch (error) {
      throw new IdempotencyStoreError("INVALID_STATE", "The idempotency store could not be replaced safely.", error)
    } finally {
      contents.fill(0)
    }
  }

  protected async transact<T>(operation: (records: IdempotencyRecord[]) => { changed: boolean; result: T }): Promise<T> {
    try {
      await ensurePrivateDirectory(dirname(this.#filePath))
      return await withPrivateFileTransaction(this.#lockPath, async () => {
        const records = await this.#readState()
        const outcome = operation(records)
        if (outcome.changed) await this.#writeState(records)
        return cloneValue(outcome.result)
      }, {
        retryAttempts: this.#lockRetryCount + 1,
        retryDelayMs: this.#lockRetryMs,
      })
    } catch (error) {
      if (error instanceof IdempotencyStoreError) throw error
      const code = error instanceof PrivateFileError && error.code === "PRIVATE_FILE_BUSY"
        ? "LOCK_BUSY"
        : "INVALID_STATE"
      throw new IdempotencyStoreError(code, code === "LOCK_BUSY"
        ? "The idempotency store lock is busy."
        : "The idempotency transaction failed safely.", error)
    }
  }
}
