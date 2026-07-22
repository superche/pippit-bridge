import { randomUUID } from "node:crypto"
import { basename, dirname, isAbsolute } from "node:path"
import {
  atomicReplacePrivateFile,
  ensurePrivateDirectory,
  PrivateFileError,
  PrivateFileLifetimeLock,
  readPrivateFileIfExists,
} from "@pippit-bridge/core"
import { z } from "zod"
import {
  ByokStoreError,
  byokCredentialCreateSchema,
  type ByokCredentialSeed,
  type FileByokStoreOptions,
  type MemoryByokStoreOptions,
} from "./contracts.js"
import { ByokEnvelopeCodec, type DecodedByokEnvelope } from "./codec.js"
import { AbstractByokStore } from "./repository.js"
import { createRecord, emptyState, storedStateSchema, type StoredState } from "./state.js"

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024

export class MemoryByokStore extends AbstractByokStore {
  constructor(options: MemoryByokStoreOptions = {}) {
    super(options)
    const records = (options.seed ?? []).map((item, index) => {
      const {
        created_at: seededCreatedAt,
        id: seededId,
        key_version_id: seededVersionId,
        sort_order: seededSortOrder,
        ...input
      } = item
      const parsed = byokCredentialCreateSchema.parse({
        ...input,
        workspace_id: input.workspace_id ?? options.workspaceId,
      })
      return createRecord(parsed, {
        createdAt: z.iso.datetime().parse(seededCreatedAt ?? new Date().toISOString()),
        id: z.uuid().parse(seededId ?? randomUUID()),
        keyVersionId: z.uuid().parse(seededVersionId ?? randomUUID()),
        sortOrder: z.number().int().nonnegative().parse(seededSortOrder ?? index),
      })
    })
    const parsedState = storedStateSchema.parse({
      active_selections: [],
      credentials: records,
      revision: records.length,
    })
    this.assertStateWithinLimit(parsedState)
    this.state = parsedState
  }

  protected async persist(_state: StoredState): Promise<void> {}
  protected async prepare(): Promise<void> {}
}

export class FileByokStore extends AbstractByokStore {
  private readonly codec: ByokEnvelopeCodec
  private readonly directoryPath: string
  private fatalError: ByokStoreError | undefined
  private readonly filePath: string
  private lifetimeLock: PrivateFileLifetimeLock | undefined
  private readonly lockPath: string
  private readonly maxFileBytes: number
  private readonly ready: Promise<void>

  constructor(options: FileByokStoreOptions) {
    super(options)
    if (!isAbsolute(options.filePath) || basename(options.filePath).length === 0) {
      throw new ByokStoreError("INVALID_CONFIGURATION", "The BYOK store file path must be absolute.")
    }
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 512 || maxFileBytes > 128 * 1024 * 1024) {
      throw new ByokStoreError(
        "INVALID_CONFIGURATION",
        "maxFileBytes must be an integer from 512 bytes to 128 MiB.",
      )
    }
    this.filePath = options.filePath
    this.directoryPath = dirname(options.filePath)
    this.lockPath = `${options.filePath}.lock`
    this.maxFileBytes = maxFileBytes
    this.codec = new ByokEnvelopeCodec(options)
    this.ready = this.initialize()
  }

  static async open(options: FileByokStoreOptions): Promise<FileByokStore> {
    const store = new FileByokStore(options)
    try {
      await store.prepare()
      return store
    } catch (error) {
      await store.releaseLock().catch(() => undefined)
      store.codec.destroy()
      throw error
    }
  }

  override async close(): Promise<void> {
    try {
      await super.close()
    } finally {
      try { await this.releaseLock() } finally { this.codec.destroy() }
    }
  }

  protected async persist(state: StoredState): Promise<void> {
    await this.persistState(state)
  }

  protected async prepare(): Promise<void> {
    await this.ready
    if (this.fatalError !== undefined) throw this.fatalError
  }

  private async initialize(): Promise<void> {
    try {
      await this.ensureDirectory()
      await this.acquireLock()
      const loaded = await this.loadState()
      if (loaded === undefined) {
        const initial = emptyState()
        await this.persistState(initial)
        this.state = initial
        return
      }
      this.assertStateWithinLimit(loaded.state)
      this.state = loaded.state
      if (loaded.keyId !== this.codec.activeKeyId) await this.persistState(loaded.state)
    } catch (error) {
      const normalized = error instanceof ByokStoreError
        ? error
        : new ByokStoreError("STORE_IO_ERROR", "The BYOK credential store could not be initialized.")
      this.fatalError = normalized
      await this.releaseLock().catch(() => undefined)
      throw normalized
    }
  }

  private async acquireLock(): Promise<void> {
    try {
      this.lifetimeLock = await PrivateFileLifetimeLock.acquire(this.lockPath)
    } catch {
      await this.releaseLock().catch(() => undefined)
      throw new ByokStoreError(
        "STORE_IO_ERROR",
        "The BYOK store lock is unavailable. Verify no provider process is running before removing a stale lock.",
      )
    }
  }

  private async releaseLock(): Promise<void> {
    const lock = this.lifetimeLock
    if (lock === undefined) return
    this.lifetimeLock = undefined
    await lock.close()
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await ensurePrivateDirectory(this.directoryPath)
    } catch {
      throw new ByokStoreError("STORE_IO_ERROR", "The BYOK store parent path is unsafe.")
    }
  }

  private async loadState(): Promise<DecodedByokEnvelope | undefined> {
    let contents: Buffer | undefined
    try {
      contents = await readPrivateFileIfExists(this.filePath, this.maxFileBytes)
    } catch {
      throw new ByokStoreError("STORE_IO_ERROR", "The BYOK credential store could not be opened.")
    }
    if (contents === undefined) return undefined
    try {
      return this.codec.decode(contents)
    } finally {
      contents.fill(0)
    }
  }

  private async persistState(state: StoredState): Promise<void> {
    const contents = this.codec.encode(state, this.maxFileBytes)
    try {
      await atomicReplacePrivateFile(this.filePath, contents)
    } catch (error) {
      if (error instanceof PrivateFileError && error.code === "DURABILITY_UNCERTAIN") {
        const fatal = new ByokStoreError(
          "STORE_DURABILITY_UNCERTAIN",
          "The BYOK store was replaced but its directory entry could not be synchronized.",
        )
        this.fatalError = fatal
        throw fatal
      }
      if (error instanceof ByokStoreError) throw error
      throw new ByokStoreError("STORE_IO_ERROR", "The BYOK credential store could not be persisted.")
    } finally {
      contents.fill(0)
    }
  }
}

export type { ByokCredentialSeed }
