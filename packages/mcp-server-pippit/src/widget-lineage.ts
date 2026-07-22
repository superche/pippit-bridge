import { createHash, randomBytes } from "node:crypto"
import { type Dirent, type Stats } from "node:fs"
import {
  lstat,
  readdir,
} from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import {
  createPrivateFileIfAbsent,
  ensurePrivateDirectory,
  readPrivateFile,
} from "@pippit-bridge/core"

const DEFAULT_MAX_DEPTH = 64
const MAX_JOB_ID_BYTES = 16_384
const MAX_RECORD_BYTES = 64 * 1024
const RECORD_NAME_PATTERN = /^(\d{13})-[a-f0-9]{32}\.json$/u

export const PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_NAME = "pippit_resolve_latest_video"

interface LineageCandidate {
  readonly childJobId: string
  readonly recordId: string
}

interface LineageRecord {
  readonly child_job_id: string
  readonly created_at_ms: number
  readonly schema_version: 1
  readonly source_job_id: string
}

export interface PippitWidgetLineageStore {
  record(sourceJobId: string, childJobId: string): Promise<void>
  resolve(anchorJobId: string): Promise<string>
  track(sourceJobId: string, completion: Promise<unknown>): void
}

export interface PippitPersistentWidgetLineageStoreOptions {
  readonly maxDepth?: number
  readonly root: string | (() => Promise<string>)
  readonly scope: string | (() => Promise<string>)
}

function validateJobId(value: string, label: string): void {
  if (value.trim() === "" || Buffer.byteLength(value, "utf8") > MAX_JOB_ID_BYTES) {
    throw new Error(`${label} is invalid.`)
  }
}

function validateMaxDepth(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 256) {
    throw new Error("Widget lineage depth must be an integer between 1 and 256.")
  }
}

function privateOwner(stats: Stats): boolean {
  return typeof process.getuid !== "function" || stats.uid === process.getuid()
}

async function existingPrivateDirectory(path: string): Promise<boolean> {
  let stats: Stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
  if (!stats.isDirectory() || stats.isSymbolicLink() || !privateOwner(stats)) {
    throw new Error("The Pippit widget lineage directory is unsafe.")
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error("The Pippit widget lineage directory is not private.")
  }
  return true
}

function identityHash(prefix: string, value: string): string {
  return createHash("sha256").update(prefix, "utf8").update("\0", "utf8").update(value, "utf8").digest("hex")
}

function parseRecord(value: unknown, sourceJobId: string, recordId: string): LineageRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Pippit widget lineage record is invalid.")
  }
  const candidate = value as Partial<LineageRecord>
  if (
    candidate.schema_version !== 1 ||
    candidate.source_job_id !== sourceJobId ||
    typeof candidate.child_job_id !== "string" ||
    candidate.child_job_id === sourceJobId ||
    !Number.isSafeInteger(candidate.created_at_ms) ||
    candidate.created_at_ms! < 0 ||
    recordId.slice(0, 13) !== String(candidate.created_at_ms).padStart(13, "0")
  ) {
    throw new Error("The Pippit widget lineage record is invalid.")
  }
  validateJobId(candidate.child_job_id, "Child job id")
  return candidate as LineageRecord
}

async function readPrivateRecord(path: string, sourceJobId: string, recordId: string): Promise<LineageRecord> {
  const contents = await readPrivateFile(path, MAX_RECORD_BYTES)
  return parseRecord(JSON.parse(contents.toString("utf8")) as unknown, sourceJobId, recordId)
}

function latestRecordName(entries: readonly Dirent[]): string | undefined {
  return entries
    .filter(entry => RECORD_NAME_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort()
    .at(-1)
}

function createPendingTracker(): {
  track(sourceJobId: string, completion: Promise<unknown>): void
  wait(sourceJobId: string): Promise<void>
} {
  const pending = new Map<string, Set<Promise<void>>>()
  return {
    track(sourceJobId, completion) {
      validateJobId(sourceJobId, "Source job id")
      const tracked = Promise.resolve(completion).then(() => undefined, () => undefined)
      let sourcePending = pending.get(sourceJobId)
      if (sourcePending === undefined) {
        sourcePending = new Set()
        pending.set(sourceJobId, sourcePending)
      }
      sourcePending.add(tracked)
      void tracked.finally(() => {
        sourcePending?.delete(tracked)
        if (sourcePending?.size === 0) pending.delete(sourceJobId)
      })
    },
    async wait(sourceJobId) {
      while (true) {
        const active = pending.get(sourceJobId)
        if (active === undefined || active.size === 0) return
        await Promise.all(active)
      }
    },
  }
}

export function createInMemoryPippitWidgetLineageStore(
  maxDepth = DEFAULT_MAX_DEPTH,
): PippitWidgetLineageStore {
  validateMaxDepth(maxDepth)
  const tracker = createPendingTracker()
  const latest = new Map<string, string>()
  return {
    async record(sourceJobId, childJobId) {
      validateJobId(sourceJobId, "Source job id")
      validateJobId(childJobId, "Child job id")
      if (sourceJobId === childJobId) throw new Error("A regenerated job cannot refer to itself.")
      latest.set(sourceJobId, childJobId)
    },
    async resolve(anchorJobId) {
      validateJobId(anchorJobId, "Anchor job id")
      const visited = new Set<string>()
      let current = anchorJobId
      for (let depth = 0; depth < maxDepth; depth += 1) {
        if (visited.has(current)) throw new Error("The Pippit widget lineage contains a cycle.")
        visited.add(current)
        await tracker.wait(current)
        const child = latest.get(current)
        if (child === undefined) return current
        current = child
      }
      throw new Error("The Pippit widget lineage is too deep.")
    },
    track: tracker.track,
  }
}

export function createPersistentPippitWidgetLineageStore(
  options: PippitPersistentWidgetLineageStoreOptions,
): PippitWidgetLineageStore {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  validateMaxDepth(maxDepth)
  const tracker = createPendingTracker()
  const memory = new Map<string, LineageCandidate>()
  let scopeRootPromise: Promise<string> | undefined

  const resolveScopeRoot = async (): Promise<string> => {
    scopeRootPromise ??= (async () => {
      const configuredRoot = typeof options.root === "string" ? options.root : await options.root()
      const scope = typeof options.scope === "string" ? options.scope : await options.scope()
      if (!isAbsolute(configuredRoot) || scope.trim() === "") {
        throw new Error("The Pippit widget lineage configuration is invalid.")
      }
      const root = resolve(configuredRoot)
      const scopeRoot = join(root, identityHash("pippit-widget-lineage-scope", scope))
      await ensurePrivateDirectory(root)
      await ensurePrivateDirectory(scopeRoot)
      return scopeRoot
    })().catch((error: unknown) => {
      scopeRootPromise = undefined
      throw error
    })
    return await scopeRootPromise
  }

  const sourceDirectory = async (sourceJobId: string): Promise<string> => {
    return join(await resolveScopeRoot(), identityHash("pippit-widget-lineage-source", sourceJobId))
  }

  const latestCandidate = async (sourceJobId: string): Promise<LineageCandidate | undefined> => {
    const memoryCandidate = memory.get(sourceJobId)
    const directory = await sourceDirectory(sourceJobId)
    if (!await existingPrivateDirectory(directory)) return memoryCandidate
    const entries: Dirent[] = await readdir(directory, { withFileTypes: true })
    const recordId = latestRecordName(entries)
    if (recordId === undefined) return memoryCandidate
    const record = await readPrivateRecord(join(directory, recordId), sourceJobId, recordId)
    const diskCandidate = { childJobId: record.child_job_id, recordId }
    if (memoryCandidate === undefined || diskCandidate.recordId > memoryCandidate.recordId) return diskCandidate
    return memoryCandidate
  }

  return {
    async record(sourceJobId, childJobId) {
      validateJobId(sourceJobId, "Source job id")
      validateJobId(childJobId, "Child job id")
      if (sourceJobId === childJobId) throw new Error("A regenerated job cannot refer to itself.")
      const createdAtMs = Date.now()
      const recordId = `${String(createdAtMs).padStart(13, "0")}-${randomBytes(16).toString("hex")}.json`
      const candidate = { childJobId, recordId }
      const present = memory.get(sourceJobId)
      if (present === undefined || candidate.recordId > present.recordId) memory.set(sourceJobId, candidate)

      const directory = await sourceDirectory(sourceJobId)
      await ensurePrivateDirectory(directory)
      const path = join(directory, recordId)
      const record: LineageRecord = {
        child_job_id: childJobId,
        created_at_ms: createdAtMs,
        schema_version: 1,
        source_job_id: sourceJobId,
      }
      const created = await createPrivateFileIfAbsent(path, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"))
      if (created !== "created") throw new Error("The Pippit widget lineage record already exists.")
    },
    async resolve(anchorJobId) {
      validateJobId(anchorJobId, "Anchor job id")
      const visited = new Set<string>()
      let current = anchorJobId
      for (let depth = 0; depth < maxDepth; depth += 1) {
        if (visited.has(current)) throw new Error("The Pippit widget lineage contains a cycle.")
        visited.add(current)
        await tracker.wait(current)
        const candidate = await latestCandidate(current)
        if (candidate === undefined) return current
        current = candidate.childJobId
      }
      throw new Error("The Pippit widget lineage is too deep.")
    },
    track: tracker.track,
  }
}
