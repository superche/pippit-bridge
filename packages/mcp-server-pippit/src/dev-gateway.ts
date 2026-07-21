import { createPippitMcpMessageHandler, type JsonRpcResponse, type PippitMcpResourceProvider } from "./protocol.ts"
import { DevGatewayError, type DevWorkerPool } from "./dev-supervisor.ts"
import type { PippitMcpCallToolResult, PippitToolDefinition, PippitToolRuntime } from "./tools.ts"

export const PIPPIT_DEV_ERROR_PREVIEW_TOOL_NAME = "pippit_dev_preview_error_widget"
export const PIPPIT_DEV_ERROR_PREVIEW_VALUE = "error"

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

function devErrorPreviewTool(contract: FrozenDevContract): PippitToolDefinition {
  const videoWidgetTool = contract.tools.find(tool => tool.name === "pippit_get_video")
  const outputTemplate = videoWidgetTool?._meta?.["openai/outputTemplate"]
  if (typeof outputTemplate !== "string" || !outputTemplate.startsWith("ui://widget/")) {
    throw new Error("DEV_ERROR_PREVIEW_WIDGET_UNAVAILABLE")
  }
  return {
    _meta: {
      ui: { resourceUri: outputTemplate, visibility: ["model", "app"] },
      "ui/resourceUri": outputTemplate,
      "openai/outputTemplate": outputTemplate,
      "openai/toolInvocation/invoked": "Pippit error preview opened",
      "openai/toolInvocation/invoking": "Opening Pippit error preview…",
      "openai/widgetAccessible": true,
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
      title: "Preview the Pippit error widget",
    },
    description: "Development-only entry that opens the Pippit dot-matrix error widget without calling Pippit or changing video jobs.",
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
    name: PIPPIT_DEV_ERROR_PREVIEW_TOOL_NAME as PippitToolDefinition["name"],
    outputSchema: {
      additionalProperties: false,
      properties: { pippit_dev_preview: { const: PIPPIT_DEV_ERROR_PREVIEW_VALUE, type: "string" } },
      required: ["pippit_dev_preview"],
      type: "object",
    },
    title: "Preview Pippit error widget (development)",
  }
}

function devErrorPreviewResult(): PippitMcpCallToolResult {
  return {
    content: [{ text: "Opened the development-only Pippit error widget preview.", type: "text" }],
    structuredContent: { pippit_dev_preview: PIPPIT_DEV_ERROR_PREVIEW_VALUE },
  }
}

export function createDevMcpGateway(input: {
  readonly contract: FrozenDevContract
  readonly enableErrorPreview?: boolean
  readonly pool: DevWorkerPool<DevWorkerRequest, DevWorkerResult>
}): { readonly handle: (message: unknown) => Promise<JsonRpcResponse | undefined> } {
  const errorPreviewTool = input.enableErrorPreview === true
    ? devErrorPreviewTool(input.contract)
    : undefined
  const tools = errorPreviewTool === undefined
    ? input.contract.tools
    : [...input.contract.tools, errorPreviewTool]
  const readOnlyTools = new Set(tools
    .filter(tool => tool.annotations.readOnlyHint)
    .map(tool => tool.name))
  const runtime: PippitToolRuntime = {
    async callTool(name, argumentsValue) {
      if (errorPreviewTool !== undefined && name === PIPPIT_DEV_ERROR_PREVIEW_TOOL_NAME) {
        return devErrorPreviewResult()
      }
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
      return tools
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
