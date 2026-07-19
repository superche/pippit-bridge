#!/usr/bin/env node

import { realpathSync } from "node:fs"
import { createInterface } from "node:readline"
import { resolve } from "node:path"
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
  resolvePippitLocalRuntimePaths,
  resolvePippitRuntimeEnvironment,
} from "./local-runtime.ts"
import {
  PIPPIT_MANAGEMENT_TOOL_DEFINITIONS,
  PIPPIT_RUNTIME_TOOL_DEFINITIONS,
  createPippitToolRuntime,
  type PippitMcpCallToolResult,
  type PippitToolRuntime,
} from "./tools.ts"
import {
  createPippitWidgetMediaServer,
  type PippitWidgetMediaBackend,
  type PippitWidgetMediaServer,
} from "./widget-media.ts"
import {
  projectPippitWidgetResult,
  withPippitWidgetTools,
} from "./widget-protocol.ts"

export interface PippitStdioServerOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly input?: NodeJS.ReadableStream
  readonly output?: NodeJS.WritableStream
  readonly runtime?: PippitToolRuntime
  readonly widgetMedia?: PippitWidgetMediaServer
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

interface ConfiguredRuntime {
  readonly client: PippitFacadeClient
  readonly runtime: PippitToolRuntime
}

function createConfiguredRuntime(
  env: NodeJS.ProcessEnv,
): ConfiguredRuntime {
  const configured = parsePippitMcpOptions(env)
  const managementOptions = facadeManagementClientOptions(configured)
  const client = new PippitFacadeClient(facadeClientOptions(configured))
  return {
    client,
    runtime: createPippitToolRuntime({
      client,
      enrollmentPort: configured.enrollmentPort,
      enrollmentTtlMs: configured.enrollmentTtlMs,
      ...(managementOptions === undefined
        ? {}
        : { managementClient: new PippitFacadeManagementClient(managementOptions) }),
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
      .then((resolved) => createConfiguredRuntime(resolved.environment))
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
): PippitToolRuntime {
  return {
    async callTool(name, argumentsValue) {
      const result = await runtime.callTool(name, argumentsValue)
      try {
        return await projectPippitWidgetResult(result, (jobId, index) => widgetMedia.preparePreview(jobId, index))
      } catch {
        return localMediaUnavailable()
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
      return withPippitWidgetTools(runtime.listTools())
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
        runtime: options.runtime,
      }
  const widgetMedia = options.widgetMedia ?? createPippitWidgetMediaServer({
    artifactRoot: lazy.resolveMediaOutputRoot,
    backend: lazy.mediaBackend,
  })
  const runtime = withWidgetRuntime(lazy.runtime, widgetMedia)
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
