import { createPippitMcpMessageHandler, type JsonRpcResponse, type PippitMcpResourceProvider } from "./protocol.ts"
import { DevGatewayError, type DevWorkerPool } from "./dev-supervisor.ts"
import type { PippitMcpCallToolResult, PippitToolDefinition, PippitToolRuntime } from "./tools.ts"

export type DevWorkerRequest =
  | { readonly argumentsValue: unknown; readonly method: "tools/call"; readonly name: string }
  | { readonly method: "resources/read"; readonly uri: string }

export type DevWorkerResult = PippitMcpCallToolResult | Readonly<Record<string, unknown>> | undefined

export interface FrozenDevContract {
  readonly resources: Readonly<Record<string, unknown>>
  readonly resourceTemplates: Readonly<Record<string, unknown>>
  readonly tools: readonly PippitToolDefinition[]
}

function stableToolFailure(error: unknown): PippitMcpCallToolResult {
  const code = error instanceof DevGatewayError ? error.code : "DEV_SUPERVISOR_UNAVAILABLE"
  const message = error instanceof Error ? error.message : "The development worker supervisor is unavailable."
  return {
    content: [{ text: `${code}: ${message}`, type: "text" }],
    isError: true,
    structuredContent: { error: { code, message, retryable: code === "DEV_SUPERVISOR_UNAVAILABLE" } },
  }
}

export function createDevMcpGateway(input: {
  readonly contract: FrozenDevContract
  readonly pool: DevWorkerPool<DevWorkerRequest, DevWorkerResult>
}): { readonly handle: (message: unknown) => Promise<JsonRpcResponse | undefined> } {
  const readOnlyTools = new Set(input.contract.tools
    .filter(tool => tool.annotations.readOnlyHint)
    .map(tool => tool.name))
  const runtime: PippitToolRuntime = {
    async callTool(name, argumentsValue) {
      try {
        const result = await input.pool.invoke(
          { argumentsValue, method: "tools/call", name },
          { writesState: !readOnlyTools.has(name as PippitToolDefinition["name"]) },
        )
        if (result && "content" in result) return result as PippitMcpCallToolResult
        return stableToolFailure(new Error("DEV_RESULT_VALIDATION_FAILED"))
      } catch (error) {
        return stableToolFailure(error)
      }
    },
    listTools() {
      return input.contract.tools
    },
  }
  const resources: PippitMcpResourceProvider = {
    async listResources() {
      return input.contract.resources
    },
    async listResourceTemplates() {
      return input.contract.resourceTemplates
    },
    async readResource(uri) {
      const result = await input.pool.invoke({ method: "resources/read", uri })
      if (result === undefined || "content" in result) return undefined
      return result
    },
  }
  const handler = createPippitMcpMessageHandler(runtime, resources)
  return { handle: message => handler.handle(message) }
}
