import type { z } from "zod"
import {
  apiKeyHashSchema,
  byokActiveSelectionQuerySchema,
  byokActiveSelectionUpdateSchema,
  byokCredentialCreateSchema,
  byokCredentialDeleteQuerySchema,
  byokCredentialListQuerySchema,
  byokCredentialUpdateSchema,
  DEFAULT_BYOK_WORKSPACE_ID,
} from "@pippit-bridge/contracts"

export {
  apiKeyHashSchema,
  byokActiveSelectionQuerySchema,
  byokActiveSelectionUpdateSchema,
  byokCredentialCreateSchema,
  byokCredentialDeleteQuerySchema,
  byokCredentialListQuerySchema,
  byokCredentialUpdateSchema,
  DEFAULT_BYOK_WORKSPACE_ID,
}

export type ByokCredentialCreateInput = z.input<typeof byokCredentialCreateSchema>
export type ByokCredentialUpdateInput = z.input<typeof byokCredentialUpdateSchema>
export type ByokCredentialListQuery = z.input<typeof byokCredentialListQuerySchema>

export interface ByokCredential {
  readonly allowed_api_key_hashes: readonly string[] | null
  readonly allowed_models: readonly string[] | null
  readonly allowed_user_ids: readonly string[] | null
  readonly created_at: string
  readonly disabled: boolean
  readonly id: string
  readonly is_fallback: boolean
  readonly label: string
  readonly name: string | null
  readonly provider: "pippit"
  readonly sort_order: number
  readonly workspace_id: string
}

export interface ByokCredentialList {
  readonly data: readonly ByokCredential[]
  readonly total_count: number
}

export interface ByokActiveSelection {
  readonly credential_id: string
  readonly facade_api_key_hash: string
  readonly updated_at: string
}

export interface ByokKeyVersion {
  readonly created_at: string
  readonly id: string
}

export interface ResolvedByokCredential {
  readonly accessKey: string
  readonly credential: ByokCredential
  readonly keyVersion: ByokKeyVersion
}

export interface ByokResolveInput {
  readonly apiKeyHash?: string
  readonly credentialId?: string
  readonly model: string
  readonly provider?: "pippit"
  readonly userId?: string
  readonly workspaceId: string
}

export interface ByokStore {
  close(): Promise<void>
  create(input: ByokCredentialCreateInput): Promise<ByokCredential>
  delete(id: string, facadeApiKeyHash?: string): Promise<boolean>
  getActiveSelection(facadeApiKeyHash: string): Promise<ByokActiveSelection | undefined>
  get(id: string): Promise<ByokCredential | undefined>
  getVersion(credentialId: string, keyVersionId: string): Promise<ResolvedByokCredential | undefined>
  getWorkspaceId(): Promise<string>
  list(query?: ByokCredentialListQuery): Promise<ByokCredentialList>
  resolveCandidates(input: ByokResolveInput): Promise<readonly ResolvedByokCredential[]>
  setActiveSelection(facadeApiKeyHash: string, credentialId: string): Promise<ByokActiveSelection>
  update(id: string, input: ByokCredentialUpdateInput): Promise<ByokCredential | undefined>
}

export interface ByokStoreRuntimeOptions {
  readonly idFactory?: () => string
  readonly maxCredentials?: number
  readonly now?: () => Date
  readonly workspaceId?: string
}

export type ByokCredentialSeed = ByokCredentialCreateInput & {
  readonly created_at?: string
  readonly id?: string
  readonly key_version_id?: string
  readonly sort_order?: number
}

export interface MemoryByokStoreOptions extends ByokStoreRuntimeOptions {
  readonly seed?: readonly ByokCredentialSeed[]
}

export interface FileByokStoreOptions extends ByokStoreRuntimeOptions {
  readonly aadContext?: string
  readonly filePath: string
  readonly keyId?: string
  readonly masterKey: Uint8Array
  readonly maxFileBytes?: number
  readonly previousMasterKeys?: Readonly<Record<string, Uint8Array>>
}

export type ByokStoreErrorCode =
  | "ACTIVE_CREDENTIAL_DELETE_REQUIRES_SWITCH"
  | "ACTIVE_CREDENTIAL_INELIGIBLE"
  | "CREDENTIAL_LIMIT_EXCEEDED"
  | "CREDENTIAL_NOT_FOUND"
  | "INVALID_CONFIGURATION"
  | "STORE_CLOSED"
  | "STORE_CORRUPT"
  | "STORE_DURABILITY_UNCERTAIN"
  | "STORE_IO_ERROR"

export class ByokStoreError extends Error {
  readonly code: ByokStoreErrorCode

  constructor(code: ByokStoreErrorCode, message: string) {
    super(message)
    this.name = "ByokStoreError"
    this.code = code
  }
}
