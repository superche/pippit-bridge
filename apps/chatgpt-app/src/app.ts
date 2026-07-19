import { resolve } from "node:path"

import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js"
import {
  PIPPIT_WIDGET_HTML,
  PIPPIT_WIDGET_URI,
  PIPPIT_TOOL_DEFINITIONS,
  PippitFacadeClient,
  createPippitToolRuntime,
  pippitWidgetResourceMetadata,
  projectPippitWidgetResult,
  type PippitMcpCallToolResult,
  type PippitWidgetMediaPreview,
} from "@pippit-bridge/mcp-server"
import { z } from "zod"

import {
  type ChatGptAppConfig,
  mediaPreviewsEnabled,
} from "./config.js"
import {
  type MediaTokenSigner,
  createMediaTokenSigner,
} from "./media-token.js"

const NOAUTH_SECURITY_SCHEMES = [{ type: "noauth" as const }]
const HTTP_URL_PATTERN = /^https?:/iu

const httpUrl = z.url().refine((value) => HTTP_URL_PATTERN.test(value), "Only HTTP(S) URLs are supported")

export const chatGptFileSchema = z
  .object({
    download_url: httpUrl,
    file_id: z.string().trim().min(1),
    file_name: z.string().trim().min(1).optional(),
    mime_type: z.string().trim().min(1).optional(),
  })
  .strict()

export type ChatGptFile = z.infer<typeof chatGptFileSchema>

export const CHATGPT_GENERATE_INPUT_SHAPE = {
  aspect_ratio: z.string().trim().min(1).optional(),
  audio_urls: z.array(httpUrl).max(3).optional(),
  audios: z.array(chatGptFileSchema).max(3).optional(),
  byok_id: z.string().trim().min(1).optional(),
  duration: z.number().int().positive().max(3_600).optional(),
  first_frame: chatGptFileSchema.optional(),
  first_frame_url: httpUrl.optional(),
  idempotency_key: z.string().trim().min(1).max(200),
  image_urls: z.array(httpUrl).max(9).optional(),
  images: z.array(chatGptFileSchema).max(9).optional(),
  last_frame: chatGptFileSchema.optional(),
  last_frame_url: httpUrl.optional(),
  model: z.string().trim().min(1),
  prompt: z.string().trim().min(1).max(20_000),
  resolution: z.string().trim().min(1).optional(),
  seed: z.number().int().min(-1).max(4_294_967_295).optional(),
  thread_id: z.string().trim().min(1).optional(),
  video_urls: z.array(httpUrl).max(3).optional(),
  videos: z.array(chatGptFileSchema).max(3).optional(),
}

export const chatGptGenerateInputSchema = z
  .object(CHATGPT_GENERATE_INPUT_SHAPE)
  .strict()
  .superRefine((input, context) => {
    if (input.first_frame !== undefined && input.first_frame_url !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Provide first_frame or first_frame_url, not both.",
        path: ["first_frame"],
      })
    }
    if (input.last_frame !== undefined && input.last_frame_url !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Provide last_frame or last_frame_url, not both.",
        path: ["last_frame"],
      })
    }

    const frameCount = [
      input.first_frame,
      input.first_frame_url,
      input.last_frame,
      input.last_frame_url,
    ].filter((value) => value !== undefined).length
    const imageCount = (input.images?.length ?? 0) + (input.image_urls?.length ?? 0)
    const videoCount = (input.videos?.length ?? 0) + (input.video_urls?.length ?? 0)
    const audioCount = (input.audios?.length ?? 0) + (input.audio_urls?.length ?? 0)

    if (frameCount > 0 && imageCount + videoCount + audioCount > 0) {
      context.addIssue({
        code: "custom",
        message: "Frame inputs cannot be combined with general image, video, or audio references.",
        path: ["first_frame"],
      })
    }
    if (imageCount + videoCount > 9) {
      context.addIssue({
        code: "custom",
        message: "At most 9 combined image and video references are supported.",
        path: ["images"],
      })
    }
    if (videoCount > 3) {
      context.addIssue({ code: "custom", message: "At most 3 video references are supported.", path: ["videos"] })
    }
    if (audioCount > 3) {
      context.addIssue({ code: "custom", message: "At most 3 audio references are supported.", path: ["audios"] })
    }
  })

export type ChatGptGenerateInput = z.infer<typeof chatGptGenerateInputSchema>

const editRegionSchema = z
  .object({
    height: z.number().positive().max(1),
    width: z.number().positive().max(1),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((region, context) => {
    if (region.x + region.width > 1) {
      context.addIssue({ code: "custom", message: "x + width must not exceed 1.", path: ["width"] })
    }
    if (region.y + region.height > 1) {
      context.addIssue({ code: "custom", message: "y + height must not exceed 1.", path: ["height"] })
    }
  })

const editAnnotationSchema = z
  .object({
    at_ms: z.number().int().nonnegative(),
    instruction: z.string().trim().min(1).max(2_000),
    region: editRegionSchema,
  })
  .strict()

const editSegmentSchema = z
  .object({
    end_ms: z.number().int().positive(),
    start_ms: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((segment, context) => {
    if (segment.end_ms <= segment.start_ms) {
      context.addIssue({ code: "custom", message: "end_ms must be greater than start_ms.", path: ["end_ms"] })
    } else if (segment.end_ms - segment.start_ms > 30_000) {
      context.addIssue({ code: "custom", message: "The selected segment must be at most 30 seconds.", path: ["end_ms"] })
    }
  })

export const CHATGPT_EDIT_INPUT_SHAPE = {
  annotations: z.array(editAnnotationSchema).max(20),
  byok_id: z.string().trim().min(1).max(256).optional(),
  idempotency_key: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(256),
  prompt: z.string().trim().min(1).max(20_000).optional(),
  resolution: z.string().trim().min(1).max(64).optional(),
  seed: z.number().int().min(-1).max(4_294_967_295).optional(),
  segment: editSegmentSchema,
  source_index: z.number().int().min(0).max(1_000).default(0),
  source_job_id: z.string().trim().min(1).max(8_192),
  thread_id: z.string().trim().min(1).max(8_192).optional(),
}

export const chatGptEditInputSchema = z
  .object(CHATGPT_EDIT_INPUT_SHAPE)
  .strict()
  .superRefine((input, context) => {
    if (input.prompt === undefined && input.annotations.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Provide an overall prompt or at least one region annotation.",
        path: ["prompt"],
      })
    }
    for (const [index, annotation] of input.annotations.entries()) {
      if (annotation.at_ms < input.segment.start_ms || annotation.at_ms > input.segment.end_ms) {
        context.addIssue({
          code: "custom",
          message: "Annotation time must fall inside the selected segment.",
          path: ["annotations", index, "at_ms"],
        })
      }
    }
  })

export type ChatGptEditInput = z.infer<typeof chatGptEditInputSchema>

const videoModelOutputSchema = z
  .object({
    allowed_passthrough_parameters: z.array(z.string()),
    canonical_slug: z.string(),
    created: z.number(),
    description: z.string(),
    generate_audio: z.boolean().nullable(),
    id: z.string(),
    name: z.string(),
    pricing_skus: z.null(),
    seed: z.boolean().nullable(),
    supported_aspect_ratios: z.array(z.string()).nullable(),
    supported_durations: z.array(z.number()).nullable(),
    supported_frame_images: z.array(z.enum(["first_frame", "last_frame"])).nullable(),
    supported_resolutions: z.array(z.string()).nullable(),
    supported_sizes: z.array(z.string()).nullable(),
  })
  .strict()

export const PIPPIT_MODEL_LIST_OUTPUT_SHAPE = {
  data: z.array(videoModelOutputSchema),
}

export const PIPPIT_VIDEO_JOB_OUTPUT_SHAPE = {
  error: z.string().optional(),
  generation_id: z.string().nullable().optional(),
  id: z.string(),
  model: z.string().nullable().optional(),
  polling_url: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled", "expired"]),
  usage: z
    .object({
      cost: z.number().nullable().optional(),
      is_byok: z.boolean().optional(),
    })
    .strict()
    .optional(),
}

type RuntimeToolResult = PippitMcpCallToolResult

export interface PippitToolRuntimeLike {
  callTool(name: string, args: unknown): Promise<RuntimeToolResult>
}

export interface PippitFacadeClientLike {
  downloadVideo(
    jobId: string,
    options?: { readonly index?: number; readonly range?: string; readonly signal?: AbortSignal },
  ): Promise<Response>
}

export interface ChatGptAppDependencies {
  readonly client: PippitFacadeClientLike
  readonly runtime: PippitToolRuntimeLike
}

export type MediaPreview = PippitWidgetMediaPreview

export interface ChatGptAppMcpOptions {
  readonly config: ChatGptAppConfig
  readonly dependencies?: ChatGptAppDependencies
}

export interface ChatGptAppRuntime {
  readonly client: PippitFacadeClientLike
  readonly mediaSigner?: MediaTokenSigner
  readonly runtime: PippitToolRuntimeLike
}

export const CHATGPT_TOOL_NAMES = {
  list: "pippit_list_video_models",
  generate: "pippit_generate_video",
  get: "pippit_get_video",
  edit: "pippit_edit_video_segment",
} as const

type ChatGptToolName = (typeof CHATGPT_TOOL_NAMES)[keyof typeof CHATGPT_TOOL_NAMES]

function sharedToolDefinition(name: ChatGptToolName): (typeof PIPPIT_TOOL_DEFINITIONS)[number] {
  const definition = PIPPIT_TOOL_DEFINITIONS.find((candidate) => candidate.name === name)
  if (definition === undefined) throw new Error(`The shared MCP runtime does not define ${name}.`)
  return definition
}

function sharedToolPresentation(name: ChatGptToolName): {
  readonly annotations: Record<string, unknown>
  readonly description: string
  readonly title: string
} {
  const definition = sharedToolDefinition(name)
  return {
    annotations: { ...definition.annotations },
    description: definition.description,
    title: definition.title,
  }
}

function normalizeGenerateInput(input: ChatGptGenerateInput): Record<string, unknown> {
  const firstFrameUrl = input.first_frame?.download_url ?? input.first_frame_url
  const lastFrameUrl = input.last_frame?.download_url ?? input.last_frame_url
  const frameImages = [
    ...(firstFrameUrl === undefined
      ? []
      : [{ frame_type: "first_frame", image_url: { url: firstFrameUrl }, type: "image_url" }]),
    ...(lastFrameUrl === undefined
      ? []
      : [{ frame_type: "last_frame", image_url: { url: lastFrameUrl }, type: "image_url" }]),
  ]
  const inputReferences = [
    ...(input.images ?? []).map((file) => ({ image_url: { url: file.download_url }, type: "image_url" })),
    ...(input.image_urls ?? []).map((url) => ({ image_url: { url }, type: "image_url" })),
    ...(input.videos ?? []).map((file) => ({ type: "video_url", video_url: { url: file.download_url } })),
    ...(input.video_urls ?? []).map((url) => ({ type: "video_url", video_url: { url } })),
    ...(input.audios ?? []).map((file) => ({ audio_url: { url: file.download_url }, type: "audio_url" })),
    ...(input.audio_urls ?? []).map((url) => ({ audio_url: { url }, type: "audio_url" })),
  ]
  return {
    ...(input.aspect_ratio === undefined ? {} : { aspect_ratio: input.aspect_ratio }),
    ...(input.byok_id === undefined ? {} : { byok_id: input.byok_id }),
    ...(input.duration === undefined ? {} : { duration: input.duration }),
    ...(frameImages.length === 0 ? {} : { frame_images: frameImages }),
    idempotency_key: input.idempotency_key,
    ...(inputReferences.length === 0 ? {} : { input_references: inputReferences }),
    model: input.model,
    prompt: input.prompt,
    ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.thread_id === undefined ? {} : { thread_id: input.thread_id }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function mediaUrl(config: ChatGptAppConfig, signer: MediaTokenSigner, jobId: string, index: number): string {
  if (config.publicBaseUrl === undefined) throw new Error("Media previews are not configured.")
  const url = new URL("media", `${config.publicBaseUrl}/`)
  url.searchParams.set("token", signer.issue(jobId, index))
  return url.toString()
}

async function decorateResult(
  result: RuntimeToolResult,
  config: ChatGptAppConfig,
  signer: MediaTokenSigner | undefined,
): Promise<CallToolResult> {
  return await projectPippitWidgetResult(
    result,
    signer === undefined ? undefined : (jobId, index) => mediaUrl(config, signer, jobId, index),
  ) as CallToolResult
}

function toolMetadata(invoking: string, invoked: string, widget: boolean): Record<string, unknown> {
  return {
    securitySchemes: NOAUTH_SECURITY_SCHEMES,
    ...(widget
      ? {
          ui: { resourceUri: PIPPIT_WIDGET_URI, visibility: ["model", "app"] },
          "openai/outputTemplate": PIPPIT_WIDGET_URI,
          "openai/widgetAccessible": true,
        }
      : {}),
    "openai/toolInvocation/invoked": invoked,
    "openai/toolInvocation/invoking": invoking,
  }
}

function withNoauthSecurity<T extends Record<string, unknown>>(
  config: T,
): T & { readonly securitySchemes: typeof NOAUTH_SECURITY_SCHEMES } {
  return { ...config, securitySchemes: NOAUTH_SECURITY_SCHEMES }
}

type ProtocolRequestHandler = (request: unknown, extra: unknown) => unknown | Promise<unknown>

interface ProtocolHandlerRegistry {
  readonly _requestHandlers: Map<string, ProtocolRequestHandler>
}

/**
 * MCP SDK 1.29 strips the Apps auth extension from registerTool configs.
 * Preserve the documented top-level field on the wire while retaining the
 * legacy _meta mirror used by older ChatGPT hosts.
 */
function installWireSecuritySchemeMirror(server: McpServer): void {
  const registry = (server.server as unknown as ProtocolHandlerRegistry)._requestHandlers
  const originalHandler = registry.get("tools/list")
  if (originalHandler === undefined) {
    throw new Error("The MCP SDK did not install its tools/list handler.")
  }
  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await originalHandler(request, extra)
    if (!isRecord(result) || !Array.isArray(result.tools) || !result.tools.every(isRecord)) {
      throw new Error("The MCP SDK returned an invalid tools/list result.")
    }
    return {
      ...result,
      tools: result.tools.map((tool) => ({
        ...tool,
        securitySchemes: NOAUTH_SECURITY_SCHEMES,
      })),
    } as unknown as ListToolsResult
  })
}

export function createChatGptAppRuntime(
  config: ChatGptAppConfig,
  dependencies?: ChatGptAppDependencies,
): ChatGptAppRuntime {
  if (dependencies !== undefined) {
    return {
      client: dependencies.client,
      ...(mediaPreviewsEnabled(config)
        ? {
            mediaSigner: createMediaTokenSigner({
              keyHex: config.mediaSigningKeyHex,
              ttlSeconds: config.mediaTtlSeconds,
            }),
          }
        : {}),
      runtime: dependencies.runtime,
    }
  }
  const client = new PippitFacadeClient({
    apiKey: config.facadeApiKey,
    baseUrl: config.facadeBaseUrl,
    timeoutMs: config.facadeTimeoutMs,
  })
  return {
    client,
    ...(mediaPreviewsEnabled(config)
      ? {
          mediaSigner: createMediaTokenSigner({
            keyHex: config.mediaSigningKeyHex,
            ttlSeconds: config.mediaTtlSeconds,
          }),
        }
      : {}),
    runtime: createPippitToolRuntime({
      client,
      outputRoot: resolve(process.cwd(), ".pippit/outputs"),
    }),
  }
}

function resourceMetadata(config: ChatGptAppConfig): Record<string, unknown> {
  const publicOrigin = config.publicBaseUrl === undefined ? undefined : new URL(config.publicBaseUrl).origin
  return pippitWidgetResourceMetadata(
    publicOrigin === undefined ? {} : { domain: publicOrigin, origin: publicOrigin },
  ) as Record<string, unknown>
}

export function createChatGptAppMcpServer(options: ChatGptAppMcpOptions): {
  readonly client: PippitFacadeClientLike
  readonly mediaSigner?: MediaTokenSigner
  readonly server: McpServer
} {
  const { config } = options
  const appRuntime = createChatGptAppRuntime(config, options.dependencies)
  const server = new McpServer({ name: "pippit-chatgpt-app", version: "0.2.11" })
  const sharedList = sharedToolPresentation(CHATGPT_TOOL_NAMES.list)
  const sharedGenerate = sharedToolPresentation(CHATGPT_TOOL_NAMES.generate)
  const sharedGet = sharedToolPresentation(CHATGPT_TOOL_NAMES.get)
  const sharedEdit = sharedToolPresentation(CHATGPT_TOOL_NAMES.edit)

  registerAppResource(
    server,
    "Pippit video job widget",
    PIPPIT_WIDGET_URI,
    {
      description: "Inline status, private preview, and reference-guided regeneration controls for Pippit video jobs.",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: resourceMetadata(config),
    },
    async () => ({
      contents: [
        {
          _meta: resourceMetadata(config),
          mimeType: RESOURCE_MIME_TYPE,
          text: PIPPIT_WIDGET_HTML,
          uri: PIPPIT_WIDGET_URI,
        },
      ],
    }),
  )

  registerAppTool(
    server,
    CHATGPT_TOOL_NAMES.list,
    withNoauthSecurity({
      _meta: toolMetadata("Loading Pippit models…", "Pippit models loaded", false),
      annotations: sharedList.annotations,
      description: sharedList.description,
      inputSchema: {},
      outputSchema: PIPPIT_MODEL_LIST_OUTPUT_SHAPE,
      title: sharedList.title,
    }),
    async () => decorateResult(await appRuntime.runtime.callTool(CHATGPT_TOOL_NAMES.list, {}), config, appRuntime.mediaSigner),
  )

  registerAppTool(
    server,
    CHATGPT_TOOL_NAMES.generate,
    withNoauthSecurity({
      _meta: {
        ...toolMetadata("Starting Pippit generation…", "Pippit generation started", true),
        "openai/fileParams": ["first_frame", "last_frame", "images", "videos", "audios"],
      },
      annotations: sharedGenerate.annotations,
      description: `${sharedGenerate.description} ChatGPT uploads bind to the top-level file parameters; URL alternatives are also accepted.`,
      inputSchema: CHATGPT_GENERATE_INPUT_SHAPE,
      outputSchema: PIPPIT_VIDEO_JOB_OUTPUT_SHAPE,
      title: sharedGenerate.title,
    }),
    async (rawInput) => {
      const input = chatGptGenerateInputSchema.parse(rawInput)
      const result = await appRuntime.runtime.callTool(CHATGPT_TOOL_NAMES.generate, normalizeGenerateInput(input))
      return decorateResult(result, config, appRuntime.mediaSigner)
    },
  )

  registerAppTool(
    server,
    CHATGPT_TOOL_NAMES.get,
    withNoauthSecurity({
      _meta: toolMetadata("Checking Pippit video…", "Pippit video status updated", true),
      annotations: sharedGet.annotations,
      description: sharedGet.description,
      inputSchema: { job_id: z.string().trim().min(1) },
      outputSchema: PIPPIT_VIDEO_JOB_OUTPUT_SHAPE,
      title: sharedGet.title,
    }),
    async ({ job_id }) =>
      decorateResult(
        await appRuntime.runtime.callTool(CHATGPT_TOOL_NAMES.get, { job_id }),
        config,
        appRuntime.mediaSigner,
      ),
  )

  registerAppTool(
    server,
    CHATGPT_TOOL_NAMES.edit,
    withNoauthSecurity({
      _meta: toolMetadata("Preparing reference video…", "New Pippit generation submitted", true),
      annotations: sharedEdit.annotations,
      description: sharedEdit.description,
      inputSchema: CHATGPT_EDIT_INPUT_SHAPE,
      outputSchema: PIPPIT_VIDEO_JOB_OUTPUT_SHAPE,
      title: sharedEdit.title,
    }),
    async (rawInput) => {
      const input = chatGptEditInputSchema.parse(rawInput)
      return decorateResult(
        await appRuntime.runtime.callTool(CHATGPT_TOOL_NAMES.edit, input),
        config,
        appRuntime.mediaSigner,
      )
    },
  )

  installWireSecuritySchemeMirror(server)

  return {
    client: appRuntime.client,
    ...(appRuntime.mediaSigner === undefined ? {} : { mediaSigner: appRuntime.mediaSigner }),
    server,
  }
}
