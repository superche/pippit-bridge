#!/usr/bin/env node

import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { createInterface } from "node:readline"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { PippitFacadeClient, PippitFacadeManagementClient } from "./client.ts"
import {
  facadeClientOptions,
  facadeManagementClientOptions,
  parsePippitMcpOptions,
} from "./options.ts"
import { createPippitMcpMessageHandler, type JsonRpcResponse } from "./protocol.ts"
import {
  PippitLocalRuntimeError,
  openPippitMcpIdempotencyStore,
  resolvePippitLocalRuntimePaths,
  resolvePippitRuntimeEnvironment,
} from "./local-runtime.ts"
import {
  PIPPIT_MANAGEMENT_TOOL_DEFINITIONS,
  PIPPIT_RUNTIME_TOOL_DEFINITIONS,
  createPippitToolRuntime,
  type PippitMcpCallToolResult,
  type PippitToolDefinition,
  type PippitToolRuntime,
} from "./tools.ts"
import {
  createPippitWidgetMediaServer,
  type PippitWidgetMediaBackend,
  type PippitWidgetMediaServer,
} from "./widget-media.ts"
import {
  PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_NAME,
  createPersistentPippitWidgetLineageStore,
  type PippitWidgetLineageStore,
} from "./widget-lineage.ts"
import {
  extractPippitWidgetJob,
  projectPippitWidgetResult,
  withPippitWidgetTools,
} from "./widget-protocol.ts"
import type { IdempotencyStore } from "@pippit-bridge/core"

export interface PippitStdioServerOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly input?: NodeJS.ReadableStream
  readonly output?: NodeJS.WritableStream
  readonly runtime?: PippitToolRuntime
  readonly widgetLineage?: PippitWidgetLineageStore
  readonly widgetMedia?: PippitWidgetMediaServer
}

export const PIPPIT_READ_VIDEO_CHUNK_TOOL_NAME = "pippit_read_video_chunk"
export const PIPPIT_READ_IMAGE_TOOL_NAME = "pippit_read_image"
export { PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_NAME } from "./widget-lineage.ts"

const MAX_VIDEO_CHUNK_BYTES = 1024 * 1024
const PIPPIT_READ_IMAGE_TOOL_DEFINITION: PippitToolDefinition = {
  _meta: {
    ui: { visibility: ["app"] },
    "openai/widgetAccessible": true,
  },
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
    title: "Read saved image",
  },
  description: "Read one persistent local Pippit image for the Pippit image widget.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      resource_uri: {
        pattern: "^pippit-image://artifact/[a-f0-9]{64}\\.(?:jpg|png|webp)$",
        type: "string",
      },
    },
    required: ["resource_uri"],
    type: "object",
  },
  name: PIPPIT_READ_IMAGE_TOOL_NAME as PippitToolDefinition["name"],
  outputSchema: {
    additionalProperties: false,
    properties: {
      blob: { contentEncoding: "base64", type: "string" },
      bytes: { minimum: 1, type: "integer" },
      filename: { type: "string" },
      mime_type: { enum: ["image/jpeg", "image/png", "image/webp"], type: "string" },
      resource_uri: { type: "string" },
    },
    required: ["resource_uri", "filename", "bytes", "mime_type", "blob"],
    type: "object",
  },
  title: "Read saved image",
}

const PIPPIT_READ_VIDEO_CHUNK_TOOL_DEFINITION: PippitToolDefinition = {
  _meta: {
    ui: { visibility: ["app"] },
    "openai/widgetAccessible": true,
  },
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
    title: "Read saved video chunk",
  },
  description: "Read one bounded chunk from a persistent local Pippit MP4 for the Pippit video widget.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      length: { maximum: MAX_VIDEO_CHUNK_BYTES, minimum: 1, type: "integer" },
      offset: { minimum: 0, type: "integer" },
      resource_uri: {
        pattern: "^pippit-video://artifact/[a-f0-9]{64}$",
        type: "string",
      },
    },
    required: ["resource_uri", "offset", "length"],
    type: "object",
  },
  name: PIPPIT_READ_VIDEO_CHUNK_TOOL_NAME as PippitToolDefinition["name"],
  outputSchema: {
    additionalProperties: false,
    properties: {
      blob: { contentEncoding: "base64", type: "string" },
      bytes: { minimum: 1, type: "integer" },
      complete: { type: "boolean" },
      mime_type: { const: "video/mp4", type: "string" },
      offset: { minimum: 0, type: "integer" },
      resource_uri: { type: "string" },
      total_bytes: { minimum: 1, type: "integer" },
    },
    required: ["resource_uri", "offset", "bytes", "total_bytes", "complete", "mime_type", "blob"],
    type: "object",
  },
  title: "Read saved video chunk",
}

const PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_DEFINITION: PippitToolDefinition = {
  _meta: {
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
  description: "Resolve the newest regenerated descendant of a Pippit video job without starting a generation.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      anchor_job_id: { minLength: 1, type: "string" },
    },
    required: ["anchor_job_id"],
    type: "object",
  },
  name: PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_NAME as PippitToolDefinition["name"],
  outputSchema: PIPPIT_RUNTIME_TOOL_DEFINITIONS.find(definition => definition.name === "pippit_get_video")
    ?.outputSchema ?? { type: "object" },
  title: "Resolve latest regenerated video",
}

interface ReadVideoChunkInput {
  readonly length: number
  readonly offset: number
  readonly resourceUri: string
}

function parseReadImageInput(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 1 ||
    typeof record.resource_uri !== "string" ||
    !/^pippit-image:\/\/artifact\/[a-f0-9]{64}\.(?:jpg|png|webp)$/u.test(record.resource_uri)
  ) return undefined
  return record.resource_uri
}

function parseResolveLatestVideoInput(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 1 ||
    typeof record.anchor_job_id !== "string" ||
    record.anchor_job_id.trim() === "" ||
    Buffer.byteLength(record.anchor_job_id, "utf8") > 16_384
  ) return undefined
  return record.anchor_job_id
}

function parseReadVideoChunkInput(value: unknown): ReadVideoChunkInput | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 3 ||
    typeof record.resource_uri !== "string" ||
    !Number.isSafeInteger(record.offset) ||
    !Number.isSafeInteger(record.length) ||
    (record.offset as number) < 0 ||
    (record.length as number) < 1 ||
    (record.length as number) > MAX_VIDEO_CHUNK_BYTES
  ) return undefined
  return {
    length: record.length as number,
    offset: record.offset as number,
    resourceUri: record.resource_uri,
  }
}

function localVideoChunkFailure(code: string, message: string): PippitMcpCallToolResult {
  return {
    content: [{ text: message, type: "text" }],
    isError: true,
    structuredContent: { error: { code, message } },
  }
}

function parseFailure(): JsonRpcResponse {
  return { error: { code: -32700, message: "Invalid JSON." }, id: null, jsonrpc: "2.0" }
}

function internalFailure(message: unknown): JsonRpcResponse {
  let id: number | string | null = null
  if (typeof message === "object" && message !== null && !Array.isArray(message)) {
    const candidate = (message as Record<string, unknown>).id
    if (typeof candidate === "string" || (typeof candidate === "number" && Number.isFinite(candidate))) {
      id = candidate
    }
  }
  return { error: { code: -32603, message: "Internal error." }, id, jsonrpc: "2.0" }
}

function runtimeUnavailable(error: unknown): PippitMcpCallToolResult {
  const message = error instanceof PippitLocalRuntimeError
    ? error.message
    : "The Pippit runtime could not be initialized."
  return {
    content: [{ text: `Pippit runtime unavailable: ${message}`.slice(0, 2_000), type: "text" }],
    isError: true,
    structuredContent: {
      error: {
        code: error instanceof PippitLocalRuntimeError ? error.code : "runtime_unavailable",
        message,
      },
    },
  }
}

function localMediaUnavailable(): PippitMcpCallToolResult {
  const message = "The video completed upstream but could not be saved as a local MP4. Retry pippit_get_video; no remote media URL was returned to the player."
  return {
    content: [{ text: message, type: "text" }],
    isError: true,
    structuredContent: {
      error: {
        code: "local_media_unavailable",
        message,
      },
    },
  }
}

function localImageUnavailable(): PippitMcpCallToolResult {
  const message = "The image completed upstream but could not be saved as a local file. Retry only if the user explicitly approves another potentially billable generation."
  return {
    content: [{ text: message, type: "text" }],
    isError: true,
    structuredContent: {
      error: {
        code: "local_image_unavailable",
        message,
      },
    },
  }
}

interface ConfiguredRuntime {
  readonly client: PippitFacadeClient
  readonly lineageScope: string
  readonly runtime: PippitToolRuntime
}

function createConfiguredRuntime(
  env: NodeJS.ProcessEnv,
  idempotencyStore: IdempotencyStore,
): ConfiguredRuntime {
  const configured = parsePippitMcpOptions(env)
  const managementOptions = facadeManagementClientOptions(configured)
  const client = new PippitFacadeClient(facadeClientOptions(configured))
  const lineageScope = createHash("sha256").update(configured.facadeApiKey, "utf8").digest("hex")
  return {
    client,
    lineageScope,
    runtime: createPippitToolRuntime({
      client,
      enrollmentPort: configured.enrollmentPort,
      enrollmentTtlMs: configured.enrollmentTtlMs,
      ...(managementOptions === undefined
        ? {}
        : { managementClient: new PippitFacadeManagementClient(managementOptions) }),
      idempotencyScope: lineageScope,
      idempotencyStore,
      outputRoot: configured.outputRoot,
    }),
  }
}

export function resolvePippitStdioMediaOutputRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (typeof env.PIPPIT_FACADE_API_KEY === "string" && env.PIPPIT_FACADE_API_KEY.trim() !== "") {
    return parsePippitMcpOptions(env).outputRoot
  }
  return resolvePippitLocalRuntimePaths(env).outputRoot
}

function createLazyPippitToolRuntime(env: NodeJS.ProcessEnv): {
  readonly mediaBackend: PippitWidgetMediaBackend
  readonly resolveLineageScope: () => Promise<string>
  readonly resolveMediaOutputRoot: () => Promise<string>
  readonly runtime: PippitToolRuntime
} {
  let configuredPromise: Promise<ConfiguredRuntime> | undefined
  let configuredRuntime: ConfiguredRuntime | undefined
  const externalWithoutManagement =
    typeof env.PIPPIT_FACADE_API_KEY === "string" &&
    env.PIPPIT_FACADE_API_KEY.trim() !== "" &&
    (typeof env.PIPPIT_FACADE_MANAGEMENT_API_KEY !== "string" ||
      env.PIPPIT_FACADE_MANAGEMENT_API_KEY.trim() === "")

  const initialize = (): Promise<ConfiguredRuntime> => {
    configuredPromise ??= resolvePippitRuntimeEnvironment(env)
      .then(async (resolved) => createConfiguredRuntime(
        resolved.environment,
        await openPippitMcpIdempotencyStore(env),
      ))
      .then((configured) => {
        configuredRuntime = configured
        return configured
      })
      .catch((error: unknown) => {
        configuredPromise = undefined
        throw error
      })
    return configuredPromise
  }

  return {
    mediaBackend: {
      async downloadVideo(jobId, options) {
        return await (await initialize()).client.downloadVideo(jobId, options)
      },
    },
    async resolveLineageScope() {
      return (await initialize()).lineageScope
    },
    async resolveMediaOutputRoot() {
      return resolvePippitStdioMediaOutputRoot(env)
    },
    runtime: {
      async callTool(name, argumentsValue) {
        try {
          return await (await initialize()).runtime.callTool(name, argumentsValue)
        } catch (error) {
          return runtimeUnavailable(error)
        }
      },
      async close() {
        await configuredRuntime?.runtime.close?.()
      },
      listTools() {
        return externalWithoutManagement
          ? PIPPIT_RUNTIME_TOOL_DEFINITIONS
          : [...PIPPIT_RUNTIME_TOOL_DEFINITIONS, ...PIPPIT_MANAGEMENT_TOOL_DEFINITIONS]
      },
    },
  }
}

function withWidgetRuntime(
  runtime: PippitToolRuntime,
  widgetMedia: PippitWidgetMediaServer,
  widgetLineage: PippitWidgetLineageStore,
): PippitToolRuntime {
  return {
    async callTool(name, argumentsValue) {
      if (name === PIPPIT_READ_IMAGE_TOOL_NAME) {
        const resourceUri = parseReadImageInput(argumentsValue)
        if (resourceUri === undefined) {
          return localVideoChunkFailure("invalid_arguments", "Invalid saved image request.")
        }
        try {
          const image = await widgetMedia.readImage?.(resourceUri)
          if (image === undefined) {
            return localVideoChunkFailure("local_image_unavailable", "The saved local image is unavailable.")
          }
          return {
            content: [],
            structuredContent: {
              blob: image.blob,
              bytes: image.bytes,
              filename: image.filename,
              mime_type: image.mimeType,
              resource_uri: image.resourceUri,
            },
          }
        } catch {
          return localVideoChunkFailure("local_image_unavailable", "The saved local image is unavailable.")
        }
      }
      if (name === PIPPIT_READ_VIDEO_CHUNK_TOOL_NAME) {
        const input = parseReadVideoChunkInput(argumentsValue)
        if (input === undefined) {
          return localVideoChunkFailure("invalid_arguments", "Invalid saved video chunk request.")
        }
        try {
          const chunk = await widgetMedia.readChunk(input.resourceUri, input.offset, input.length)
          if (chunk === undefined) {
            return localVideoChunkFailure(
              "local_media_chunk_unavailable",
              "The saved local video chunk is unavailable.",
            )
          }
          return {
            content: [],
            structuredContent: {
              blob: chunk.blob,
              bytes: chunk.bytes,
              complete: chunk.complete,
              mime_type: chunk.mimeType,
              offset: chunk.offset,
              resource_uri: chunk.resourceUri,
              total_bytes: chunk.totalBytes,
            },
          }
        } catch {
          return localVideoChunkFailure(
            "local_media_chunk_unavailable",
            "The saved local video chunk is unavailable.",
          )
        }
      }
      if (name === PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_NAME) {
        const anchorJobId = parseResolveLatestVideoInput(argumentsValue)
        if (anchorJobId === undefined) {
          return localVideoChunkFailure("invalid_arguments", "Invalid latest video request.")
        }
        let latestJobId: string
        try {
          latestJobId = await widgetLineage.resolve(anchorJobId)
        } catch {
          return localVideoChunkFailure(
            "latest_video_state_unavailable",
            "The latest regenerated video state is temporarily unavailable.",
          )
        }
        const latestResult = await runtime.callTool("pippit_get_video", { job_id: latestJobId })
        try {
          return await projectPippitWidgetResult(
            latestResult,
            (jobId, index) => widgetMedia.preparePreview(jobId, index),
          )
        } catch {
          return localMediaUnavailable()
        }
      }

      const toolCall = runtime.callTool(name, argumentsValue)
      const sourceJobId = name === "pippit_edit_video_segment" &&
        typeof argumentsValue === "object" &&
        argumentsValue !== null &&
        !Array.isArray(argumentsValue) &&
        typeof (argumentsValue as Record<string, unknown>).source_job_id === "string"
        ? (argumentsValue as Record<string, string>).source_job_id
        : undefined
      const lineageCompletion = sourceJobId === undefined
        ? undefined
        : toolCall.then(async (result) => {
            const regeneratedJob = result.isError === true
              ? undefined
              : extractPippitWidgetJob(result.structuredContent)
            if (regeneratedJob !== undefined && regeneratedJob.id !== sourceJobId) {
              await widgetLineage.record(sourceJobId, regeneratedJob.id)
            }
          })
      if (sourceJobId !== undefined && lineageCompletion !== undefined) {
        widgetLineage.track(sourceJobId, lineageCompletion)
      }
      const result = await toolCall
      await lineageCompletion?.catch(() => undefined)
      try {
        return await projectPippitWidgetResult(
          result,
          (jobId, index) => widgetMedia.preparePreview(jobId, index),
          widgetMedia.prepareImage === undefined
            ? undefined
            : (data, mimeType) => widgetMedia.prepareImage!(data, mimeType),
        )
      } catch {
        return name === "pippit_generate_image" ? localImageUnavailable() : localMediaUnavailable()
      }
    },
    async close() {
      try {
        await widgetMedia.close()
      } finally {
        await runtime.close?.()
      }
    },
    listTools() {
      return [
        ...withPippitWidgetTools(runtime.listTools()),
        PIPPIT_READ_IMAGE_TOOL_DEFINITION,
        PIPPIT_READ_VIDEO_CHUNK_TOOL_DEFINITION,
        PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_DEFINITION,
      ]
    },
  }
}

export async function runPippitStdioServer(options: PippitStdioServerOptions = {}): Promise<void> {
  const lazy = options.runtime === undefined
    ? createLazyPippitToolRuntime(options.env ?? process.env)
    : {
        mediaBackend: {
          async downloadVideo(): Promise<Response> {
            throw new Error("The injected runtime did not provide a widget media backend.")
          },
        },
        async resolveMediaOutputRoot(): Promise<string> {
          return resolvePippitLocalRuntimePaths(options.env ?? process.env).outputRoot
        },
        async resolveLineageScope(): Promise<string> {
          return "injected-runtime"
        },
        runtime: options.runtime,
      }
  const widgetMedia = options.widgetMedia ?? createPippitWidgetMediaServer({
    artifactRoot: lazy.resolveMediaOutputRoot,
    backend: lazy.mediaBackend,
  })
  const runtimePaths = resolvePippitLocalRuntimePaths(options.env ?? process.env)
  const widgetLineage = options.widgetLineage ?? createPersistentPippitWidgetLineageStore({
    root: join(runtimePaths.dataRoot, "widget-state", "lineage-v1"),
    scope: lazy.resolveLineageScope,
  })
  const runtime = withWidgetRuntime(lazy.runtime, widgetMedia, widgetLineage)
  const handler = createPippitMcpMessageHandler(runtime, widgetMedia)
  const output = options.output ?? process.stdout
  const input = options.input ?? process.stdin
  const lines = createInterface({ crlfDelay: Infinity, input, terminal: false })
  let closePromise: Promise<void> | undefined
  const closeRuntime = (): Promise<void> => {
    closePromise ??= runtime.close?.() ?? Promise.resolve()
    return closePromise
  }
  const closeAtEof = (): void => { void closeRuntime().catch(() => undefined) }
  input.once("end", closeAtEof)
  try {
    for await (const line of lines) {
      let response: JsonRpcResponse | undefined
      let message: unknown
      try {
        message = JSON.parse(line) as unknown
      } catch {
        response = parseFailure()
      }
      if (response === undefined) {
        try {
          response = await handler.handle(message)
        } catch {
          response = internalFailure(message)
        }
      }
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`)
    }
  } finally {
    input.removeListener("end", closeAtEof)
    lines.close()
    await closeRuntime()
  }
}

export function isPippitStdioEntrypoint(
  argvPath: string | undefined = process.argv[1],
  moduleUrl = import.meta.url,
): boolean {
  if (argvPath === undefined) return false
  try {
    return realpathSync(resolve(argvPath)) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return pathToFileURL(resolve(argvPath)).href === moduleUrl
  }
}

if (isPippitStdioEntrypoint()) {
  void runPippitStdioServer().catch(() => {
    process.stderr.write("Pippit MCP server could not start. Check facade environment configuration.\n")
    process.exitCode = 1
  })
}
