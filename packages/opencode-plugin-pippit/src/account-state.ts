import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  accessKeyFingerprint,
  maskedAccessKey,
  normalizeAccessKey,
} from "./access-key.js"

const STORE_FORMAT = "pippit-opencode-account-store"
const STORE_VERSION = 2
const MAX_ACCOUNTS = 100
export const MAX_RUN_BINDINGS = 1_000
export const MAX_TOMBSTONES = 100

function containsControlCharacter(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
}

const accountNameSchema = z
  .string()
  .trim()
  .transform((value) => value.normalize("NFC"))
  .pipe(
    z
      .string()
      .min(1)
      .max(80)
      .refine((value) => !containsControlCharacter(value)),
  )
const accessKeySchema = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^[\x21-\x7e]+$/u)
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const storedAccountSchema = z
  .object({
    access_key: accessKeySchema,
    created_at: z.iso.datetime(),
    fingerprint: fingerprintSchema,
    id: z.uuid(),
    name: accountNameSchema,
    updated_at: z.iso.datetime(),
  })
  .strict()
const storedRunBindingSchema = z
  .object({
    account_id: z.uuid(),
    created_at: z.iso.datetime(),
    run_id: z.string().min(1).max(512),
    thread_id: z.string().min(1).max(512),
  })
  .strict()
const storedTombstoneSchema = z
  .object({
    account_id: z.uuid(),
    fingerprint: fingerprintSchema,
  })
  .strict()

function validateStateRelationships(
  state: {
    readonly accounts: readonly z.output<typeof storedAccountSchema>[]
    readonly active_account_id: string | null
    readonly run_bindings: readonly z.output<typeof storedRunBindingSchema>[]
    readonly tombstones: readonly z.output<typeof storedTombstoneSchema>[]
  },
  context: z.core.$RefinementCtx,
): void {
  const ids = state.accounts.map((account) => account.id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "Pippit account ids must be unique." })
  }
  const names = state.accounts.map((account) => account.name.toLocaleLowerCase("en-US"))
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: "custom", message: "Pippit account names must be unique." })
  }
  const fingerprints = state.accounts.map((account) => account.fingerprint)
  if (new Set(fingerprints).size !== fingerprints.length) {
    context.addIssue({ code: "custom", message: "Pippit Access Keys must be unique." })
  }
  if (state.active_account_id !== null && !ids.includes(state.active_account_id)) {
    context.addIssue({ code: "custom", message: "The active Pippit account does not exist." })
  }
  const runs = state.run_bindings.map((binding) => `${binding.thread_id}\u0000${binding.run_id}`)
  if (new Set(runs).size !== runs.length) {
    context.addIssue({ code: "custom", message: "Pippit run bindings must be unique." })
  }
  const tombstoneIds = state.tombstones.map((tombstone) => tombstone.account_id)
  if (new Set(tombstoneIds).size !== tombstoneIds.length) {
    context.addIssue({ code: "custom", message: "Pippit tombstone account ids must be unique." })
  }
  if (tombstoneIds.some((id) => ids.includes(id))) {
    context.addIssue({ code: "custom", message: "Pippit tombstones must reference deleted accounts." })
  }
  const tombstoneFingerprints = state.tombstones.map((tombstone) => tombstone.fingerprint)
  if (new Set(tombstoneFingerprints).size !== tombstoneFingerprints.length) {
    context.addIssue({ code: "custom", message: "Pippit tombstone fingerprints must be unique." })
  }
  if (tombstoneFingerprints.some((fingerprint) => fingerprints.includes(fingerprint))) {
    context.addIssue({ code: "custom", message: "Pippit tombstones must reference deleted Access Keys." })
  }
}

export const storedStateSchema = z
  .object({
    accounts: z.array(storedAccountSchema).max(MAX_ACCOUNTS),
    active_account_id: z.uuid().nullable(),
    format: z.literal(STORE_FORMAT),
    revision: z.number().int().nonnegative(),
    run_bindings: z.array(storedRunBindingSchema).max(MAX_RUN_BINDINGS),
    tombstones: z.array(storedTombstoneSchema).max(MAX_TOMBSTONES),
    version: z.literal(STORE_VERSION),
  })
  .strict()
  .superRefine(validateStateRelationships)

const legacyStoredStateSchema = z
  .object({
    accounts: z.array(storedAccountSchema).max(MAX_ACCOUNTS),
    active_account_id: z.uuid().nullable(),
    format: z.literal(STORE_FORMAT),
    last_seen_auth_marker: z.string().min(1).max(160).nullable(),
    pending_configuration: z
      .object({
        account_name: accountNameSchema,
        baseline_auth_marker: z.string().min(1).max(160).nullable(),
        created_at: z.iso.datetime(),
      })
      .strict()
      .nullable(),
    revision: z.number().int().nonnegative(),
    run_bindings: z.array(storedRunBindingSchema).max(MAX_RUN_BINDINGS),
    tombstones: z.array(storedTombstoneSchema).max(MAX_TOMBSTONES),
    version: z.literal(1),
  })
  .strict()

export type StoredAccount = z.output<typeof storedAccountSchema>
export type StoredPippitAccountState = z.output<typeof storedStateSchema>
export type StoredState = StoredPippitAccountState

export interface PippitAccountSelector {
  readonly accountId?: string
  readonly accountName?: string
}

export interface PippitAccountSummary {
  readonly active: boolean
  readonly createdAt: string
  readonly id: string
  readonly maskedAccessKey: string
  readonly name: string
  readonly updatedAt: string
}

export interface PippitAccountList {
  readonly accounts: readonly PippitAccountSummary[]
  readonly activeAccountId?: string
}

export interface PippitCredentialSelection {
  readonly accessKey: string
  readonly accountId: string
  readonly accountName: string
  readonly maskedAccessKey: string
}

export interface DeletedPippitAccount {
  readonly account: PippitAccountSummary
  readonly boundRunCount: number
  readonly fingerprint: string
}

export interface PippitAccountInspection {
  readonly account: PippitAccountSummary
  readonly boundRunCount: number
}

export interface PippitAccountInspectionOptions {
  readonly validateDelete?: boolean
}

export interface PippitAccountStoreMutation<T> {
  readonly result: T
  readonly state: StoredState
}

export interface PippitAccountStore {
  read(): Promise<StoredPippitAccountState>
  update<T>(
    operation: (state: StoredPippitAccountState) => PippitAccountStoreMutation<T>,
  ): Promise<T>
}

export function emptyState(): StoredState {
  return {
    accounts: [],
    active_account_id: null,
    format: STORE_FORMAT,
    revision: 0,
    run_bindings: [],
    tombstones: [],
    version: STORE_VERSION,
  }
}

export function parseStoredState(value: unknown): StoredState {
  const current = storedStateSchema.safeParse(value)
  if (current.success) return current.data
  const legacy = legacyStoredStateSchema.parse(value)
  return storedStateSchema.parse({
    accounts: legacy.accounts,
    active_account_id: legacy.active_account_id,
    format: legacy.format,
    revision: legacy.revision + 1,
    run_bindings: legacy.run_bindings,
    tombstones: legacy.tombstones,
    version: STORE_VERSION,
  })
}

export function cloneState(state: StoredState): StoredState {
  return structuredClone(state)
}

export function changedState(state: StoredState, update: Partial<StoredState>): StoredState {
  return storedStateSchema.parse({ ...state, ...update, revision: state.revision + 1 })
}

function accountNameKey(value: string): string {
  return normalizeAccountName(value).toLocaleLowerCase("en-US")
}

export function publicAccount(
  account: StoredAccount,
  activeAccountId: string | null,
): PippitAccountSummary {
  return {
    active: account.id === activeAccountId,
    createdAt: account.created_at,
    id: account.id,
    maskedAccessKey: maskedAccessKey(account.access_key),
    name: account.name,
    updatedAt: account.updated_at,
  }
}

export function credentialSelection(account: StoredAccount): PippitCredentialSelection {
  return {
    accessKey: account.access_key,
    accountId: account.id,
    accountName: account.name,
    maskedAccessKey: maskedAccessKey(account.access_key),
  }
}

export function validateRunIdentifier(value: string, label: string): string {
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > 512 || containsControlCharacter(normalized)) {
    throw new Error(`${label} is invalid.`)
  }
  return normalized
}

export function resolveStoredAccount(
  state: StoredState,
  selector: PippitAccountSelector,
): StoredAccount {
  const hasId = selector.accountId !== undefined
  const hasName = selector.accountName !== undefined
  if (hasId === hasName) {
    throw new Error("Provide exactly one of account_id or account_name.")
  }
  const account = hasId
    ? state.accounts.find((candidate) => candidate.id === selector.accountId)
    : state.accounts.find(
        (candidate) => accountNameKey(candidate.name) === accountNameKey(selector.accountName ?? ""),
      )
  if (account === undefined) throw new Error("The requested Pippit account does not exist.")
  return account
}

export function assertCanDeleteAccount(state: StoredState, account: StoredAccount): void {
  if (account.id === state.active_account_id && state.accounts.length > 1) {
    throw new Error("Switch to another Pippit account before deleting the active account.")
  }
}

export function upsertAccount(
  state: StoredState,
  input: { readonly accessKey: string; readonly accountName: string; readonly now: string },
): { readonly account: StoredAccount; readonly state: StoredState } {
  const accessKey = normalizeAccessKey(input.accessKey)
  const accountName = normalizeAccountName(input.accountName)
  const fingerprint = accessKeyFingerprint(accessKey)
  const byFingerprint = state.accounts.find((account) => account.fingerprint === fingerprint)
  const byName = state.accounts.find(
    (account) => accountNameKey(account.name) === accountNameKey(accountName),
  )
  const tombstone = state.tombstones.find((candidate) => candidate.fingerprint === fingerprint)
  if (byFingerprint !== undefined && byName !== undefined && byFingerprint.id !== byName.id) {
    throw new Error("That Pippit account name and Access Key belong to different saved accounts.")
  }
  if (byName !== undefined && tombstone !== undefined && byName.id !== tombstone.account_id) {
    throw new Error("That Pippit account name and Access Key belong to different saved accounts.")
  }

  const existing = byName ?? byFingerprint
  let account: StoredAccount
  let accounts: StoredAccount[]
  if (existing === undefined) {
    if (state.accounts.length >= MAX_ACCOUNTS) {
      throw new Error(`At most ${MAX_ACCOUNTS} Pippit accounts can be saved.`)
    }
    account = {
      access_key: accessKey,
      created_at: input.now,
      fingerprint,
      id: tombstone?.account_id ?? randomUUID(),
      name: accountName,
      updated_at: input.now,
    }
    accounts = [...state.accounts, account]
  } else {
    account = {
      ...existing,
      access_key: accessKey,
      fingerprint,
      name: accountName,
      updated_at: input.now,
    }
    accounts = state.accounts.map((candidate) => (candidate.id === account.id ? account : candidate))
  }

  return {
    account,
    state: changedState(state, {
      accounts,
      active_account_id: account.id,
      tombstones: state.tombstones.filter((candidate) => candidate.fingerprint !== fingerprint),
    }),
  }
}

export function normalizeAccountName(value: string): string {
  try {
    return accountNameSchema.parse(value)
  } catch {
    throw new Error("Pippit account name must be 1 to 80 visible characters.")
  }
}
