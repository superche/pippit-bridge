import {
  PippitAccountManager,
  type PippitCredentialSelection,
} from "./account-store.js"
import { normalizeAccessKey } from "./access-key.js"
import { PIPPIT_ACCESS_KEY_ENV } from "./options.js"

export interface PippitRuntimeCredential {
  readonly accessKey: string
  readonly accountId?: string
  readonly accountName?: string
  readonly source: "environment" | "managed_account"
}

export class PippitCredentialSource {
  private readonly accounts: PippitAccountManager

  constructor(accounts: PippitAccountManager) {
    this.accounts = accounts
  }

  hasEnvironmentOverride(): boolean {
    const value = process.env[PIPPIT_ACCESS_KEY_ENV]
    return value !== undefined && value.trim() !== ""
  }

  async readRuntimeCredential(): Promise<PippitRuntimeCredential> {
    const environmentKey = process.env[PIPPIT_ACCESS_KEY_ENV]
    if (environmentKey !== undefined && environmentKey.trim() !== "") {
      return { accessKey: normalizeAccessKey(environmentKey), source: "environment" }
    }

    const managed = await this.accounts.resolveActive()
    if (managed !== undefined) return runtimeCredential(managed)
    throw notConnectedError()
  }

  async readForRun(
    runId: string,
    threadId: string,
    explicitAccountId?: string,
  ): Promise<PippitRuntimeCredential> {
    const managed = await this.accounts.resolveForRun(runId, threadId)
    if (managed !== undefined) {
      if (explicitAccountId !== undefined && managed.accountId !== explicitAccountId) {
        throw new Error("The requested account_id does not match this run's saved Pippit account binding.")
      }
      return runtimeCredential(managed)
    }
    if (explicitAccountId !== undefined) {
      return runtimeCredential(await this.accounts.resolveAccount({ accountId: explicitAccountId }))
    }
    return this.readRuntimeCredential()
  }

  async bindRun(runId: string, threadId: string, credential: PippitRuntimeCredential): Promise<void> {
    if (credential.accountId === undefined) return
    await this.accounts.bindRun(runId, threadId, credential.accountId)
  }

  async read(): Promise<string> {
    return (await this.readRuntimeCredential()).accessKey
  }
}

function runtimeCredential(credential: PippitCredentialSelection): PippitRuntimeCredential {
  return {
    accessKey: credential.accessKey,
    accountId: credential.accountId,
    accountName: credential.accountName,
    source: "managed_account",
  }
}

function notConnectedError(): Error {
  return new Error(
    "Pippit has no active account. Use pippit_manage_access_keys with operation=configure to create a one-time local enrollment link, or set PIPPIT_ACCESS_KEY for an operator-managed override.",
  )
}

export { normalizeAccessKey } from "./access-key.js"
