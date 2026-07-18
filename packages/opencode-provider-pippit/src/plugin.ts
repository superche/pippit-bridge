import { createPublicHttpFetcher, createReferenceLoader, VIDEO_MODELS } from "@pippit-bridge/core"
import { PippitApiError, PippitClient } from "@pippit-bridge/sdk"
import { tool, type Config, type Plugin } from "@opencode-ai/plugin"
import { createPippitAuthHook, PippitCredentialSource } from "./auth.js"
import { PippitVideoService, type PippitToolResult } from "./generation.js"
import {
  PIPPIT_ACCESS_KEY_ENV,
  PIPPIT_PROVIDER_ID,
  parsePluginOptions,
} from "./options.js"

type MutableProviderConfig = {
  env?: string[]
  models?: Record<string, unknown>
  name?: string
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

function resultOutput(result: PippitToolResult): string {
  return JSON.stringify(
    {
      status: result.status,
      run_id: result.runId,
      thread_id: result.threadId,
      ...(result.model === undefined ? {} : { model: result.model }),
      ...(result.files === undefined ? {} : { files: result.files }),
      ...(result.videoUrls === undefined ? {} : { video_urls: result.videoUrls }),
      ...(result.failure === undefined ? {} : { failure: result.failure }),
      ...(result.webThreadLink === undefined ? {} : { web_thread_link: result.webThreadLink }),
    },
    null,
    2,
  )
}

function normalizeToolError(error: unknown): Error {
  if (error instanceof PippitApiError && (error.status === 401 || error.status === 403)) {
    return new Error("The Pippit Access Key was rejected. Reconnect Pippit in OpenCode and try again.")
  }
  if (error instanceof Error) return error
  return new Error("Pippit could not complete the video operation.")
}

export const PippitPlugin: Plugin = async (_input, rawOptions) => {
  const options = parsePluginOptions(rawOptions)
  const credentials = new PippitCredentialSource()
  const pippit = new PippitClient({ baseUrl: options.baseURL, timeoutMs: options.requestTimeoutMs })
  const remoteLoader = createReferenceLoader({
    allowPrivateUrls: options.allowPrivateReferenceUrls,
    timeoutMs: options.requestTimeoutMs,
  })
  const outputFetcher = createPublicHttpFetcher({ allowPrivateUrls: options.allowPrivateReferenceUrls })
  const videos = new PippitVideoService({
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
          last_frame: schema.string().min(1).optional(),
          max_wait_seconds: schema.number().int().min(1).max(3_600).default(900),
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
            const accessKey = await credentials.read()
            const result = await videos.generate({
              accessKey,
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
            return {
              metadata: { model: result.model, run_id: result.runId, status: result.status },
              output: resultOutput(result),
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
          download: schema.boolean().default(true),
          max_wait_seconds: schema.number().int().min(1).max(3_600).default(900),
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
            const accessKey = await credentials.read()
            const result = await videos.get({
              accessKey,
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
              metadata: { run_id: result.runId, status: result.status },
              output: resultOutput(result),
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
