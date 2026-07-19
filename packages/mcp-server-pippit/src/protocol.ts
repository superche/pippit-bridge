import type { PippitMcpCallToolResult, PippitToolRuntime } from "./tools.ts"

export const PIPPIT_MCP_PROTOCOL_VERSION = "2025-11-25"
export const PIPPIT_MCP_SERVER_INFO = { name: "pippit-video", version: "0.2.11" } as const

const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"])

type JsonRpcId = number | string

export interface JsonRpcSuccess {
  readonly id: JsonRpcId
  readonly jsonrpc: "2.0"
  readonly result: Readonly<Record<string, unknown>> | PippitMcpCallToolResult
}

export interface JsonRpcFailure {
  readonly error: {
    readonly code: number
    readonly message: string
  }
  readonly id: JsonRpcId | null
  readonly jsonrpc: "2.0"
}

export type JsonRpcResponse = JsonRpcFailure | JsonRpcSuccess

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
}

function failure(id: JsonRpcId | null, code: number, message: string): JsonRpcFailure {
  return { error: { code, message }, id, jsonrpc: "2.0" }
}

function success(
  id: JsonRpcId,
  result: Readonly<Record<string, unknown>> | PippitMcpCallToolResult,
): JsonRpcSuccess {
  return { id, jsonrpc: "2.0", result }
}

export interface PippitMcpMessageHandler {
  handle(message: unknown): Promise<JsonRpcResponse | undefined>
}

export interface PippitMcpResourceProvider {
  listResources(): Promise<Readonly<Record<string, unknown>>>
  listResourceTemplates?(): Promise<Readonly<Record<string, unknown>>>
  readResource(uri: string): Promise<Readonly<Record<string, unknown>> | undefined>
}

export function createPippitMcpMessageHandler(
  runtime: PippitToolRuntime,
  resources?: PippitMcpResourceProvider,
): PippitMcpMessageHandler {
  let initialized = false
  return {
    async handle(message) {
      if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        return failure(null, -32600, "Invalid JSON-RPC request.")
      }
      const notification = message.id === undefined
      if (!notification && !isId(message.id)) return failure(null, -32600, "Invalid JSON-RPC request id.")
      if (notification) return undefined
      const id = message.id as JsonRpcId

      if (message.method === "initialize") {
        if (initialized || !isRecord(message.params) || typeof message.params.protocolVersion !== "string") {
          return failure(id, -32602, "Invalid initialize parameters.")
        }
        initialized = true
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(message.params.protocolVersion)
          ? message.params.protocolVersion
          : PIPPIT_MCP_PROTOCOL_VERSION
        return success(id, {
          capabilities: {
            ...(resources === undefined ? {} : { resources: { listChanged: false } }),
            tools: { listChanged: false },
          },
          instructions:
            "Use these tools only for Pippit video jobs through the configured facade. Never provide a raw Pippit Access Key.",
          protocolVersion,
          serverInfo: PIPPIT_MCP_SERVER_INFO,
        })
      }

      if (!initialized) return failure(id, -32002, "MCP server is not initialized.")
      if (message.method === "ping") return success(id, {})
      if (message.method === "tools/list") return success(id, { tools: runtime.listTools() })
      if (message.method === "resources/list" && resources !== undefined) {
        return success(id, await resources.listResources())
      }
      if (message.method === "resources/read" && resources !== undefined) {
        if (!isRecord(message.params) || typeof message.params.uri !== "string") {
          return failure(id, -32602, "Invalid resources/read parameters.")
        }
        const resource = await resources.readResource(message.params.uri)
        if (resource === undefined) return failure(id, -32602, "Unknown resource URI.")
        return success(id, resource)
      }
      if (message.method === "resources/templates/list" && resources !== undefined) {
        return success(id, resources.listResourceTemplates === undefined
          ? { resourceTemplates: [] }
          : await resources.listResourceTemplates())
      }
      if (message.method === "tools/call") {
        if (!isRecord(message.params) || typeof message.params.name !== "string") {
          return failure(id, -32602, "Invalid tools/call parameters.")
        }
        return success(id, await runtime.callTool(message.params.name, message.params.arguments))
      }
      return failure(id, -32601, "Method not found.")
    },
  }
}
