import { type IdempotencyBeginResult, type IdempotencyStore } from "@pippit-bridge/core"
import { PippitApiError } from "@pippit-bridge/sdk"
import { type PluginInput } from "@opencode-ai/plugin"
import { join } from "node:path"
import {
  FilePippitAccountStore,
  LazyPippitAccountStore,
  PippitAccountManager,
  type PippitAccountSelector,
  type PippitAccountSummary,
} from "./account-store.js"
import { PippitCredentialSource, type PippitRuntimeCredential } from "./auth.js"
import { type PippitToolResult } from "./generation.js"
import { LazyOpenCodeIdempotencyStore } from "./idempotency.js"
import { PIPPIT_ACCESS_KEY_ENV } from "./options.js"

export function accountOutput(account: PippitAccountSummary): Record<string, unknown> {
  return {
    account_id: account.id,
    account_name: account.name,
    masked_ak: account.maskedAccessKey,
    active: account.active,
    created_at: account.createdAt,
    updated_at: account.updatedAt,
  }
}

export function resultOutput(
  result: PippitToolResult,
  credential: PippitRuntimeCredential,
  binding?: { readonly persisted: boolean; readonly warning?: string },
): string {
  return JSON.stringify(
    {
      status: result.status,
      run_id: result.runId,
      thread_id: result.threadId,
      ...(credential.accountId === undefined ? {} : { account_id: credential.accountId }),
      ...(credential.accountName === undefined ? {} : { account_name: credential.accountName }),
      ...(result.model === undefined ? {} : { model: result.model }),
      ...(result.files === undefined ? {} : { files: result.files }),
      ...(result.videoUrls === undefined ? {} : { video_urls: result.videoUrls }),
      ...(result.failure === undefined ? {} : { failure: result.failure }),
      ...(result.webThreadLink === undefined ? {} : { web_thread_link: result.webThreadLink }),
      ...(binding === undefined ? {} : { account_binding_persisted: binding.persisted }),
      ...(binding?.warning === undefined ? {} : { warning: binding.warning }),
    },
    null,
    2,
  )
}

export function normalizeToolError(error: unknown): Error {
  if (error instanceof PippitApiError && (error.status === 401 || error.status === 403)) {
    return new Error(
      "The active Pippit Access Key was rejected. Use pippit_manage_access_keys to switch or configure an account and try again.",
    )
  }
  if (error instanceof Error) return error
  return new Error("Pippit could not complete the video operation.")
}

export function createDefaultAccountManager(input: PluginInput): PippitAccountManager {
  const store = new LazyPippitAccountStore(async () => {
    const response = await input.client.path.get()
    const statePath = response.data?.state
    if (typeof statePath !== "string" || statePath.trim() === "") {
      throw new Error("OpenCode did not provide a global state path for the Pippit account store.")
    }
    return new FilePippitAccountStore(join(statePath, "pippit", "access-keys.json"))
  })
  return new PippitAccountManager(store)
}

export function createDefaultIdempotencyStore(input: PluginInput): IdempotencyStore {
  return new LazyOpenCodeIdempotencyStore(async () => {
    const response = await input.client.path.get()
    const statePath = response.data?.state
    if (typeof statePath !== "string" || statePath.trim() === "") {
      throw new Error("OpenCode did not provide a global state path for the Pippit idempotency store.")
    }
    return statePath
  })
}

export function idempotencyError(
  result: Exclude<IdempotencyBeginResult, { readonly kind: "replay" | "started" }>,
): Error {
  if (result.kind === "conflict") return new Error("idempotency_key was already used for a different Pippit request.")
  if (result.kind === "in_progress") return new Error(`The Pippit request for this idempotency_key is still ${result.phase}.`)
  if (result.kind === "indeterminate") {
    return new Error("The previous Pippit submission may have been accepted. Do not retry automatically; inspect the original task and use a new key only after reconciliation.")
  }
  return new Error(`The previous Pippit request for this idempotency_key failed (${result.errorCode}).`)
}

export function ambiguousSubmissionError(error: unknown): boolean {
  return !(error instanceof PippitApiError) || ["ABORTED", "INVALID_RESPONSE", "NETWORK_ERROR", "TIMEOUT"].includes(error.code)
}

export function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })
}

export function accountSelector(input: {
  readonly account_id?: string | undefined
  readonly account_name?: string | undefined
}): PippitAccountSelector {
  return {
    ...(input.account_id === undefined ? {} : { accountId: input.account_id }),
    ...(input.account_name === undefined ? {} : { accountName: input.account_name }),
  }
}

export function assertNoAccountSelector(input: {
  readonly account_id?: string | undefined
  readonly account_name?: string | undefined
}): void {
  if (input.account_id !== undefined || input.account_name !== undefined) {
    throw new Error("This access-key operation does not accept an account selector.")
  }
}

export function environmentOverride(credentials: PippitCredentialSource): string | null {
  return credentials.hasEnvironmentOverride() ? PIPPIT_ACCESS_KEY_ENV : null
}
