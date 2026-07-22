import { z } from "zod"
import {
  ByokStoreError,
  apiKeyHashSchema,
  byokCredentialCreateSchema,
  byokCredentialUpdateSchema,
  type ByokActiveSelection,
  type ByokCredential,
  type ByokKeyVersion,
  type ResolvedByokCredential,
} from "./contracts.js"

export const MAX_ACTIVE_SELECTIONS = 100
export const MAX_KEY_VERSIONS_PER_CREDENTIAL = 100

const storedAccessKeySchema = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/u)
const storedStringListSchema = z.array(z.string().min(1).max(256)).max(100)
const storedApiKeyHashListSchema = z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(100)
export const storedKeyVersionSchema = z.object({
  access_key: storedAccessKeySchema,
  created_at: z.iso.datetime(),
  id: z.uuid(),
}).strict()
export const storedCredentialSchema = z.object({
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
}).strict().superRefine((credential, context) => {
  const versionIds = credential.key_versions.map(version => version.id)
  if (new Set(versionIds).size !== versionIds.length) {
    context.addIssue({ code: "custom", message: "Credential key version ids must be unique" })
  }
  if (!versionIds.includes(credential.active_key_version_id)) {
    context.addIssue({ code: "custom", message: "The active key version does not exist" })
  }
})
export const storedActiveSelectionSchema = z.object({
  credential_id: z.uuid(),
  facade_api_key_hash: apiKeyHashSchema,
  updated_at: z.iso.datetime(),
}).strict()
export const storedStateSchema = z.object({
  active_selections: z.array(storedActiveSelectionSchema).max(MAX_ACTIVE_SELECTIONS).default([]),
  credentials: z.array(storedCredentialSchema),
  revision: z.number().int().nonnegative(),
}).strict().superRefine((state, context) => {
  const credentialIds = state.credentials.map(credential => credential.id)
  if (new Set(credentialIds).size !== credentialIds.length) {
    context.addIssue({ code: "custom", message: "Credential ids must be unique" })
  }
  const selectedCallers = state.active_selections.map(selection => selection.facade_api_key_hash)
  if (new Set(selectedCallers).size !== selectedCallers.length) {
    context.addIssue({ code: "custom", message: "Active BYOK selections must be unique per facade API key" })
  }
  if (state.active_selections.some(selection => !credentialIds.includes(selection.credential_id))) {
    context.addIssue({ code: "custom", message: "Active BYOK selections must reference existing credentials" })
  }
})
export const resolveInputSchema = z.object({
  apiKeyHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  credentialId: z.uuid().optional(),
  model: z.string().trim().min(1).max(256),
  provider: z.literal("pippit").default("pippit"),
  userId: z.string().trim().min(1).max(256).optional(),
  workspaceId: z.uuid(),
}).strict()

export type ParsedCreate = z.output<typeof byokCredentialCreateSchema>
export type ParsedUpdate = z.output<typeof byokCredentialUpdateSchema>
export type StoredCredential = z.output<typeof storedCredentialSchema>
export type StoredKeyVersion = z.output<typeof storedKeyVersionSchema>
export type StoredState = z.output<typeof storedStateSchema>

export interface RecordMetadata {
  readonly createdAt: string
  readonly id: string
  readonly keyVersionId: string
  readonly sortOrder: number
}

export function emptyState(): StoredState {
  return { active_selections: [], credentials: [], revision: 0 }
}

function copyList(value: readonly string[] | null): string[] | null {
  return value === null ? null : [...value]
}

export function publicCredential(credential: StoredCredential): ByokCredential {
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

export function publicSelection(selection: z.output<typeof storedActiveSelectionSchema>): ByokActiveSelection {
  return {
    credential_id: selection.credential_id,
    facade_api_key_hash: selection.facade_api_key_hash,
    updated_at: selection.updated_at,
  }
}

function maskedAccessKey(accessKey: string): string {
  const prefix = accessKey.startsWith("ak-") ? "ak-" : ""
  const suffix = accessKey.length >= 12 ? accessKey.slice(-4) : ""
  return `${prefix}****${suffix}`
}

export function createRecord(input: ParsedCreate, metadata: RecordMetadata): StoredCredential {
  return {
    active_key_version_id: metadata.keyVersionId,
    allowed_api_key_hashes: copyList(input.allowed_api_key_hashes),
    allowed_models: copyList(input.allowed_models),
    allowed_user_ids: copyList(input.allowed_user_ids),
    created_at: metadata.createdAt,
    disabled: input.disabled,
    id: metadata.id,
    is_fallback: input.is_fallback,
    key_versions: [{ access_key: input.key, created_at: metadata.createdAt, id: metadata.keyVersionId }],
    label: maskedAccessKey(input.key),
    name: input.name,
    provider: input.provider,
    sort_order: metadata.sortOrder,
    workspace_id: input.workspace_id,
  }
}

export function updateRecord(
  credential: StoredCredential,
  input: ParsedUpdate,
  keyVersionId: string,
  createdAt: string,
): StoredCredential {
  const nextVersion: StoredKeyVersion | undefined = input.key === undefined
    ? undefined
    : { access_key: input.key, created_at: createdAt, id: keyVersionId }
  return {
    ...credential,
    active_key_version_id: nextVersion?.id ?? credential.active_key_version_id,
    allowed_api_key_hashes: input.allowed_api_key_hashes === undefined
      ? credential.allowed_api_key_hashes
      : copyList(input.allowed_api_key_hashes),
    allowed_models: input.allowed_models === undefined ? credential.allowed_models : copyList(input.allowed_models),
    allowed_user_ids: input.allowed_user_ids === undefined
      ? credential.allowed_user_ids
      : copyList(input.allowed_user_ids),
    disabled: input.disabled ?? credential.disabled,
    is_fallback: input.is_fallback ?? credential.is_fallback,
    key_versions: nextVersion === undefined ? credential.key_versions : [...credential.key_versions, nextVersion],
    label: nextVersion === undefined ? credential.label : maskedAccessKey(nextVersion.access_key),
    name: input.name === undefined ? credential.name : input.name,
  }
}

export function activeVersion(credential: StoredCredential): StoredKeyVersion {
  const version = credential.key_versions.find(candidate => candidate.id === credential.active_key_version_id)
  if (version === undefined) {
    throw new ByokStoreError("STORE_CORRUPT", "The BYOK credential references a missing key version.")
  }
  return version
}

export function resolvedCredential(
  credential: StoredCredential,
  version: StoredKeyVersion,
): ResolvedByokCredential {
  const keyVersion: ByokKeyVersion = { created_at: version.created_at, id: version.id }
  return { accessKey: version.access_key, credential: publicCredential(credential), keyVersion }
}

export function listMatches(filter: readonly string[] | null, value: string | undefined): boolean {
  return filter === null || (value !== undefined && filter.includes(value))
}

export function callerCanManageCredential(credential: StoredCredential, facadeApiKeyHash: string): boolean {
  return credential.allowed_user_ids === null && listMatches(credential.allowed_api_key_hashes, facadeApiKeyHash)
}

export function callerCanSelectCredential(credential: StoredCredential, facadeApiKeyHash: string): boolean {
  return !credential.disabled && callerCanManageCredential(credential, facadeApiKeyHash)
}

export function byRoutingOrder(left: StoredCredential, right: StoredCredential): number {
  if (left.is_fallback !== right.is_fallback) return left.is_fallback ? 1 : -1
  return left.sort_order - right.sort_order ||
    left.created_at.localeCompare(right.created_at) ||
    left.id.localeCompare(right.id)
}
