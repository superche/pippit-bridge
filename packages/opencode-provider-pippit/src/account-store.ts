import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"
import { z } from "zod"
import {
  accessKeyFingerprint,
  isManagedAuthSentinel,
  maskedAccessKey,
  normalizeAccessKey,
} from "./access-key.js"

const STORE_FORMAT = "pippit-opencode-account-store"
const STORE_VERSION = 1
const MAX_ACCOUNTS = 100
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_RUN_BINDINGS = 1_000
const MAX_TOMBSTONES = 100
const LOCK_RETRY_ATTEMPTS = 40
const LOCK_RETRY_DELAY_MS = 25

export const PIPPIT_ACCOUNT_NAME_METADATA = "account_name"

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
const pendingConfigurationSchema = z
  .object({
    account_name: accountNameSchema,
    baseline_auth_marker: z.string().min(1).max(160).nullable(),
    created_at: z.iso.datetime(),
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
const storedStateSchema = z
  .object({
    accounts: z.array(storedAccountSchema).max(MAX_ACCOUNTS),
    active_account_id: z.uuid().nullable(),
    format: z.literal(STORE_FORMAT),
    last_seen_auth_marker: z.string().min(1).max(160).nullable(),
    pending_configuration: pendingConfigurationSchema.nullable(),
    revision: z.number().int().nonnegative(),
    run_bindings: z.array(storedRunBindingSchema).max(MAX_RUN_BINDINGS),
    tombstones: z.array(storedTombstoneSchema).max(MAX_TOMBSTONES),
    version: z.literal(STORE_VERSION),
  })
  .strict()
  .superRefine((state, context) => {
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
  })

type StoredAccount = z.output<typeof storedAccountSchema>
export type StoredPippitAccountState = z.output<typeof storedStateSchema>
type StoredState = StoredPippitAccountState

export interface StoredOpenCodeAuth {
  readonly key?: string
  readonly metadata?: Readonly<Record<string, string>>
  readonly type: string
}

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
  readonly pendingAccountName?: string
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
  readonly fingerprint: string
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
  update<T>(operation: (state: StoredPippitAccountState) => PippitAccountStoreMutation<T>): Promise<T>
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
  return {
    accounts: [],
    active_account_id: null,
    format: STORE_FORMAT,
    last_seen_auth_marker: null,
    pending_configuration: null,
    revision: 0,
    run_bindings: [],
    tombstones: [],
    version: STORE_VERSION,
  }
}

function cloneState(state: StoredState): StoredState {
  return structuredClone(state)
}

function changedState(state: StoredState, update: Partial<StoredState>): StoredState {
  return storedStateSchema.parse({ ...state, ...update, revision: state.revision + 1 })
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function accountNameKey(value: string): string {
  return normalizeAccountName(value).toLocaleLowerCase("en-US")
}

function authMetadataAccountName(auth: StoredOpenCodeAuth): string | undefined {
  const value = auth.metadata?.[PIPPIT_ACCOUNT_NAME_METADATA]
  if (value === undefined) return undefined
  try {
    return normalizeAccountName(value)
  } catch {
    return undefined
  }
}

function authMarker(accessKey: string, accountName: string | undefined): string {
  const metadataDigest = createHash("sha256").update(accountName ?? "", "utf8").digest("hex")
  return `${accessKeyFingerprint(accessKey)}.${metadataDigest}`
}

function storedAuthValue(auth: StoredOpenCodeAuth | undefined): {
  readonly accessKey: string
  readonly accountName?: string
  readonly fingerprint: string
  readonly marker: string
} | undefined {
  if (auth?.type !== "api" || typeof auth.key !== "string" || isManagedAuthSentinel(auth.key)) {
    return undefined
  }
  const accessKey = normalizeAccessKey(auth.key)
  const accountName = authMetadataAccountName(auth)
  return {
    accessKey,
    ...(accountName === undefined ? {} : { accountName }),
    fingerprint: accessKeyFingerprint(accessKey),
    marker: authMarker(accessKey, accountName),
  }
}

function publicAccount(account: StoredAccount, activeAccountId: string | null): PippitAccountSummary {
  return {
    active: account.id === activeAccountId,
    createdAt: account.created_at,
    id: account.id,
    maskedAccessKey: maskedAccessKey(account.access_key),
    name: account.name,
    updatedAt: account.updated_at,
  }
}

function credentialSelection(account: StoredAccount): PippitCredentialSelection {
  return {
    accessKey: account.access_key,
    accountId: account.id,
    accountName: account.name,
    maskedAccessKey: maskedAccessKey(account.access_key),
  }
}

function validateRunIdentifier(value: string, label: string): string {
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > 512 || containsControlCharacter(normalized)) {
    throw new Error(`${label} is invalid.`)
  }
  return normalized
}

function resolveStoredAccount(state: StoredState, selector: PippitAccountSelector): StoredAccount {
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

function assertCanDeleteAccount(state: StoredState, account: StoredAccount): void {
  if (account.id === state.active_account_id && state.accounts.length > 1) {
    throw new Error("Switch to another Pippit account before deleting the active account.")
  }
}

function upsertAccount(
  state: StoredState,
  input: { readonly accessKey: string; readonly accountName: string; readonly now: string },
): { readonly account: StoredAccount; readonly state: StoredState } {
  const accessKey = normalizeAccessKey(input.accessKey)
  const accountName = normalizeAccountName(input.accountName)
  const fingerprint = accessKeyFingerprint(accessKey)
  const byFingerprint = state.accounts.find((account) => account.fingerprint === fingerprint)
  const byName = state.accounts.find((account) => accountNameKey(account.name) === accountNameKey(accountName))
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

export function storedAuthFingerprint(auth: StoredOpenCodeAuth | undefined): string | undefined {
  return storedAuthValue(auth)?.fingerprint
}

export class MemoryPippitAccountStore implements PippitAccountStore {
  private readonly mutex = new AsyncMutex()
  private state: StoredState

  constructor() {
    this.state = emptyState()
  }

  async read(): Promise<StoredState> {
    return this.mutex.runExclusive(async () => cloneState(this.state))
  }

  async update<T>(operation: (state: StoredState) => PippitAccountStoreMutation<T>): Promise<T> {
    return this.mutex.runExclusive(async () => {
      const current = cloneState(this.state)
      const mutation = operation(current)
      this.state = storedStateSchema.parse(cloneState(mutation.state))
      return mutation.result
    })
  }
}

export class LazyPippitAccountStore implements PippitAccountStore {
  private readonly factory: () => Promise<PippitAccountStore>
  private store: Promise<PippitAccountStore> | undefined

  constructor(factory: () => Promise<PippitAccountStore>) {
    this.factory = factory
  }

  async read(): Promise<StoredPippitAccountState> {
    return (await this.resolve()).read()
  }

  async update<T>(
    operation: (state: StoredPippitAccountState) => PippitAccountStoreMutation<T>,
  ): Promise<T> {
    return (await this.resolve()).update(operation)
  }

  private resolve(): Promise<PippitAccountStore> {
    this.store ??= this.factory()
    return this.store
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
    await mkdir(this.directoryPath, { mode: 0o700, recursive: true })
    const metadata = await lstat(this.directoryPath)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("The Pippit account store parent must be a real directory.")
    }
    if (process.platform !== "win32") {
      if ((metadata.mode & 0o077) !== 0) {
        throw new Error("The Pippit account store directory must use permissions 0700 or stricter.")
      }
      if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
        throw new Error("The Pippit account store directory must be owned by the current user.")
      }
    }
  }

  private async acquireLock(): Promise<FileHandle> {
    for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await open(
          this.lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        )
      } catch (error) {
        if (!isNodeError(error, "EEXIST") || attempt === LOCK_RETRY_ATTEMPTS - 1) {
          throw new Error("The Pippit account store is busy in another process.")
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS))
      }
    }
    throw new Error("The Pippit account store is busy in another process.")
  }

  private async releaseLock(handle: FileHandle): Promise<void> {
    await handle.close().catch(() => undefined)
    await unlink(this.lockPath).catch(() => undefined)
  }

  private async loadState(): Promise<StoredState> {
    let handle: FileHandle
    try {
      handle = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return emptyState()
      throw new Error("The Pippit account store could not be opened.")
    }
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new Error("The Pippit account store must be a regular file.")
      }
      if (process.platform !== "win32") {
        if ((metadata.mode & 0o077) !== 0) {
          throw new Error("The Pippit account store file must use permissions 0600 or stricter.")
        }
        if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
          throw new Error("The Pippit account store file must be owned by the current user.")
        }
      }
      if (metadata.size < 1 || metadata.size > MAX_FILE_BYTES) {
        throw new Error("The Pippit account store has an invalid size.")
      }
      const value: unknown = JSON.parse(await handle.readFile({ encoding: "utf8" }))
      return storedStateSchema.parse(value)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("The Pippit account store")) throw error
      throw new Error("The Pippit account store is malformed.")
    } finally {
      await handle.close()
    }
  }

  private async persistState(state: StoredState): Promise<void> {
    const contents = Buffer.from(JSON.stringify(state), "utf8")
    if (contents.length > MAX_FILE_BYTES) throw new Error("The Pippit account store is too large.")
    const temporaryPath = join(
      this.directoryPath,
      `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    )
    let handle: FileHandle | undefined
    let renamed = false
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      await handle.writeFile(contents)
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporaryPath, this.filePath)
      renamed = true
      if (process.platform !== "win32") {
        const directory = await open(this.directoryPath, constants.O_RDONLY)
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
    } catch {
      throw new Error("The Pippit account store could not be persisted.")
    } finally {
      contents.fill(0)
      await handle?.close().catch(() => undefined)
      if (!renamed) await unlink(temporaryPath).catch(() => undefined)
    }
  }
}

export class PippitAccountManager {
  private readonly now: () => Date
  private readonly store: PippitAccountStore

  constructor(store: PippitAccountStore, dependencies: { readonly now?: () => Date } = {}) {
    this.store = store
    this.now = dependencies.now ?? (() => new Date())
  }

  async beginConfiguration(accountName: string, auth: StoredOpenCodeAuth | undefined): Promise<void> {
    const name = normalizeAccountName(accountName)
    const observedBaselineMarker = storedAuthValue(auth)?.marker
    const createdAt = this.timestamp()
    await this.store.update((state) => {
      const baselineMarker = observedBaselineMarker ?? state.last_seen_auth_marker
      return {
        result: undefined,
        state: changedState(state, {
          pending_configuration: {
            account_name: name,
            baseline_auth_marker: baselineMarker,
            created_at: createdAt,
          },
        }),
      }
    })
  }

  async reconcile(auth: StoredOpenCodeAuth | undefined): Promise<PippitAccountSummary | undefined> {
    const value = storedAuthValue(auth)
    if (value === undefined) return undefined
    const now = this.timestamp()
    return this.store.update((state) => {
      const pending = state.pending_configuration
      if (pending !== null && value.marker === pending.baseline_auth_marker) {
        return { result: undefined, state }
      }
      if (pending === null && value.marker === state.last_seen_auth_marker) {
        return { result: undefined, state }
      }
      if (
        pending === null &&
        state.tombstones.some((tombstone) => tombstone.fingerprint === value.fingerprint)
      ) {
        return {
          result: undefined,
          state: changedState(state, { last_seen_auth_marker: value.marker }),
        }
      }
      const accountName =
        pending?.account_name ??
        value.accountName ??
        `Pippit ${maskedAccessKey(value.accessKey)} ${value.fingerprint.slice(0, 8)}`
      const upserted = upsertAccount(state, { accessKey: value.accessKey, accountName, now })
      const next = changedState(upserted.state, {
        last_seen_auth_marker: value.marker,
        pending_configuration: null,
      })
      return { result: publicAccount(upserted.account, next.active_account_id), state: next }
    })
  }

  async list(): Promise<PippitAccountList> {
    const state = await this.store.read()
    return {
      accounts: state.accounts.map((account) => publicAccount(account, state.active_account_id)),
      ...(state.active_account_id === null ? {} : { activeAccountId: state.active_account_id }),
      ...(state.pending_configuration === null
        ? {}
        : { pendingAccountName: state.pending_configuration.account_name }),
    }
  }

  async hasManagedState(): Promise<boolean> {
    const state = await this.store.read()
    return (
      state.revision > 0 ||
      state.accounts.length > 0 ||
      state.pending_configuration !== null ||
      state.tombstones.length > 0
    )
  }

  async resolveActive(): Promise<PippitCredentialSelection | undefined> {
    const state = await this.store.read()
    if (state.active_account_id === null) return undefined
    const account = state.accounts.find((candidate) => candidate.id === state.active_account_id)
    if (account === undefined) throw new Error("The active Pippit account is unavailable.")
    return credentialSelection(account)
  }

  async resolveAccount(selector: PippitAccountSelector): Promise<PippitCredentialSelection> {
    const state = await this.store.read()
    return credentialSelection(resolveStoredAccount(state, selector))
  }

  async inspectAccount(
    selector: PippitAccountSelector,
    options: PippitAccountInspectionOptions = {},
  ): Promise<PippitAccountInspection> {
    const state = await this.store.read()
    const account = resolveStoredAccount(state, selector)
    if (options.validateDelete === true) assertCanDeleteAccount(state, account)
    return {
      account: publicAccount(account, state.active_account_id),
      boundRunCount: state.run_bindings.filter((binding) => binding.account_id === account.id).length,
      fingerprint: account.fingerprint,
    }
  }

  async switchAccount(selector: PippitAccountSelector): Promise<PippitAccountSummary> {
    return this.store.update((state) => {
      const account = resolveStoredAccount(state, selector)
      const next = changedState(state, { active_account_id: account.id })
      return { result: publicAccount(account, next.active_account_id), state: next }
    })
  }

  async deleteAccount(selector: PippitAccountSelector): Promise<DeletedPippitAccount> {
    return this.store.update((state) => {
      const account = resolveStoredAccount(state, selector)
      assertCanDeleteAccount(state, account)
      const boundRunCount = state.run_bindings.filter(
        (binding) => binding.account_id === account.id,
      ).length
      const accounts = state.accounts.filter((candidate) => candidate.id !== account.id)
      const tombstones = [
        ...state.tombstones.filter((tombstone) => tombstone.fingerprint !== account.fingerprint),
        { account_id: account.id, fingerprint: account.fingerprint },
      ].slice(-MAX_TOMBSTONES)
      const next = changedState(state, {
        accounts,
        active_account_id: account.id === state.active_account_id ? null : state.active_account_id,
        last_seen_auth_marker: state.last_seen_auth_marker?.startsWith(`${account.fingerprint}.`)
          ? null
          : state.last_seen_auth_marker,
        tombstones,
      })
      return {
        result: {
          account: publicAccount(account, next.active_account_id),
          boundRunCount,
          fingerprint: account.fingerprint,
        },
        state: next,
      }
    })
  }

  async bindRun(runId: string, threadId: string, accountId: string): Promise<void> {
    const normalizedRunId = validateRunIdentifier(runId, "Pippit run_id")
    const normalizedThreadId = validateRunIdentifier(threadId, "Pippit thread_id")
    await this.store.update((state) => {
      if (!state.accounts.some((account) => account.id === accountId)) {
        throw new Error("The Pippit account used for this run is unavailable.")
      }
      const binding = {
        account_id: accountId,
        created_at: this.timestamp(),
        run_id: normalizedRunId,
        thread_id: normalizedThreadId,
      }
      const bindings = [
        ...state.run_bindings.filter(
          (candidate) =>
            candidate.run_id !== normalizedRunId || candidate.thread_id !== normalizedThreadId,
        ),
        binding,
      ].slice(-MAX_RUN_BINDINGS)
      return { result: undefined, state: changedState(state, { run_bindings: bindings }) }
    })
  }

  async resolveForRun(runId: string, threadId: string): Promise<PippitCredentialSelection | undefined> {
    const normalizedRunId = validateRunIdentifier(runId, "Pippit run_id")
    const normalizedThreadId = validateRunIdentifier(threadId, "Pippit thread_id")
    const state = await this.store.read()
    const binding = state.run_bindings.find(
      (candidate) =>
        candidate.run_id === normalizedRunId && candidate.thread_id === normalizedThreadId,
    )
    if (binding === undefined) return undefined
    const account = state.accounts.find((candidate) => candidate.id === binding.account_id)
    if (account === undefined) {
      throw new Error("The Pippit account used for this run was deleted. Restore that account to query the run.")
    }
    return credentialSelection(account)
  }

  private timestamp(): string {
    const value = this.now()
    if (Number.isNaN(value.getTime())) throw new Error("The Pippit account store clock is invalid.")
    return value.toISOString()
  }
}
