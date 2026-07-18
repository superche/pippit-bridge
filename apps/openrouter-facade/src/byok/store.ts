import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"
import { z } from "zod"
import {
  ByokStoreError,
  byokCredentialCreateSchema,
  byokCredentialListQuerySchema,
  byokCredentialUpdateSchema,
  type ByokCredential,
  type ByokCredentialCreateInput,
  type ByokCredentialList,
  type ByokCredentialListQuery,
  type ByokCredentialSeed,
  type ByokCredentialUpdateInput,
  type ByokKeyVersion,
  type ByokResolveInput,
  type ByokStore,
  type ByokStoreRuntimeOptions,
  type FileByokStoreOptions,
  type MemoryByokStoreOptions,
  type ResolvedByokCredential,
} from "./contracts.js"

const STORE_FORMAT = "pippit-byok-store"
const STORE_VERSION = 1
const DEFAULT_KEY_ID = "v1"
const DEFAULT_AAD_CONTEXT = "pippit-bridge"
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
const DEFAULT_MAX_CREDENTIALS = 100
const GCM_NONCE_BYTES = 12
const GCM_TAG_BYTES = 16
const MAX_KEY_VERSIONS_PER_CREDENTIAL = 100

const storedAccessKeySchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/u)
const storedStringListSchema = z.array(z.string().min(1).max(256)).max(100)
const storedApiKeyHashListSchema = z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(100)
const storedKeyVersionSchema = z
  .object({
    access_key: storedAccessKeySchema,
    created_at: z.iso.datetime(),
    id: z.uuid(),
  })
  .strict()
const storedCredentialSchema = z
  .object({
    active_key_version_id: z.uuid(),
    allowed_api_key_hashes: storedApiKeyHashListSchema.nullable(),
    allowed_models: storedStringListSchema.nullable(),
    allowed_user_ids: storedStringListSchema.nullable(),
    created_at: z.iso.datetime(),
    disabled: z.boolean(),
    id: z.uuid(),
    is_fallback: z.boolean(),
    key_versions: z.array(storedKeyVersionSchema).min(1).max(MAX_KEY_VERSIONS_PER_CREDENTIAL),
    label: z.string().min(1).max(128),
    name: z.string().min(1).max(128).nullable(),
    provider: z.literal("pippit"),
    sort_order: z.number().int().nonnegative(),
    workspace_id: z.uuid(),
  })
  .strict()
  .superRefine((credential, context) => {
    const versionIds = credential.key_versions.map((version) => version.id)
    if (new Set(versionIds).size !== versionIds.length) {
      context.addIssue({ code: "custom", message: "Credential key version ids must be unique" })
    }
    if (!versionIds.includes(credential.active_key_version_id)) {
      context.addIssue({ code: "custom", message: "The active key version does not exist" })
    }
  })
const storedStateSchema = z
  .object({
    credentials: z.array(storedCredentialSchema),
    revision: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((state, context) => {
    const credentialIds = state.credentials.map((credential) => credential.id)
    if (new Set(credentialIds).size !== credentialIds.length) {
      context.addIssue({ code: "custom", message: "Credential ids must be unique" })
    }
  })
const envelopeSchema = z
  .object({
    ciphertext: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/u),
    format: z.literal(STORE_FORMAT),
    key_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u),
    nonce: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/u),
    tag: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/u),
    version: z.literal(STORE_VERSION),
  })
  .strict()
const resolveInputSchema = z
  .object({
    apiKeyHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    credentialId: z.uuid().optional(),
    model: z.string().trim().min(1).max(256),
    provider: z.literal("pippit").default("pippit"),
    userId: z.string().trim().min(1).max(256).optional(),
    workspaceId: z.uuid(),
  })
  .strict()

type ParsedCreate = z.output<typeof byokCredentialCreateSchema>
type ParsedUpdate = z.output<typeof byokCredentialUpdateSchema>
type StoredCredential = z.output<typeof storedCredentialSchema>
type StoredKeyVersion = z.output<typeof storedKeyVersionSchema>
type StoredState = z.output<typeof storedStateSchema>

interface RecordMetadata {
  readonly createdAt: string
  readonly id: string
  readonly keyVersionId: string
  readonly sortOrder: number
}

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

function emptyState(): StoredState {
  return { credentials: [], revision: 0 }
}

function copyList(value: readonly string[] | null): string[] | null {
  return value === null ? null : [...value]
}

function publicCredential(credential: StoredCredential): ByokCredential {
  return {
    allowed_api_key_hashes: copyList(credential.allowed_api_key_hashes),
    allowed_models: copyList(credential.allowed_models),
    allowed_user_ids: copyList(credential.allowed_user_ids),
    created_at: credential.created_at,
    disabled: credential.disabled,
    id: credential.id,
    is_fallback: credential.is_fallback,
    label: credential.label,
    name: credential.name,
    provider: credential.provider,
    sort_order: credential.sort_order,
    workspace_id: credential.workspace_id,
  }
}

function createRecord(input: ParsedCreate, metadata: RecordMetadata): StoredCredential {
  return {
    active_key_version_id: metadata.keyVersionId,
    allowed_api_key_hashes: copyList(input.allowed_api_key_hashes),
    allowed_models: copyList(input.allowed_models),
    allowed_user_ids: copyList(input.allowed_user_ids),
    created_at: metadata.createdAt,
    disabled: input.disabled,
    id: metadata.id,
    is_fallback: input.is_fallback,
    key_versions: [
      {
        access_key: input.key,
        created_at: metadata.createdAt,
        id: metadata.keyVersionId,
      },
    ],
    label: maskedAccessKey(input.key),
    name: input.name,
    provider: input.provider,
    sort_order: metadata.sortOrder,
    workspace_id: input.workspace_id,
  }
}

function updateRecord(
  credential: StoredCredential,
  input: ParsedUpdate,
  keyVersionId: string,
  createdAt: string,
): StoredCredential {
  const nextVersion: StoredKeyVersion | undefined =
    input.key === undefined
      ? undefined
      : { access_key: input.key, created_at: createdAt, id: keyVersionId }
  return {
    ...credential,
    active_key_version_id: nextVersion?.id ?? credential.active_key_version_id,
    allowed_api_key_hashes:
      input.allowed_api_key_hashes === undefined
        ? credential.allowed_api_key_hashes
        : copyList(input.allowed_api_key_hashes),
    allowed_models:
      input.allowed_models === undefined ? credential.allowed_models : copyList(input.allowed_models),
    allowed_user_ids:
      input.allowed_user_ids === undefined
        ? credential.allowed_user_ids
        : copyList(input.allowed_user_ids),
    disabled: input.disabled ?? credential.disabled,
    is_fallback: input.is_fallback ?? credential.is_fallback,
    key_versions: nextVersion === undefined ? credential.key_versions : [...credential.key_versions, nextVersion],
    label: nextVersion === undefined ? credential.label : maskedAccessKey(nextVersion.access_key),
    name: input.name === undefined ? credential.name : input.name,
  }
}

function maskedAccessKey(accessKey: string): string {
  const prefix = accessKey.startsWith("ak-") ? "ak-" : ""
  const suffix = accessKey.length >= 12 ? accessKey.slice(-4) : ""
  return `${prefix}****${suffix}`
}

function activeVersion(credential: StoredCredential): StoredKeyVersion {
  const version = credential.key_versions.find((candidate) => candidate.id === credential.active_key_version_id)
  if (version === undefined) {
    throw new ByokStoreError("STORE_CORRUPT", "The BYOK credential references a missing key version.")
  }
  return version
}

function resolvedCredential(
  credential: StoredCredential,
  version: StoredKeyVersion,
): ResolvedByokCredential {
  const keyVersion: ByokKeyVersion = { created_at: version.created_at, id: version.id }
  return {
    accessKey: version.access_key,
    credential: publicCredential(credential),
    keyVersion,
  }
}

function listMatches(filter: readonly string[] | null, value: string | undefined): boolean {
  return filter === null || (value !== undefined && filter.includes(value))
}

function byRoutingOrder(left: StoredCredential, right: StoredCredential): number {
  if (left.is_fallback !== right.is_fallback) return left.is_fallback ? 1 : -1
  return (
    left.sort_order - right.sort_order ||
    left.created_at.localeCompare(right.created_at) ||
    left.id.localeCompare(right.id)
  )
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function decodeBase64Url(value: string, expectedLength: number | undefined): Buffer {
  const decoded = Buffer.from(value, "base64url")
  if (decoded.toString("base64url") !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) {
    throw new ByokStoreError("STORE_CORRUPT", "The BYOK credential store envelope is malformed.")
  }
  return decoded
}

function normalizeMasterKey(value: Uint8Array, label: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new ByokStoreError("INVALID_CONFIGURATION", `${label} must contain exactly 32 bytes.`)
  }
  return Buffer.from(value)
}

function validateRuntimeOptions(options: ByokStoreRuntimeOptions): {
  readonly idFactory: () => string
  readonly maxCredentials: number
  readonly now: () => Date
  readonly workspaceId: string
} {
  const maxCredentials = options.maxCredentials ?? DEFAULT_MAX_CREDENTIALS
  if (!Number.isSafeInteger(maxCredentials) || maxCredentials < 1 || maxCredentials > 10_000) {
    throw new ByokStoreError("INVALID_CONFIGURATION", "maxCredentials must be an integer from 1 to 10000.")
  }
  return {
    idFactory: options.idFactory ?? randomUUID,
    maxCredentials,
    now: options.now ?? (() => new Date()),
    workspaceId: z.uuid().parse(options.workspaceId ?? "00000000-0000-0000-0000-000000000000"),
  }
}

abstract class AbstractByokStore implements ByokStore {
  protected state: StoredState = emptyState()
  private closed = false
  private readonly idFactory: () => string
  private readonly maxCredentials: number
  private readonly mutex = new AsyncMutex()
  private readonly now: () => Date
  private readonly workspaceId: string

  protected constructor(options: ByokStoreRuntimeOptions) {
    const validated = validateRuntimeOptions(options)
    this.idFactory = validated.idFactory
    this.maxCredentials = validated.maxCredentials
    this.now = validated.now
    this.workspaceId = validated.workspaceId
  }

  async create(input: ByokCredentialCreateInput): Promise<ByokCredential> {
    const parsed = byokCredentialCreateSchema.parse({
      ...input,
      workspace_id: input.workspace_id ?? this.workspaceId,
    })
    this.assertWorkspace(parsed.workspace_id)
    await this.prepare()
    return this.mutex.runExclusive(async () => {
      this.assertOpen()
      if (this.state.credentials.length >= this.maxCredentials) {
        throw new ByokStoreError(
          "CREDENTIAL_LIMIT_EXCEEDED",
          `The BYOK credential store supports at most ${this.maxCredentials} credentials.`,
        )
      }
      const createdAt = this.timestamp()
      const record = createRecord(parsed, {
        createdAt,
        id: this.newUuid("credential"),
        keyVersionId: this.newUuid("credential key version"),
        sortOrder: this.state.credentials.reduce(
          (highest, credential) => Math.max(highest, credential.sort_order + 1),
          0,
        ),
      })
      const next = {
        credentials: [...this.state.credentials, record],
        revision: this.state.revision + 1,
      }
      await this.persist(next)
      this.state = next
      return publicCredential(record)
    })
  }

  async list(query: ByokCredentialListQuery = {}): Promise<ByokCredentialList> {
    const parsed = byokCredentialListQuerySchema.parse(query)
    await this.prepare()
    this.assertOpen()
    const matching = this.state.credentials
      .filter(
        (credential) =>
          (parsed.provider === undefined || credential.provider === parsed.provider) &&
          (parsed.workspace_id === undefined || credential.workspace_id === parsed.workspace_id),
      )
      .sort(byRoutingOrder)
    return {
      data: matching.slice(parsed.offset, parsed.offset + parsed.limit).map(publicCredential),
      total_count: matching.length,
    }
  }

  async get(id: string): Promise<ByokCredential | undefined> {
    await this.prepare()
    this.assertOpen()
    const credential = this.state.credentials.find((candidate) => candidate.id === id)
    return credential === undefined ? undefined : publicCredential(credential)
  }

  async getWorkspaceId(): Promise<string> {
    await this.prepare()
    this.assertOpen()
    return this.workspaceId
  }

  async update(id: string, input: ByokCredentialUpdateInput): Promise<ByokCredential | undefined> {
    const parsed = byokCredentialUpdateSchema.parse(input)
    await this.prepare()
    return this.mutex.runExclusive(async () => {
      this.assertOpen()
      const index = this.state.credentials.findIndex((credential) => credential.id === id)
      const existing = this.state.credentials[index]
      if (existing === undefined) return undefined
      if (parsed.key !== undefined && existing.key_versions.length >= MAX_KEY_VERSIONS_PER_CREDENTIAL) {
        throw new ByokStoreError(
          "CREDENTIAL_LIMIT_EXCEEDED",
          `A BYOK credential supports at most ${MAX_KEY_VERSIONS_PER_CREDENTIAL} retained key versions.`,
        )
      }
      const updated = updateRecord(
        existing,
        parsed,
        this.newUuid("credential key version"),
        this.timestamp(),
      )
      const credentials = [...this.state.credentials]
      credentials[index] = updated
      const next = { credentials, revision: this.state.revision + 1 }
      await this.persist(next)
      this.state = next
      return publicCredential(updated)
    })
  }

  async delete(id: string): Promise<boolean> {
    await this.prepare()
    return this.mutex.runExclusive(async () => {
      this.assertOpen()
      const credentials = this.state.credentials.filter((credential) => credential.id !== id)
      if (credentials.length === this.state.credentials.length) return false
      const next = { credentials, revision: this.state.revision + 1 }
      await this.persist(next)
      this.state = next
      return true
    })
  }

  async resolveCandidates(input: ByokResolveInput): Promise<readonly ResolvedByokCredential[]> {
    const parsed = resolveInputSchema.parse(input)
    await this.prepare()
    this.assertOpen()
    return this.state.credentials
      .filter(
        (credential) =>
          !credential.disabled &&
          (parsed.credentialId === undefined || credential.id === parsed.credentialId) &&
          credential.provider === parsed.provider &&
          credential.workspace_id === parsed.workspaceId &&
          listMatches(credential.allowed_models, parsed.model) &&
          listMatches(credential.allowed_api_key_hashes, parsed.apiKeyHash) &&
          listMatches(credential.allowed_user_ids, parsed.userId),
      )
      .sort(byRoutingOrder)
      .map((credential) => resolvedCredential(credential, activeVersion(credential)))
  }

  async getVersion(
    credentialId: string,
    keyVersionId: string,
  ): Promise<ResolvedByokCredential | undefined> {
    await this.prepare()
    this.assertOpen()
    const credential = this.state.credentials.find((candidate) => candidate.id === credentialId)
    const version = credential?.key_versions.find((candidate) => candidate.id === keyVersionId)
    return credential === undefined || version === undefined
      ? undefined
      : resolvedCredential(credential, version)
  }

  async close(): Promise<void> {
    let prepareError: unknown
    try {
      await this.prepare()
    } catch (error) {
      prepareError = error
    }
    await this.mutex.runExclusive(async () => {
      this.closed = true
      this.state = emptyState()
    })
    if (prepareError !== undefined) throw prepareError
  }

  protected assertStateWithinLimit(state: StoredState): void {
    if (state.credentials.length > this.maxCredentials) {
      throw new ByokStoreError(
        "STORE_CORRUPT",
        `The BYOK credential store exceeds its ${this.maxCredentials} credential limit.`,
      )
    }
    if (state.credentials.some((credential) => credential.workspace_id !== this.workspaceId)) {
      throw new ByokStoreError(
        "STORE_CORRUPT",
        "The BYOK credential store contains a credential from a different workspace.",
      )
    }
  }

  protected abstract persist(state: StoredState): Promise<void>

  protected abstract prepare(): Promise<void>

  private assertOpen(): void {
    if (this.closed) throw new ByokStoreError("STORE_CLOSED", "The BYOK credential store is closed.")
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.workspaceId) {
      throw new ByokStoreError(
        "INVALID_CONFIGURATION",
        "The credential workspace does not match this single-workspace BYOK store.",
      )
    }
  }

  private newUuid(label: string): string {
    const id = this.idFactory()
    if (!z.uuid().safeParse(id).success) {
      throw new ByokStoreError("INVALID_CONFIGURATION", `The configured ${label} factory must return a UUID.`)
    }
    return id
  }

  private timestamp(): string {
    const timestamp = this.now().toISOString()
    if (!z.iso.datetime().safeParse(timestamp).success) {
      throw new ByokStoreError("INVALID_CONFIGURATION", "The configured BYOK clock returned an invalid date.")
    }
    return timestamp
  }
}

export class MemoryByokStore extends AbstractByokStore {
  constructor(options: MemoryByokStoreOptions = {}) {
    super(options)
    const seed = options.seed ?? []
    const records = seed.map((item, index) => {
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
      const createdAt = z.iso.datetime().parse(seededCreatedAt ?? new Date().toISOString())
      const id = z.uuid().parse(seededId ?? randomUUID())
      const keyVersionId = z.uuid().parse(seededVersionId ?? randomUUID())
      const sortOrder = z.number().int().nonnegative().parse(seededSortOrder ?? index)
      return createRecord(parsed, { createdAt, id, keyVersionId, sortOrder })
    })
    const parsedState = storedStateSchema.parse({ credentials: records, revision: records.length })
    this.assertStateWithinLimit(parsedState)
    this.state = parsedState
  }

  protected async persist(_state: StoredState): Promise<void> {}

  protected async prepare(): Promise<void> {}
}

export class FileByokStore extends AbstractByokStore {
  private readonly aadContext: string
  private readonly activeKey: Buffer
  private readonly activeKeyId: string
  private readonly directoryPath: string
  private fatalError: ByokStoreError | undefined
  private readonly filePath: string
  private readonly keys = new Map<string, Buffer>()
  private lockHandle: FileHandle | undefined
  private readonly lockPath: string
  private readonly maxFileBytes: number
  private readonly ready: Promise<void>

  constructor(options: FileByokStoreOptions) {
    super(options)
    if (!isAbsolute(options.filePath) || basename(options.filePath).length === 0) {
      throw new ByokStoreError("INVALID_CONFIGURATION", "The BYOK store file path must be absolute.")
    }
    const activeKeyId = options.keyId ?? DEFAULT_KEY_ID
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(activeKeyId)) {
      throw new ByokStoreError("INVALID_CONFIGURATION", "The active BYOK key id is invalid.")
    }
    const aadContext = options.aadContext ?? DEFAULT_AAD_CONTEXT
    const containsControlCharacter = [...aadContext].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint < 32 || codePoint === 127
    })
    if (aadContext.length < 1 || aadContext.length > 256 || containsControlCharacter) {
      throw new ByokStoreError("INVALID_CONFIGURATION", "The BYOK AAD context is invalid.")
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
    this.activeKeyId = activeKeyId
    this.aadContext = aadContext
    this.maxFileBytes = maxFileBytes
    this.activeKey = normalizeMasterKey(options.masterKey, "masterKey")
    this.keys.set(activeKeyId, this.activeKey)
    for (const [keyId, key] of Object.entries(options.previousMasterKeys ?? {})) {
      if (!/^[A-Za-z0-9._-]{1,128}$/u.test(keyId) || keyId === activeKeyId) {
        throw new ByokStoreError("INVALID_CONFIGURATION", "A previous BYOK key id is invalid or duplicated.")
      }
      this.keys.set(keyId, normalizeMasterKey(key, `previousMasterKeys.${keyId}`))
    }
    this.ready = this.initialize()
  }

  static async open(options: FileByokStoreOptions): Promise<FileByokStore> {
    const store = new FileByokStore(options)
    try {
      await store.prepare()
      return store
    } catch (error) {
      await store.releaseLock().catch(() => undefined)
      store.destroyKeys()
      throw error
    }
  }

  override async close(): Promise<void> {
    try {
      await super.close()
    } finally {
      try {
        await this.releaseLock()
      } finally {
        this.destroyKeys()
      }
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
      if (loaded.keyId !== this.activeKeyId) await this.persistState(loaded.state)
    } catch (error) {
      const normalized =
        error instanceof ByokStoreError
          ? error
          : new ByokStoreError("STORE_IO_ERROR", "The BYOK credential store could not be initialized.")
      this.fatalError = normalized
      await this.releaseLock().catch(() => undefined)
      throw normalized
    }
  }

  private async acquireLock(): Promise<void> {
    try {
      const handle = await open(
        this.lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      this.lockHandle = handle
      await handle.writeFile(JSON.stringify({ created_at: new Date().toISOString(), pid: process.pid }))
      await handle.sync()
    } catch {
      await this.releaseLock().catch(() => undefined)
      throw new ByokStoreError(
        "STORE_IO_ERROR",
        "The BYOK store lock is unavailable. Verify no provider process is running before removing a stale lock.",
      )
    }
  }

  private async releaseLock(): Promise<void> {
    const handle = this.lockHandle
    if (handle === undefined) return
    this.lockHandle = undefined
    await handle.close().catch(() => undefined)
    await unlink(this.lockPath)
  }

  private destroyKeys(): void {
    for (const key of this.keys.values()) key.fill(0)
    this.keys.clear()
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directoryPath, { mode: 0o700, recursive: true })
    const directory = await lstat(this.directoryPath)
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new ByokStoreError("STORE_IO_ERROR", "The BYOK store parent path must be a real directory.")
    }
    if (process.platform !== "win32") {
      if ((directory.mode & 0o077) !== 0) {
        throw new ByokStoreError("STORE_IO_ERROR", "The BYOK store directory permissions must be 0700 or stricter.")
      }
      if (process.getuid !== undefined && directory.uid !== process.getuid()) {
        throw new ByokStoreError("STORE_IO_ERROR", "The BYOK store directory must be owned by the service user.")
      }
    }
  }

  private async loadState(): Promise<{ readonly keyId: string; readonly state: StoredState } | undefined> {
    let handle
    try {
      handle = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined
      throw new ByokStoreError("STORE_IO_ERROR", "The BYOK credential store could not be opened.")
    }

    try {
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new ByokStoreError("STORE_IO_ERROR", "The BYOK store path must be a regular, unlinked file.")
      }
      if (process.platform !== "win32") {
        if ((metadata.mode & 0o077) !== 0) {
          throw new ByokStoreError("STORE_IO_ERROR", "The BYOK store file permissions must be 0600 or stricter.")
        }
        if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
          throw new ByokStoreError("STORE_IO_ERROR", "The BYOK store file must be owned by the service user.")
        }
      }
      if (metadata.size < 1 || metadata.size > this.maxFileBytes) {
        throw new ByokStoreError("STORE_CORRUPT", "The BYOK credential store has an invalid size.")
      }
      const contents = await handle.readFile()
      return this.decryptEnvelope(contents)
    } finally {
      await handle.close()
    }
  }

  private decryptEnvelope(contents: Buffer): { readonly keyId: string; readonly state: StoredState } {
    let envelope: z.output<typeof envelopeSchema>
    try {
      const raw: unknown = JSON.parse(contents.toString("utf8"))
      envelope = envelopeSchema.parse(raw)
    } catch {
      throw new ByokStoreError("STORE_CORRUPT", "The BYOK credential store envelope is malformed.")
    }

    const key = this.keys.get(envelope.key_id)
    if (key === undefined) {
      throw new ByokStoreError("STORE_CORRUPT", "The BYOK credential store uses an unavailable master key.")
    }
    const nonce = decodeBase64Url(envelope.nonce, GCM_NONCE_BYTES)
    const tag = decodeBase64Url(envelope.tag, GCM_TAG_BYTES)
    const ciphertext = decodeBase64Url(envelope.ciphertext, undefined)
    let plaintext: Buffer | undefined
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: GCM_TAG_BYTES })
      decipher.setAAD(this.aad(envelope.key_id))
      decipher.setAuthTag(tag)
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      const raw: unknown = JSON.parse(plaintext.toString("utf8"))
      const state = storedStateSchema.parse(raw)
      return { keyId: envelope.key_id, state }
    } catch {
      throw new ByokStoreError("STORE_CORRUPT", "The BYOK credential store failed authentication.")
    } finally {
      plaintext?.fill(0)
      nonce.fill(0)
      tag.fill(0)
      ciphertext.fill(0)
    }
  }

  private encryptEnvelope(state: StoredState): Buffer {
    const nonce = randomBytes(GCM_NONCE_BYTES)
    const plaintext = Buffer.from(JSON.stringify(state), "utf8")
    try {
      const cipher = createCipheriv("aes-256-gcm", this.activeKey, nonce, {
        authTagLength: GCM_TAG_BYTES,
      })
      cipher.setAAD(this.aad(this.activeKeyId))
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      const tag = cipher.getAuthTag()
      const envelope = {
        ciphertext: ciphertext.toString("base64url"),
        format: STORE_FORMAT,
        key_id: this.activeKeyId,
        nonce: nonce.toString("base64url"),
        tag: tag.toString("base64url"),
        version: STORE_VERSION,
      }
      const output = Buffer.from(JSON.stringify(envelope), "utf8")
      ciphertext.fill(0)
      tag.fill(0)
      if (output.length > this.maxFileBytes) {
        output.fill(0)
        throw new ByokStoreError("CREDENTIAL_LIMIT_EXCEEDED", "The encrypted BYOK store exceeds its file-size limit.")
      }
      return output
    } finally {
      plaintext.fill(0)
      nonce.fill(0)
    }
  }

  private aad(keyId: string): Buffer {
    return Buffer.from(`${STORE_FORMAT}\u0000${STORE_VERSION}\u0000${keyId}\u0000${this.aadContext}`, "utf8")
  }

  private async persistState(state: StoredState): Promise<void> {
    const contents = this.encryptEnvelope(state)
    const temporaryPath = join(
      this.directoryPath,
      `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    )
    let temporaryHandle
    let renamed = false
    try {
      temporaryHandle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      await temporaryHandle.writeFile(contents)
      await temporaryHandle.sync()
      await temporaryHandle.close()
      temporaryHandle = undefined
      await rename(temporaryPath, this.filePath)
      renamed = true
      const directoryHandle = await open(this.directoryPath, constants.O_RDONLY)
      try {
        await directoryHandle.sync()
      } finally {
        await directoryHandle.close()
      }
    } catch (error) {
      if (renamed) {
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
      await temporaryHandle?.close().catch(() => undefined)
      if (!renamed) await unlink(temporaryPath).catch(() => undefined)
    }
  }
}

export type { ByokCredentialSeed }
