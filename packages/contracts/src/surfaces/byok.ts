import { z } from "zod"
import { runtimeContract } from "../contract.js"

export const DEFAULT_BYOK_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000"
const boundedString = z.string().trim().min(1).max(256)
export const apiKeyHashSchema = z.string().regex(/^[a-f0-9]{64}$/u, "API key hashes must be lowercase SHA-256 hex")
const uniqueApiKeyHashList = z.array(apiKeyHashSchema).max(100)
  .refine(items => new Set(items).size === items.length, "Values must be unique")
const uniqueStringList = z.array(boundedString).max(100)
  .refine(items => new Set(items).size === items.length, "Values must be unique")
const accessKeySchema = z.string().trim().min(1).max(4096).refine(value => [...value].every(character => {
  const code = character.codePointAt(0) ?? 0
  return code >= 0x21 && code <= 0x7e
}), "The Pippit Access Key must contain printable ASCII without spaces")

export const byokCredentialCreateSchema = z.object({
  allowed_api_key_hashes: uniqueApiKeyHashList.nullable().default(null),
  allowed_models: uniqueStringList.nullable().default(null),
  allowed_user_ids: uniqueStringList.nullable().default(null),
  disabled: z.boolean().default(false),
  is_fallback: z.boolean().default(false),
  key: accessKeySchema,
  name: z.string().trim().min(1).max(128).nullable().default(null),
  provider: z.literal("pippit"),
  workspace_id: z.uuid().default(DEFAULT_BYOK_WORKSPACE_ID),
}).strict()
export const byokCredentialUpdateSchema = z.object({
  allowed_api_key_hashes: uniqueApiKeyHashList.nullable().optional(),
  allowed_models: uniqueStringList.nullable().optional(),
  allowed_user_ids: uniqueStringList.nullable().optional(),
  disabled: z.boolean().optional(),
  is_fallback: z.boolean().optional(),
  key: accessKeySchema.optional(),
  name: z.string().trim().min(1).max(128).nullable().optional(),
}).strict().refine(input => Object.keys(input).length > 0, "At least one credential field must be updated")
export const byokCredentialListQuerySchema = z.object({
  facade_api_key_hash: apiKeyHashSchema.optional(),
  provider: z.literal("pippit").optional(),
  workspace_id: z.uuid().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(100),
}).strict()
export const byokCredentialDeleteQuerySchema = z.object({
  facade_api_key_hash: apiKeyHashSchema.optional(),
}).strict()
export const byokActiveSelectionQuerySchema = z.object({ facade_api_key_hash: apiKeyHashSchema }).strict()
export const byokActiveSelectionUpdateSchema = z.object({
  credential_id: z.uuid(),
  facade_api_key_hash: apiKeyHashSchema,
}).strict()

export const byokCredentialCreateContract = runtimeContract(byokCredentialCreateSchema)
export const byokCredentialUpdateContract = runtimeContract(byokCredentialUpdateSchema)
export const byokCredentialListQueryContract = runtimeContract(byokCredentialListQuerySchema)
export const byokCredentialDeleteQueryContract = runtimeContract(byokCredentialDeleteQuerySchema)
export const byokActiveSelectionQueryContract = runtimeContract(byokActiveSelectionQuerySchema)
export const byokActiveSelectionUpdateContract = runtimeContract(byokActiveSelectionUpdateSchema)
