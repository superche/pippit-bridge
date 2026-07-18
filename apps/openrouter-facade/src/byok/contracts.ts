import { z } from "zod"

export const DEFAULT_BYOK_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000"

const boundedString = z.string().trim().min(1).max(256)
const apiKeyHashSchema = z.string().regex(/^[a-f0-9]{64}$/u, "API key hashes must be lowercase SHA-256 hex")
const uniqueApiKeyHashList = z
  .array(apiKeyHashSchema)
  .max(100)
  .refine((items) => new Set(items).size === items.length, "Values must be unique")
const uniqueStringList = z
  .array(boundedString)
  .max(100)
  .refine((items) => new Set(items).size === items.length, "Values must be unique")
const accessKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/u, "The Pippit Access Key must contain printable ASCII without spaces")

export const byokCredentialCreateSchema = z
  .object({
    allowed_api_key_hashes: uniqueApiKeyHashList.nullable().default(null),
    allowed_models: uniqueStringList.nullable().default(null),
    allowed_user_ids: uniqueStringList.nullable().default(null),
    disabled: z.boolean().default(false),
    is_fallback: z.boolean().default(false),
    key: accessKeySchema,
    name: z.string().trim().min(1).max(128).nullable().default(null),
    provider: z.literal("pippit"),
    workspace_id: z.uuid().default(DEFAULT_BYOK_WORKSPACE_ID),
  })
  .strict()

export const byokCredentialUpdateSchema = z
  .object({
    allowed_api_key_hashes: uniqueApiKeyHashList.nullable().optional(),
    allowed_models: uniqueStringList.nullable().optional(),
    allowed_user_ids: uniqueStringList.nullable().optional(),
    disabled: z.boolean().optional(),
    is_fallback: z.boolean().optional(),
    key: accessKeySchema.optional(),
    name: z.string().trim().min(1).max(128).nullable().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, "At least one credential field must be updated")

export const byokCredentialListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(100),
    offset: z.coerce.number().int().min(0).default(0),
    provider: z.literal("pippit").optional(),
    workspace_id: z.uuid().optional(),
  })
  .strict()

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
  delete(id: string): Promise<boolean>
  get(id: string): Promise<ByokCredential | undefined>
  getVersion(credentialId: string, keyVersionId: string): Promise<ResolvedByokCredential | undefined>
  getWorkspaceId(): Promise<string>
  list(query?: ByokCredentialListQuery): Promise<ByokCredentialList>
  resolveCandidates(input: ByokResolveInput): Promise<readonly ResolvedByokCredential[]>
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
  | "CREDENTIAL_LIMIT_EXCEEDED"
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
