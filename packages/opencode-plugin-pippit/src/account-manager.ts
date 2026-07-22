import {
  MAX_RUN_BINDINGS,
  MAX_TOMBSTONES,
  assertCanDeleteAccount,
  changedState,
  credentialSelection,
  publicAccount,
  resolveStoredAccount,
  upsertAccount,
  validateRunIdentifier,
  type DeletedPippitAccount,
  type PippitAccountInspection,
  type PippitAccountInspectionOptions,
  type PippitAccountList,
  type PippitAccountSelector,
  type PippitAccountStore,
  type PippitAccountSummary,
  type PippitCredentialSelection,
} from "./account-state.js"

export class PippitAccountManager {
  private readonly now: () => Date
  private readonly store: PippitAccountStore

  constructor(store: PippitAccountStore, dependencies: { readonly now?: () => Date } = {}) {
    this.store = store
    this.now = dependencies.now ?? (() => new Date())
  }

  async addAccount(accountName: string, accessKey: string): Promise<PippitAccountSummary> {
    const now = this.timestamp()
    return this.store.update((state) => {
      const upserted = upsertAccount(state, { accessKey, accountName, now })
      return {
        result: publicAccount(upserted.account, upserted.state.active_account_id),
        state: upserted.state,
      }
    })
  }

  async list(): Promise<PippitAccountList> {
    const state = await this.store.read()
    return {
      accounts: state.accounts.map((account) => publicAccount(account, state.active_account_id)),
      ...(state.active_account_id === null ? {} : { activeAccountId: state.active_account_id }),
    }
  }

  async hasManagedState(): Promise<boolean> {
    const state = await this.store.read()
    return state.revision > 0 || state.accounts.length > 0 || state.tombstones.length > 0
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
