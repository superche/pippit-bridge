import {
  createPublicHttpFetcher,
  createReferenceLoader,
  type IdempotencyBeginResult,
  type IdempotencyStore,
  VIDEO_MODELS,
} from "@pippit-bridge/core"
import { PippitApiError, PippitClient } from "@pippit-bridge/sdk"
import {
  tool,
  type Config,
  type Hooks,
  type Plugin,
  type PluginInput,
  type PluginOptions,
} from "@opencode-ai/plugin"
import { join } from "node:path"
import {
  FilePippitAccountStore,
  LazyPippitAccountStore,
  PippitAccountManager,
  normalizeAccountName,
  storedAuthFingerprint,
  type PippitAccountSelector,
  type PippitAccountSummary,
} from "./account-store.js"
import { PIPPIT_MANAGED_AUTH_SENTINEL } from "./access-key.js"
import {
  createPippitAuthHook,
  PippitCredentialSource,
  type PippitRuntimeCredential,
} from "./auth.js"
import {
  PIPPIT_MAX_WAIT_SECONDS,
  PippitVideoService,
  type PippitToolResult,
} from "./generation.js"
import {
  PIPPIT_ACCESS_KEY_ENV,
  PIPPIT_ACCESS_KEY_PAGE,
  PIPPIT_PROVIDER_ID,
  parsePluginOptions,
} from "./options.js"
import { LazyOpenCodeIdempotencyStore } from "./idempotency.js"

type MutableProviderConfig = {
  env?: string[]
  models?: Record<string, unknown>
  name?: string
}

export interface PippitPluginDependencies {
  readonly accounts?: PippitAccountManager
  readonly idempotency?: IdempotencyStore
  readonly videos?: Pick<PippitVideoService, "generate" | "get">
}

function registerProviderConfig(config: Config): void {
  config.provider ??= {}
  const providers = config.provider as Record<string, MutableProviderConfig>
  const provider = providers[PIPPIT_PROVIDER_ID]
  if (provider === undefined) {
    providers[PIPPIT_PROVIDER_ID] = {
      env: [PIPPIT_ACCESS_KEY_ENV],
      models: {},
      name: "Pippit (小云雀 media tools)",
    }
    return
  }
  provider.env ??= [PIPPIT_ACCESS_KEY_ENV]
  provider.models ??= {}
  provider.name ??= "Pippit (小云雀 media tools)"
}

function accountOutput(account: PippitAccountSummary): Record<string, unknown> {
  return {
    account_id: account.id,
    account_name: account.name,
    masked_ak: account.maskedAccessKey,
    active: account.active,
    created_at: account.createdAt,
    updated_at: account.updatedAt,
  }
}

function resultOutput(
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

function normalizeToolError(error: unknown): Error {
  if (error instanceof PippitApiError && (error.status === 401 || error.status === 403)) {
    return new Error(
      "The active Pippit Access Key was rejected. Use pippit_manage_access_keys to switch or configure an account and try again.",
    )
  }
  if (error instanceof Error) return error
  return new Error("Pippit could not complete the video operation.")
}

function createDefaultAccountManager(input: PluginInput): PippitAccountManager {
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

function createDefaultIdempotencyStore(input: PluginInput): IdempotencyStore {
  return new LazyOpenCodeIdempotencyStore(async () => {
    const response = await input.client.path.get()
    const statePath = response.data?.state
    if (typeof statePath !== "string" || statePath.trim() === "") {
      throw new Error("OpenCode did not provide a global state path for the Pippit idempotency store.")
    }
    return statePath
  })
}

function idempotencyError(result: Exclude<IdempotencyBeginResult, { readonly kind: "replay" | "started" }>): Error {
  if (result.kind === "conflict") return new Error("idempotency_key was already used for a different Pippit request.")
  if (result.kind === "in_progress") return new Error(`The Pippit request for this idempotency_key is still ${result.phase}.`)
  if (result.kind === "indeterminate") {
    return new Error("The previous Pippit submission may have been accepted. Do not retry automatically; inspect the original task and use a new key only after reconciliation.")
  }
  return new Error(`The previous Pippit request for this idempotency_key failed (${result.errorCode}).`)
}

function ambiguousSubmissionError(error: unknown): boolean {
  return !(error instanceof PippitApiError) || ["ABORTED", "INVALID_RESPONSE", "NETWORK_ERROR", "TIMEOUT"].includes(error.code)
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })
}

function accountSelector(input: {
  readonly account_id?: string | undefined
  readonly account_name?: string | undefined
}): PippitAccountSelector {
  return {
    ...(input.account_id === undefined ? {} : { accountId: input.account_id }),
    ...(input.account_name === undefined ? {} : { accountName: input.account_name }),
  }
}

function assertNoAccountSelector(input: {
  readonly account_id?: string | undefined
  readonly account_name?: string | undefined
}): void {
  if (input.account_id !== undefined || input.account_name !== undefined) {
    throw new Error("This access-key operation does not accept an account selector.")
  }
}

async function scrubMatchingOpenCodeCredential(
  input: PluginInput,
  credentials: PippitCredentialSource,
  deletedFingerprint: string,
): Promise<boolean> {
  const auth = await credentials.currentStoredAuth()
  if (storedAuthFingerprint(auth) !== deletedFingerprint) return false
  const response = await input.client.auth.set({
    body: {
      key: PIPPIT_MANAGED_AUTH_SENTINEL,
      metadata: { managed_account_store: "v1" },
      type: "api",
    },
    path: { id: PIPPIT_PROVIDER_ID },
  })
  if (response.error !== undefined) {
    throw new Error(
      "OpenCode could not scrub this credential from its import slot. The local Pippit account was preserved; retry delete.",
    )
  }
  return true
}

function environmentOverride(credentials: PippitCredentialSource): string | null {
  return credentials.hasEnvironmentOverride() ? PIPPIT_ACCESS_KEY_ENV : null
}

async function synchronizeOpenCodeCredential(
  input: PluginInput,
  credentials: PippitCredentialSource,
): Promise<void> {
  const response = await input.client.provider.list()
  if (response.error !== undefined) {
    throw new Error("OpenCode could not synchronize the current Pippit credential before configuration.")
  }
  await credentials.reconcileStoredAuth()
}

async function initializePippitPlugin(
  dependencies: PippitPluginDependencies,
  input: PluginInput,
  rawOptions: PluginOptions | undefined,
): Promise<Hooks> {
  const options = parsePluginOptions(rawOptions)
  const accounts = dependencies.accounts ?? createDefaultAccountManager(input)
  const idempotency = dependencies.idempotency ?? createDefaultIdempotencyStore(input)
  const credentials = new PippitCredentialSource(accounts)
  const pippit = new PippitClient({ baseUrl: options.baseURL, timeoutMs: options.requestTimeoutMs })
  const remoteLoader = createReferenceLoader({
    allowPrivateUrls: options.allowPrivateReferenceUrls,
    timeoutMs: options.requestTimeoutMs,
  })
  const outputFetcher = createPublicHttpFetcher({ allowPrivateUrls: options.allowPrivateReferenceUrls })
  const videos =
    dependencies.videos ??
    new PippitVideoService({
      defaultOutputDirectory: options.outputDirectory,
      outputFetcher,
      pippit,
      pollIntervalMs: options.pollIntervalMs,
      requestTimeoutMs: options.requestTimeoutMs,
      remoteLoader,
    })
  const schema = tool.schema
  const supportedAspectRatios = [
    ...new Set(VIDEO_MODELS.flatMap((model) => model.supported_aspect_ratios ?? [])),
  ].join(", ")
  const supportedResolutions = [
    ...new Set(VIDEO_MODELS.flatMap((model) => model.supported_resolutions ?? [])),
  ].join(", ")
  const reference = schema
    .object({
      kind: schema.enum(["image", "video", "audio"]),
      source: schema
        .string()
        .min(1)
        .describe("HTTP(S) URL or a file path inside the current OpenCode worktree."),
    })
    .strict()

  return {
    auth: createPippitAuthHook(credentials, options.deviceAuthorization, {
      requestTimeoutMs: options.requestTimeoutMs,
    }),
    config: async (config) => registerProviderConfig(config),
    tool: {
      pippit_manage_access_keys: tool({
        description:
          "Configure, list, switch, or delete locally saved Pippit Access Keys for multiple accounts. Never put a raw Access Key in this tool; configuration uses OpenCode's hidden /connect password prompt.",
        args: {
          account_id: schema
            .string()
            .uuid()
            .optional()
            .describe("Stable account_id returned by the list operation. Used by switch or delete."),
          account_name: schema
            .string()
            .min(1)
            .max(80)
            .optional()
            .describe("User-defined local account name. Required by configure; may select switch/delete."),
          operation: schema.enum(["configure", "list", "switch", "delete"]),
        },
        async execute(args, context) {
          context.metadata({
            title: `Pippit access keys · ${args.operation}`,
            metadata: { operation: args.operation },
          })

          if (args.operation === "configure") {
            if (args.account_id !== undefined || args.account_name === undefined) {
              throw new Error("configure requires account_name and does not accept account_id.")
            }
            const accountName = normalizeAccountName(args.account_name)
            const override = environmentOverride(credentials)
            await synchronizeOpenCodeCredential(input, credentials)
            await accounts.beginConfiguration(accountName, await credentials.currentStoredAuth())
            return {
              metadata: {
                account_name: accountName,
                environment_override: override,
                official_url: PIPPIT_ACCESS_KEY_PAGE,
                status: "action_required",
              },
              output: JSON.stringify(
                {
                  status: "action_required",
                  operation: "configure",
                  account_name: accountName,
                  environment_override: override,
                  official_url: PIPPIT_ACCESS_KEY_PAGE,
                  message:
                    "请打开小云雀官网，登录要绑定的账号，并在页面顶部签发 AK。签发后回到 OpenCode，运行 /connect，选择 Pippit，再通过密码输入框粘贴新 AK。不要把 AK 发送到聊天里。",
                  ...(override === null
                    ? {}
                    : {
                        environment_override_message: `${PIPPIT_ACCESS_KEY_ENV} is set and will keep overriding the selected local account for new runs until it is unset.`,
                      }),
                  next_steps: [
                    `打开 ${PIPPIT_ACCESS_KEY_PAGE}`,
                    "登录目标小云雀账号，在页面顶部签发 AK",
                    "回到 OpenCode 运行 /connect，选择 Pippit",
                    "在隐藏的密码输入框粘贴 AK",
                  ],
                },
                null,
                2,
              ),
              title: "Pippit AK · waiting for /connect",
            }
          }

          if (args.operation === "list") {
            assertNoAccountSelector(args)
            const listed = await accounts.list()
            const override = environmentOverride(credentials)
            return {
              metadata: {
                account_count: listed.accounts.length,
                active_account_id: listed.activeAccountId,
                environment_override: override,
              },
              output: JSON.stringify(
                {
                  status: "ok",
                  operation: "list",
                  active_account_id: listed.activeAccountId ?? null,
                  environment_override: override,
                  pending_account_name: listed.pendingAccountName ?? null,
                  accounts: listed.accounts.map(accountOutput),
                },
                null,
                2,
              ),
              title: `Pippit AK · ${listed.accounts.length} account(s)`,
            }
          }

          const selector = accountSelector(args)
          const inspection = await accounts.inspectAccount(selector, {
            validateDelete: args.operation === "delete",
          })
          await context.ask({
            always: [],
            metadata: {
              operation: args.operation,
              account_id: inspection.account.id,
              ...(args.operation === "delete"
                ? { bound_run_count: inspection.boundRunCount }
                : {}),
            },
            patterns: [args.operation, inspection.account.id],
            permission: "pippit_manage_access_keys",
          })

          if (args.operation === "switch") {
            const account = await accounts.switchAccount({ accountId: inspection.account.id })
            const override = environmentOverride(credentials)
            return {
              metadata: {
                account_id: account.id,
                account_name: account.name,
                environment_override: override,
              },
              output: JSON.stringify(
                {
                  status: "ok",
                  operation: "switch",
                  active_account: accountOutput(account),
                  environment_override: override,
                  message: override !== null
                    ? `${PIPPIT_ACCESS_KEY_ENV} is set and still overrides the selected local account for new or otherwise unbound operations.`
                    : "The selected Pippit account is now active for new runs.",
                },
                null,
                2,
              ),
              title: `Pippit AK · ${account.name}`,
            }
          }

          const scrubbed = await scrubMatchingOpenCodeCredential(
            input,
            credentials,
            inspection.fingerprint,
          )
          const deleted = await accounts.deleteAccount({ accountId: inspection.account.id })
          const override = environmentOverride(credentials)
          const boundRunMessage =
            deleted.boundRunCount === 0
              ? ""
              : ` 该账号绑定的 ${deleted.boundRunCount} 个历史 run 在本地账号删除期间无法查询；以后通过 configure 重新导入同一 AK 会恢复这些绑定。`
          const overrideMessage =
            override === null
              ? ""
              : ` ${PIPPIT_ACCESS_KEY_ENV} 仍已设置，新任务会继续使用环境变量中的凭证。`
          return {
            metadata: {
              account_id: deleted.account.id,
              account_name: deleted.account.name,
              bound_run_count: deleted.boundRunCount,
              environment_override: override,
              opencode_import_scrubbed: scrubbed,
            },
            output: JSON.stringify(
              {
                status: "ok",
                operation: "delete",
                bound_run_count: deleted.boundRunCount,
                deleted_account: accountOutput(deleted.account),
                environment_override: override,
                opencode_import_scrubbed: scrubbed,
                official_url: PIPPIT_ACCESS_KEY_PAGE,
                message: `已删除本地保存的 AK；这不等于在小云雀官网撤销 AK。如需立即失效，请同时前往官网顶部的 AK 管理入口撤销。${boundRunMessage}${overrideMessage}`,
              },
              null,
              2,
            ),
            title: `Pippit AK deleted · ${deleted.account.name}`,
          }
        },
      }),
      pippit_generate_video: tool({
        description:
          "Generate a video with a Pippit (小云雀) model. This uploads declared references and can incur Pippit usage charges. The Access Key must be issued by the official Pippit website and connected through OpenCode.",
        args: {
          aspect_ratio: schema
            .string()
            .min(1)
            .optional()
            .describe(`Aspect ratio supported by the selected model. Catalog values: ${supportedAspectRatios}.`),
          duration: schema.number().int().min(1).max(3_600).optional(),
          first_frame: schema.string().min(1).optional(),
          idempotency_key: schema
            .string()
            .min(1)
            .max(200)
            .refine((value) => !hasControlCharacter(value), "idempotency_key must not contain control characters")
            .optional()
            .describe("Optional recovery key. Reuse it only after an abnormal interruption of this exact submission."),
          last_frame: schema.string().min(1).optional(),
          max_wait_seconds: schema
            .number()
            .int()
            .min(1)
            .max(PIPPIT_MAX_WAIT_SECONDS)
            .default(PIPPIT_MAX_WAIT_SECONDS),
          model: schema
            .string()
            .default("pippit/seedance-2.0")
            .describe(`Stable Pippit model ID. Available: ${VIDEO_MODELS.map((model) => model.id).join(", ")}.`),
          output_directory: schema
            .string()
            .min(1)
            .optional()
            .describe("Relative directory inside the worktree. Defaults to .pippit/outputs."),
          prompt: schema.string().min(1).max(20_000),
          references: schema.array(reference).max(15).optional(),
          resolution: schema
            .string()
            .min(1)
            .optional()
            .describe(`Resolution supported by the selected model. Catalog values: ${supportedResolutions}.`),
          seed: schema.number().int().min(-1).max(4_294_967_295).optional(),
          wait_for_completion: schema.boolean().default(true),
        },
        async execute(args, context) {
          const referenceSources = [
            ...(args.first_frame === undefined ? [] : [args.first_frame]),
            ...(args.last_frame === undefined ? [] : [args.last_frame]),
            ...(args.references ?? []).map((item) => item.source),
          ]
          const outputDirectory = args.output_directory ?? options.outputDirectory
          await context.ask({
            always: [],
            metadata: {
              duration: args.duration ?? 5,
              model: args.model,
              output_directory: outputDirectory,
              reference_sources: referenceSources,
              target_origin: options.baseURL,
            },
            patterns: [args.model, options.baseURL, outputDirectory, ...referenceSources],
            permission: "pippit_generate_video",
          })
          context.metadata({ title: `Pippit · ${args.model}`, metadata: { model: args.model } })
          try {
            const credential = await credentials.readRuntimeCredential()
            const begun = args.idempotency_key === undefined
              ? undefined
              : await idempotency.begin({
                  key: args.idempotency_key,
                  operation: "pippit_generate_video",
                  request: {
                    account_identity: credential.accountId ?? credential.accessKey,
                    ...(args.aspect_ratio === undefined ? {} : { aspect_ratio: args.aspect_ratio }),
                    ...(args.duration === undefined ? {} : { duration: args.duration }),
                    ...(args.first_frame === undefined ? {} : { first_frame: args.first_frame }),
                    ...(args.last_frame === undefined ? {} : { last_frame: args.last_frame }),
                    model: args.model,
                    prompt: args.prompt,
                    ...(args.references === undefined ? {} : { references: args.references }),
                    ...(args.resolution === undefined ? {} : { resolution: args.resolution }),
                    ...(args.seed === undefined ? {} : { seed: args.seed }),
                    worktree: context.worktree,
                  },
                  scope: "opencode-global-pippit-state",
                })
            if (begun !== undefined && begun.kind !== "started" && begun.kind !== "replay") {
              throw idempotencyError(begun)
            }
            let crossedSubmissionBoundary = false
            let durablySubmitted = begun?.kind === "replay"
            let result: PippitToolResult
            if (begun?.kind === "replay") {
              result = begun.response as PippitToolResult
            } else {
              const recordId = begun?.recordId
              try {
                result = await videos.generate({
                  accessKey: credential.accessKey,
                  ...(recordId === undefined
                    ? {}
                    : {
                        afterSubmit: async (submittedResult: PippitToolResult) => {
                          await idempotency.markSubmitted(recordId, submittedResult)
                          durablySubmitted = true
                        },
                        beforeSubmit: async () => {
                          await idempotency.markSubmitting(recordId)
                          crossedSubmissionBoundary = true
                        },
                      }),
                  ...(args.aspect_ratio === undefined ? {} : { aspectRatio: args.aspect_ratio }),
                  ...(args.duration === undefined ? {} : { duration: args.duration }),
                  ...(args.first_frame === undefined ? {} : { firstFrame: args.first_frame }),
                  ...(args.last_frame === undefined ? {} : { lastFrame: args.last_frame }),
                  maxWaitSeconds: args.max_wait_seconds,
                  model: args.model,
                  ...(args.output_directory === undefined ? {} : { outputDirectory: args.output_directory }),
                  prompt: args.prompt,
                  ...(args.references === undefined ? {} : { references: args.references }),
                  ...(args.resolution === undefined ? {} : { resolution: args.resolution }),
                  rootDirectory: context.worktree,
                  ...(args.seed === undefined ? {} : { seed: args.seed }),
                  signal: context.abort,
                  waitForCompletion: args.wait_for_completion,
                })
                if (recordId !== undefined && !durablySubmitted) {
                  if (!crossedSubmissionBoundary) await idempotency.markSubmitting(recordId)
                  await idempotency.markSubmitted(recordId, result)
                  durablySubmitted = true
                }
              } catch (error) {
                if (recordId !== undefined && !durablySubmitted) {
                  if (crossedSubmissionBoundary && ambiguousSubmissionError(error)) {
                    await idempotency.markIndeterminate(recordId)
                  } else {
                    const errorCode = error instanceof PippitApiError ? error.code.toLowerCase() : "generation_failed"
                    await idempotency.markFailed(recordId, errorCode)
                  }
                }
                throw error
              }
            }
            let binding: { readonly persisted: boolean; readonly warning?: string } | undefined
            if (credential.accountId !== undefined) {
              try {
                await credentials.bindRun(result.runId, result.threadId, credential)
                binding = { persisted: true }
              } catch {
                binding = {
                  persisted: false,
                  warning:
                    "The upstream generation was submitted successfully. Do not retry: the local run-to-account binding could not be saved. Pass the returned account_id when querying this run.",
                }
              }
            }
            return {
              metadata: {
                model: result.model,
                run_id: result.runId,
                status: result.status,
                ...(credential.accountId === undefined ? {} : { account_id: credential.accountId }),
                ...(binding === undefined ? {} : { account_binding_persisted: binding.persisted }),
              },
              output: resultOutput(result, credential, binding),
              title: `Pippit video · ${result.status}`,
            }
          } catch (error) {
            throw normalizeToolError(error)
          }
        },
      }),
      pippit_get_video: tool({
        description:
          "Check a Pippit video run, optionally wait for completion, and download completed videos into the current worktree.",
        args: {
          account_id: schema
            .string()
            .uuid()
            .optional()
            .describe(
              "Explicit managed account for an unbound run. A saved run binding always wins and must match this value.",
            ),
          download: schema.boolean().default(true),
          max_wait_seconds: schema
            .number()
            .int()
            .min(1)
            .max(PIPPIT_MAX_WAIT_SECONDS)
            .default(PIPPIT_MAX_WAIT_SECONDS),
          output_directory: schema.string().min(1).optional(),
          run_id: schema.string().min(1),
          thread_id: schema.string().min(1),
          wait_for_completion: schema.boolean().default(false),
        },
        async execute(args, context) {
          const outputDirectory = args.output_directory ?? options.outputDirectory
          if (args.download) {
            await context.ask({
              always: [],
              metadata: {
                ...(args.account_id === undefined ? {} : { account_id: args.account_id }),
                output_directory: outputDirectory,
                run_id: args.run_id,
                target_origin: options.baseURL,
              },
              patterns: [options.baseURL, outputDirectory, args.run_id],
              permission: "pippit_download_video",
            })
          }
          context.metadata({ title: "Checking Pippit video", metadata: { run_id: args.run_id } })
          try {
            const credential = await credentials.readForRun(
              args.run_id,
              args.thread_id,
              args.account_id,
            )
            const result = await videos.get({
              accessKey: credential.accessKey,
              download: args.download,
              maxWaitSeconds: args.max_wait_seconds,
              ...(args.output_directory === undefined ? {} : { outputDirectory: args.output_directory }),
              rootDirectory: context.worktree,
              runId: args.run_id,
              signal: context.abort,
              threadId: args.thread_id,
              waitForCompletion: args.wait_for_completion,
            })
            return {
              metadata: {
                run_id: result.runId,
                status: result.status,
                ...(credential.accountId === undefined ? {} : { account_id: credential.accountId }),
              },
              output: resultOutput(result, credential),
              title: `Pippit video · ${result.status}`,
            }
          } catch (error) {
            throw normalizeToolError(error)
          }
        },
      }),
    },
  }
}

export function createPippitPlugin(dependencies: PippitPluginDependencies = {}): Plugin {
  return (input, rawOptions) => initializePippitPlugin(dependencies, input, rawOptions)
}

export const PippitPlugin: Plugin = createPippitPlugin()
