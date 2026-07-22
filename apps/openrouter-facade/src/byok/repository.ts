import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  ByokStoreError,
  apiKeyHashSchema,
  byokCredentialCreateSchema,
  byokCredentialListQuerySchema,
  byokCredentialUpdateSchema,
  type ByokActiveSelection,
  type ByokCredential,
  type ByokCredentialCreateInput,
  type ByokCredentialList,
  type ByokCredentialListQuery,
  type ByokCredentialUpdateInput,
  type ByokResolveInput,
  type ByokStore,
  type ByokStoreRuntimeOptions,
  type ResolvedByokCredential,
} from "./contracts.js"
import {
  MAX_ACTIVE_SELECTIONS,
  MAX_KEY_VERSIONS_PER_CREDENTIAL,
  activeVersion,
  byRoutingOrder,
  callerCanManageCredential,
  callerCanSelectCredential,
  createRecord,
  emptyState,
  listMatches,
  publicCredential,
  publicSelection,
  resolveInputSchema,
  resolvedCredential,
  storedActiveSelectionSchema,
  storedStateSchema,
  updateRecord,
  type StoredState,
} from "./state.js"

const DEFAULT_MAX_CREDENTIALS = 100

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve()

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release: (() => void) | undefined
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await operation() } finally { release?.() }
  }
}

export abstract class AbstractByokStore implements ByokStore {
  protected state: StoredState = emptyState()
  private closed = false
  private readonly idFactory: () => string
  private readonly maxCredentials: number
  private readonly mutex = new AsyncMutex()
  private readonly now: () => Date
  private readonly workspaceId: string

  protected constructor(options: ByokStoreRuntimeOptions) {
    const maxCredentials = options.maxCredentials ?? DEFAULT_MAX_CREDENTIALS
    if (!Number.isSafeInteger(maxCredentials) || maxCredentials < 1 || maxCredentials > 10_000) {
      throw new ByokStoreError("INVALID_CONFIGURATION", "maxCredentials must be an integer from 1 to 10000.")
    }
    this.idFactory = options.idFactory ?? randomUUID
    this.maxCredentials = maxCredentials
    this.now = options.now ?? (() => new Date())
    this.workspaceId = z.uuid().parse(options.workspaceId ?? "00000000-0000-0000-0000-000000000000")
  }

  async create(input: ByokCredentialCreateInput): Promise<ByokCredential> {
    const parsed = byokCredentialCreateSchema.parse({ ...input, workspace_id: input.workspace_id ?? this.workspaceId })
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
      const next = { ...this.state, credentials: [...this.state.credentials, record], revision: this.state.revision + 1 }
      await this.persist(next)
      this.state = next
      return publicCredential(record)
    })
  }

  async list(query: ByokCredentialListQuery = {}): Promise<ByokCredentialList> {
    const parsed = byokCredentialListQuerySchema.parse(query)
    await this.prepare()
    this.assertOpen()
    const matching = this.state.credentials.filter(credential =>
      (parsed.provider === undefined || credential.provider === parsed.provider) &&
      (parsed.workspace_id === undefined || credential.workspace_id === parsed.workspace_id) &&
      (parsed.facade_api_key_hash === undefined || callerCanManageCredential(credential, parsed.facade_api_key_hash)),
    ).sort(byRoutingOrder)
    return {
      data: matching.slice(parsed.offset, parsed.offset + parsed.limit).map(publicCredential),
      total_count: matching.length,
    }
  }

  async get(id: string): Promise<ByokCredential | undefined> {
    await this.prepare()
    this.assertOpen()
    const credential = this.state.credentials.find(candidate => candidate.id === id)
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
      const index = this.state.credentials.findIndex(credential => credential.id === id)
      const existing = this.state.credentials[index]
      if (existing === undefined) return undefined
      if (parsed.key !== undefined && existing.key_versions.length >= MAX_KEY_VERSIONS_PER_CREDENTIAL) {
        throw new ByokStoreError(
          "CREDENTIAL_LIMIT_EXCEEDED",
          `A BYOK credential supports at most ${MAX_KEY_VERSIONS_PER_CREDENTIAL} retained key versions.`,
        )
      }
      const updated = updateRecord(existing, parsed, this.newUuid("credential key version"), this.timestamp())
      const credentials = [...this.state.credentials]
      credentials[index] = updated
      const next = { ...this.state, credentials, revision: this.state.revision + 1 }
      await this.persist(next)
      this.state = next
      return publicCredential(updated)
    })
  }

  async delete(id: string, facadeApiKeyHash?: string): Promise<boolean> {
    const normalizedHash = facadeApiKeyHash === undefined ? undefined : apiKeyHashSchema.parse(facadeApiKeyHash)
    await this.prepare()
    return this.mutex.runExclusive(async () => {
      this.assertOpen()
      const credential = this.state.credentials.find(candidate => candidate.id === id)
      if (credential === undefined ||
        (normalizedHash !== undefined && !callerCanManageCredential(credential, normalizedHash))) return false
      const selectedCallers = this.state.active_selections
        .filter(selection => selection.credential_id === id)
        .map(selection => selection.facade_api_key_hash)
      const callerCanSwitch = selectedCallers.some(hash => this.state.credentials.some(
        candidate => candidate.id !== id && callerCanSelectCredential(candidate, hash),
      ))
      if (callerCanSwitch) {
        throw new ByokStoreError(
          "ACTIVE_CREDENTIAL_DELETE_REQUIRES_SWITCH",
          "Switch callers with another eligible credential away from the active BYOK credential before deleting it.",
        )
      }
      const next = {
        active_selections: this.state.active_selections.filter(selection => selection.credential_id !== id),
        credentials: this.state.credentials.filter(candidate => candidate.id !== id),
        revision: this.state.revision + 1,
      }
      await this.persist(next)
      this.state = next
      return true
    })
  }

  async getActiveSelection(facadeApiKeyHash: string): Promise<ByokActiveSelection | undefined> {
    const normalizedHash = apiKeyHashSchema.parse(facadeApiKeyHash)
    await this.prepare()
    this.assertOpen()
    const selection = this.state.active_selections.find(candidate => candidate.facade_api_key_hash === normalizedHash)
    return selection === undefined ? undefined : publicSelection(selection)
  }

  async setActiveSelection(facadeApiKeyHash: string, credentialId: string): Promise<ByokActiveSelection> {
    const normalizedHash = apiKeyHashSchema.parse(facadeApiKeyHash)
    const normalizedCredentialId = z.uuid().parse(credentialId)
    await this.prepare()
    return this.mutex.runExclusive(async () => {
      this.assertOpen()
      const credential = this.state.credentials.find(candidate => candidate.id === normalizedCredentialId)
      if (credential === undefined) {
        throw new ByokStoreError("CREDENTIAL_NOT_FOUND", "The requested BYOK credential does not exist.")
      }
      if (!callerCanSelectCredential(credential, normalizedHash)) {
        throw new ByokStoreError(
          "ACTIVE_CREDENTIAL_INELIGIBLE",
          "The requested BYOK credential is not eligible for this facade API key.",
        )
      }
      const existing = this.state.active_selections.find(candidate => candidate.facade_api_key_hash === normalizedHash)
      if (existing?.credential_id === credential.id) return publicSelection(existing)
      if (existing === undefined && this.state.active_selections.length >= MAX_ACTIVE_SELECTIONS) {
        throw new ByokStoreError(
          "CREDENTIAL_LIMIT_EXCEEDED",
          `The BYOK credential store supports at most ${MAX_ACTIVE_SELECTIONS} active caller selections.`,
        )
      }
      const selection = storedActiveSelectionSchema.parse({
        credential_id: credential.id,
        facade_api_key_hash: normalizedHash,
        updated_at: this.timestamp(),
      })
      const next = storedStateSchema.parse({
        ...this.state,
        active_selections: [
          ...this.state.active_selections.filter(candidate => candidate.facade_api_key_hash !== normalizedHash),
          selection,
        ],
        revision: this.state.revision + 1,
      })
      await this.persist(next)
      this.state = next
      return publicSelection(selection)
    })
  }

  async resolveCandidates(input: ByokResolveInput): Promise<readonly ResolvedByokCredential[]> {
    const parsed = resolveInputSchema.parse(input)
    await this.prepare()
    this.assertOpen()
    const activeCredentialId = parsed.credentialId === undefined && parsed.apiKeyHash !== undefined
      ? this.state.active_selections.find(selection => selection.facade_api_key_hash === parsed.apiKeyHash)?.credential_id
      : undefined
    const selectedCredentialId = parsed.credentialId ?? activeCredentialId
    return this.state.credentials.filter(credential =>
      !credential.disabled &&
      (selectedCredentialId === undefined || credential.id === selectedCredentialId) &&
      credential.provider === parsed.provider &&
      credential.workspace_id === parsed.workspaceId &&
      listMatches(credential.allowed_models, parsed.model) &&
      listMatches(credential.allowed_api_key_hashes, parsed.apiKeyHash) &&
      listMatches(credential.allowed_user_ids, parsed.userId),
    ).sort(byRoutingOrder).map(credential => resolvedCredential(credential, activeVersion(credential)))
  }

  async getVersion(credentialId: string, keyVersionId: string): Promise<ResolvedByokCredential | undefined> {
    await this.prepare()
    this.assertOpen()
    const credential = this.state.credentials.find(candidate => candidate.id === credentialId)
    const version = credential?.key_versions.find(candidate => candidate.id === keyVersionId)
    return credential === undefined || version === undefined ? undefined : resolvedCredential(credential, version)
  }

  async close(): Promise<void> {
    let prepareError: unknown
    try { await this.prepare() } catch (error) { prepareError = error }
    await this.mutex.runExclusive(async () => {
      this.closed = true
      this.state = emptyState()
    })
    if (prepareError !== undefined) throw prepareError
  }

  protected assertStateWithinLimit(state: StoredState): void {
    if (state.credentials.length > this.maxCredentials) {
      throw new ByokStoreError("STORE_CORRUPT", `The BYOK credential store exceeds its ${this.maxCredentials} credential limit.`)
    }
    if (state.credentials.some(credential => credential.workspace_id !== this.workspaceId)) {
      throw new ByokStoreError("STORE_CORRUPT", "The BYOK credential store contains a credential from a different workspace.")
    }
    if (state.active_selections.length > MAX_ACTIVE_SELECTIONS) {
      throw new ByokStoreError(
        "STORE_CORRUPT",
        `The BYOK credential store exceeds its ${MAX_ACTIVE_SELECTIONS} active selection limit.`,
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
