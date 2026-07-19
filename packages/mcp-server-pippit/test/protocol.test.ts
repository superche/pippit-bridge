import { describe, expect, it, vi } from "vitest"
import { createPippitMcpMessageHandler } from "../src/protocol.ts"
import type { PippitToolRuntime } from "../src/tools.ts"
import { PIPPIT_WIDGET_URI } from "../src/widget.ts"

function runtime(): PippitToolRuntime {
  return {
    callTool: vi.fn(async () => ({ content: [{ text: "{\"data\":[]}", type: "text" }] as const, structuredContent: { data: [] } })),
    listTools: () => [],
  }
}

describe("MCP JSON-RPC protocol", () => {
  it("negotiates initialize before listing and calling tools", async () => {
    const handler = createPippitMcpMessageHandler(runtime())
    await expect(handler.handle({ id: 1, jsonrpc: "2.0", method: "tools/list" })).resolves.toMatchObject({ error: { code: -32002 } })
    await expect(handler.handle({
      id: 2,
      jsonrpc: "2.0",
      method: "initialize",
      params: { capabilities: {}, clientInfo: { name: "test", version: "1" }, protocolVersion: "2025-06-18" },
    })).resolves.toMatchObject({ result: { capabilities: { tools: { listChanged: false } }, protocolVersion: "2025-06-18" } })
    await expect(handler.handle({ id: 3, jsonrpc: "2.0", method: "tools/list" })).resolves.toMatchObject({ result: { tools: [] } })
    await expect(handler.handle({ id: 4, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name: "pippit_list_video_models" } })).resolves.toMatchObject({ result: { structuredContent: { data: [] } } })
  })

  it("does not reply to notifications and returns standard method errors", async () => {
    const handler = createPippitMcpMessageHandler(runtime())
    await handler.handle({ id: 1, jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-11-25" } })
    await expect(handler.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).resolves.toBeUndefined()
    await expect(handler.handle({ id: 2, jsonrpc: "2.0", method: "unknown" })).resolves.toMatchObject({ error: { code: -32601 } })
  })

  it("advertises and serves MCP App resources when a provider is configured", async () => {
    const resources = {
      async listResources() {
        return { resources: [{ name: "widget", uri: PIPPIT_WIDGET_URI }] }
      },
      async readResource(uri: string) {
        return uri === PIPPIT_WIDGET_URI
          ? { contents: [{ mimeType: "text/html;profile=mcp-app", text: "<main></main>", uri }] }
          : undefined
      },
    }
    const handler = createPippitMcpMessageHandler(runtime(), resources)
    await expect(handler.handle({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    })).resolves.toMatchObject({
      result: {
        capabilities: {
          resources: { listChanged: false },
          tools: { listChanged: false },
        },
      },
    })
    await expect(handler.handle({ id: 2, jsonrpc: "2.0", method: "resources/list" })).resolves.toMatchObject({
      result: { resources: [{ uri: PIPPIT_WIDGET_URI }] },
    })
    await expect(handler.handle({
      id: 3,
      jsonrpc: "2.0",
      method: "resources/read",
      params: { uri: PIPPIT_WIDGET_URI },
    })).resolves.toMatchObject({ result: { contents: [{ uri: PIPPIT_WIDGET_URI }] } })
    await expect(handler.handle({
      id: 4,
      jsonrpc: "2.0",
      method: "resources/read",
      params: { uri: "ui://widget/unknown.html" },
    })).resolves.toMatchObject({ error: { code: -32602 } })
    await expect(handler.handle({
      id: 5,
      jsonrpc: "2.0",
      method: "resources/templates/list",
    })).resolves.toMatchObject({ result: { resourceTemplates: [] } })
  })
})
