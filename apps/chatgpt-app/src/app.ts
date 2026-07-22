import { createHash } from "node:crypto"
import { join, resolve } from "node:path"

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
  PIPPIT_IMAGE_WIDGET_HTML,
  PIPPIT_IMAGE_WIDGET_URI,
  PIPPIT_WIDGET_HTML,
  PIPPIT_WIDGET_URI,
  PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_NAME,
  PIPPIT_TOOL_DEFINITIONS,
  PippitFacadeClient,
  createInMemoryPippitWidgetLineageStore,
  createPersistentPippitWidgetLineageStore,
  createPippitToolRuntime,
  extractPippitWidgetJob,
  pippitImageWidgetResourceMetadata,
  pippitWidgetResourceMetadata,
  projectPippitWidgetResult,
  type PippitMcpCallToolResult,
  type PippitWidgetLineageStore,
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
import {
  CHATGPT_EDIT_INPUT_SHAPE,
  CHATGPT_GENERATE_INPUT_SHAPE,
  CHATGPT_IMAGE_INPUT_SHAPE,
  PIPPIT_IMAGE_MODEL_LIST_OUTPUT_SHAPE,
  PIPPIT_IMAGE_OUTPUT_SHAPE,
  PIPPIT_MODEL_LIST_OUTPUT_SHAPE,
  PIPPIT_VIDEO_JOB_OUTPUT_SHAPE,
  chatGptEditInputSchema,
  chatGptGenerateInputSchema,
  chatGptImageInputSchema,
} from "./app-schemas.js"
import { normalizeGenerateInput, normalizeImageInput } from "./input-normalizers.js"

export * from "./app-schemas.js"

const NOAUTH_SECURITY_SCHEMES = [{ type: "noauth" as const }]
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
  readonly lineage?: PippitWidgetLineageStore
  readonly runtime: PippitToolRuntimeLike
}

export type MediaPreview = PippitWidgetMediaPreview

export interface ChatGptAppMcpOptions {
  readonly config: ChatGptAppConfig
  readonly dependencies?: ChatGptAppDependencies
}

export interface ChatGptAppRuntime {
  readonly client: PippitFacadeClientLike
  readonly lineage: PippitWidgetLineageStore
  readonly mediaSigner?: MediaTokenSigner
  readonly runtime: PippitToolRuntimeLike
}

export const CHATGPT_TOOL_NAMES = {
  imageList: "pippit_list_image_models",
  imageGenerate: "pippit_generate_image",
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

function toolMetadata(invoking: string, invoked: string, widget: boolean | string): Record<string, unknown> {
  const resourceUri = typeof widget === "string" ? widget : widget ? PIPPIT_WIDGET_URI : undefined
  return {
    securitySchemes: NOAUTH_SECURITY_SCHEMES,
    ...(resourceUri === undefined
      ? {}
      : {
          ui: { resourceUri, visibility: ["model", "app"] },
          "openai/outputTemplate": resourceUri,
          "openai/widgetAccessible": true,
        }
    ),
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
      lineage: dependencies.lineage ?? createInMemoryPippitWidgetLineageStore(),
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
    lineage: createPersistentPippitWidgetLineageStore({
      root: join(config.runtimeDataRoot, "widget-state", "lineage-v1"),
      scope: createHash("sha256").update(config.facadeApiKey, "utf8").digest("hex"),
    }),
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

function imageResourceMetadata(config: ChatGptAppConfig): Record<string, unknown> {
  const publicOrigin = config.publicBaseUrl === undefined ? undefined : new URL(config.publicBaseUrl).origin
  return pippitImageWidgetResourceMetadata(
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
  const server = new McpServer({ name: "pippit-chatgpt-app", version: "0.2.17" })
  const sharedImageList = sharedToolPresentation(CHATGPT_TOOL_NAMES.imageList)
  const sharedImageGenerate = sharedToolPresentation(CHATGPT_TOOL_NAMES.imageGenerate)
  const sharedList = sharedToolPresentation(CHATGPT_TOOL_NAMES.list)
  const sharedGenerate = sharedToolPresentation(CHATGPT_TOOL_NAMES.generate)
  const sharedGet = sharedToolPresentation(CHATGPT_TOOL_NAMES.get)
  const sharedEdit = sharedToolPresentation(CHATGPT_TOOL_NAMES.edit)

  registerAppResource(
    server,
    "Pippit image result widget",
    PIPPIT_IMAGE_WIDGET_URI,
    {
      description: "Inline preview and original-file download for generated Pippit images.",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: imageResourceMetadata(config),
    },
    async () => ({
      contents: [
        {
          _meta: imageResourceMetadata(config),
          mimeType: RESOURCE_MIME_TYPE,
          text: PIPPIT_IMAGE_WIDGET_HTML,
          uri: PIPPIT_IMAGE_WIDGET_URI,
        },
      ],
    }),
  )

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
    CHATGPT_TOOL_NAMES.imageList,
    withNoauthSecurity({
      _meta: toolMetadata("Loading Pippit image models…", "Pippit image models loaded", false),
      annotations: sharedImageList.annotations,
      description: sharedImageList.description,
      inputSchema: {},
      outputSchema: PIPPIT_IMAGE_MODEL_LIST_OUTPUT_SHAPE,
      title: sharedImageList.title,
    }),
    async () => decorateResult(
      await appRuntime.runtime.callTool(CHATGPT_TOOL_NAMES.imageList, {}),
      config,
      appRuntime.mediaSigner,
    ),
  )

  registerAppTool(
    server,
    CHATGPT_TOOL_NAMES.imageGenerate,
    withNoauthSecurity({
      _meta: {
        ...toolMetadata("Generating Pippit images…", "Pippit images generated", PIPPIT_IMAGE_WIDGET_URI),
        "openai/fileParams": ["images"],
      },
      annotations: sharedImageGenerate.annotations,
      description: `${sharedImageGenerate.description} ChatGPT uploads bind to images; URL alternatives are also accepted.`,
      inputSchema: CHATGPT_IMAGE_INPUT_SHAPE,
      outputSchema: PIPPIT_IMAGE_OUTPUT_SHAPE,
      title: sharedImageGenerate.title,
    }),
    async (rawInput) => {
      const input = chatGptImageInputSchema.parse(rawInput)
      return decorateResult(
        await appRuntime.runtime.callTool(CHATGPT_TOOL_NAMES.imageGenerate, normalizeImageInput(input)),
        config,
        appRuntime.mediaSigner,
      )
    },
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
    PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_NAME,
    withNoauthSecurity({
      _meta: {
        ...toolMetadata("Loading latest Pippit video…", "Latest Pippit video loaded", false),
        ui: { visibility: ["app"] },
        "openai/widgetAccessible": true,
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
        title: "Resolve latest regenerated video",
      },
      description: "Resolve the newest regenerated descendant without starting a generation.",
      inputSchema: { anchor_job_id: z.string().trim().min(1).max(8_192) },
      outputSchema: PIPPIT_VIDEO_JOB_OUTPUT_SHAPE,
      title: "Resolve latest regenerated video",
    }),
    async ({ anchor_job_id }) => {
      let latestJobId: string
      try {
        latestJobId = await appRuntime.lineage.resolve(anchor_job_id)
      } catch {
        return {
          content: [{ text: "The latest regenerated video state is temporarily unavailable.", type: "text" }],
          isError: true,
          structuredContent: {
            error: {
              code: "latest_video_state_unavailable",
              message: "The latest regenerated video state is temporarily unavailable.",
            },
          },
        }
      }
      return decorateResult(
        await appRuntime.runtime.callTool(CHATGPT_TOOL_NAMES.get, { job_id: latestJobId }),
        config,
        appRuntime.mediaSigner,
      )
    },
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
      const toolCall = appRuntime.runtime.callTool(CHATGPT_TOOL_NAMES.edit, input)
      const lineageCompletion = toolCall.then(async (result) => {
        const regeneratedJob = result.isError === true
          ? undefined
          : extractPippitWidgetJob(result.structuredContent)
        if (regeneratedJob !== undefined && regeneratedJob.id !== input.source_job_id) {
          await appRuntime.lineage.record(input.source_job_id, regeneratedJob.id)
        }
      })
      appRuntime.lineage.track(input.source_job_id, lineageCompletion)
      const result = await toolCall
      await lineageCompletion.catch(() => undefined)
      return decorateResult(
        result,
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
