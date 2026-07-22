import { createHash } from "node:crypto"
import type { IdempotencyStore } from "@pippit-bridge/core"
import { PippitFacadeClient, PippitFacadeManagementClient } from "../client.ts"
import {
  PippitLocalRuntimeError,
  openPippitMcpIdempotencyStore,
  resolvePippitLocalRuntimePaths,
  resolvePippitRuntimeEnvironment,
} from "../local-runtime.ts"
import {
  facadeClientOptions,
  facadeManagementClientOptions,
  parsePippitMcpOptions,
} from "../options.ts"
import {
  createPippitToolRuntime,
  PIPPIT_MANAGEMENT_TOOL_DEFINITIONS,
  PIPPIT_RUNTIME_TOOL_DEFINITIONS,
  type PippitMcpCallToolResult,
  type PippitToolRuntime,
} from "../tools.ts"
import type { PippitWidgetMediaBackend } from "../widget-media.ts"

interface ConfiguredRuntime {
  readonly client: PippitFacadeClient
  readonly lineageScope: string
  readonly runtime: PippitToolRuntime
}

export interface LazyPippitToolRuntime {
  readonly mediaBackend: PippitWidgetMediaBackend
  readonly resolveLineageScope: () => Promise<string>
  readonly resolveMediaOutputRoot: () => Promise<string>
  readonly runtime: PippitToolRuntime
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

function createConfiguredRuntime(env: NodeJS.ProcessEnv, idempotencyStore: IdempotencyStore): ConfiguredRuntime {
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

export function createLazyPippitToolRuntime(env: NodeJS.ProcessEnv): LazyPippitToolRuntime {
  let configuredPromise: Promise<ConfiguredRuntime> | undefined
  let configuredRuntime: ConfiguredRuntime | undefined
  const externalWithoutManagement =
    typeof env.PIPPIT_FACADE_API_KEY === "string" &&
    env.PIPPIT_FACADE_API_KEY.trim() !== "" &&
    (typeof env.PIPPIT_FACADE_MANAGEMENT_API_KEY !== "string" ||
      env.PIPPIT_FACADE_MANAGEMENT_API_KEY.trim() === "")

  const initialize = (): Promise<ConfiguredRuntime> => {
    configuredPromise ??= resolvePippitRuntimeEnvironment(env)
      .then(async resolved => createConfiguredRuntime(
        resolved.environment,
        await openPippitMcpIdempotencyStore(env),
      ))
      .then(configured => {
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
    async resolveLineageScope() { return (await initialize()).lineageScope },
    async resolveMediaOutputRoot() { return resolvePippitStdioMediaOutputRoot(env) },
    runtime: {
      async callTool(name, argumentsValue) {
        try {
          return await (await initialize()).runtime.callTool(name, argumentsValue)
        } catch (error) {
          return runtimeUnavailable(error)
        }
      },
      async close() { await configuredRuntime?.runtime.close?.() },
      listTools() {
        return externalWithoutManagement
          ? PIPPIT_RUNTIME_TOOL_DEFINITIONS
          : [...PIPPIT_RUNTIME_TOOL_DEFINITIONS, ...PIPPIT_MANAGEMENT_TOOL_DEFINITIONS]
      },
    },
  }
}
