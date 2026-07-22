import { basename, dirname, isAbsolute } from "node:path"
import {
  acquirePrivateFileLock,
  atomicReplacePrivateFile,
  ensurePrivateDirectory,
  readPrivateFileIfExists,
  type OwnedPrivateFileLock,
} from "@pippit-bridge/core"
import {
  cloneState,
  emptyState,
  parseStoredState,
  storedStateSchema,
  type PippitAccountStore,
  type PippitAccountStoreMutation,
  type StoredState,
} from "./account-state.js"

const MAX_FILE_BYTES = 8 * 1024 * 1024

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve()

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release: (() => void) | undefined
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release?.()
    }
  }
}

export class FilePippitAccountStore implements PippitAccountStore {
  private readonly directoryPath: string
  private readonly filePath: string
  private readonly lockPath: string
  private readonly mutex = new AsyncMutex()

  constructor(filePath: string) {
    if (!isAbsolute(filePath) || basename(filePath).length === 0) {
      throw new Error("The Pippit account store path must be absolute.")
    }
    this.filePath = filePath
    this.directoryPath = dirname(filePath)
    this.lockPath = `${filePath}.lock`
  }

  async read(): Promise<StoredState> {
    return this.mutex.runExclusive(async () => {
      await this.ensureDirectory()
      return this.loadState()
    })
  }

  async update<T>(operation: (state: StoredState) => PippitAccountStoreMutation<T>): Promise<T> {
    return this.mutex.runExclusive(async () => {
      await this.ensureDirectory()
      const lock = await this.acquireLock()
      try {
        const current = await this.loadState()
        const mutation = operation(current)
        const next = storedStateSchema.parse(cloneState(mutation.state))
        if (next.revision !== current.revision) await this.persistState(next)
        return mutation.result
      } finally {
        await this.releaseLock(lock)
      }
    })
  }

  private async ensureDirectory(): Promise<void> {
    await ensurePrivateDirectory(this.directoryPath)
  }

  private async acquireLock(): Promise<OwnedPrivateFileLock> {
    try {
      return await acquirePrivateFileLock(this.lockPath)
    } catch {
      throw new Error("The Pippit account store is busy in another process.")
    }
  }

  private async releaseLock(lock: OwnedPrivateFileLock): Promise<void> {
    await lock.release()
  }

  private async loadState(): Promise<StoredState> {
    let contents: Buffer | undefined
    try {
      contents = await readPrivateFileIfExists(this.filePath, MAX_FILE_BYTES)
    } catch {
      throw new Error("The Pippit account store could not be opened.")
    }
    if (contents === undefined) return emptyState()
    try {
      const value: unknown = JSON.parse(contents.toString("utf8"))
      return parseStoredState(value)
    } catch {
      throw new Error("The Pippit account store is malformed.")
    } finally {
      contents.fill(0)
    }
  }

  private async persistState(state: StoredState): Promise<void> {
    const contents = Buffer.from(JSON.stringify(state), "utf8")
    if (contents.length > MAX_FILE_BYTES) throw new Error("The Pippit account store is too large.")
    try {
      await atomicReplacePrivateFile(this.filePath, contents)
    } catch {
      throw new Error("The Pippit account store could not be persisted.")
    } finally {
      contents.fill(0)
    }
  }
}
