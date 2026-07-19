import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { PIPPIT_TOOL_DEFINITIONS, PIPPIT_WIDGET_URI } from "@pippit-bridge/mcp-server"
import { afterEach, describe, expect, it } from "vitest"

import {
  CHATGPT_TOOL_NAMES,
  chatGptEditInputSchema,
  createChatGptAppMcpServer,
  type PippitFacadeClientLike,
  type PippitToolRuntimeLike,
} from "../src/app.js"
import type { ChatGptAppConfig } from "../src/config.js"

const connected: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(connected.splice(0).map((item) => item.close()))
})

function config(): ChatGptAppConfig {
  return {
    facadeApiKey: "facade-secret",
    facadeBaseUrl: "http://127.0.0.1:3000",
    facadeTimeoutMs: 120_000,
    host: "127.0.0.1",
    mediaSigningKeyHex: "a".repeat(64),
    mediaTtlSeconds: 300,
    port: 8787,
    publicBaseUrl: "https://apps.example.test",
  }
}

describe("Pippit ChatGPT MCP App", () => {
  it("registers noauth tools, output schemas, and the MCP App resource", async () => {
    const calls: Array<{ args: unknown; name: string }> = []
    const runtime: PippitToolRuntimeLike = {
      async callTool(name, args) {
        calls.push({ args, name })
        if (name === CHATGPT_TOOL_NAMES.list) {
          return { content: [{ type: "text", text: "No models in this test." }], structuredContent: { data: [] } }
        }
        const job = {
          id: "job_123",
          model: "pippit/test",
          polling_url: "/api/v1/videos/job_123",
          status: "completed",
          unsigned_urls: ["/api/v1/videos/job_123/content?index=0"],
        }
        return { content: [{ type: "text", text: JSON.stringify(job) }], structuredContent: job }
      },
    }
    const clientDependency: PippitFacadeClientLike = {
      async downloadVideo() {
        return new Response("video")
      },
    }
    const { server } = createChatGptAppMcpServer({
      config: config(),
      dependencies: { client: clientDependency, runtime },
    })
    const client = new Client({ name: "test-client", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    connected.push(client, server)
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual(Object.values(CHATGPT_TOOL_NAMES))
    expect(listed.tools.some((tool) => /access[_-]?key|byok/iu.test(tool.name))).toBe(false)
    for (const tool of listed.tools) {
      expect(tool._meta?.securitySchemes).toEqual([{ type: "noauth" }])
      expect(tool.outputSchema).toBeDefined()
    }
    const listTool = listed.tools.find((tool) => tool.name === CHATGPT_TOOL_NAMES.list)
    const generateTool = listed.tools.find((tool) => tool.name === CHATGPT_TOOL_NAMES.generate)
    const getTool = listed.tools.find((tool) => tool.name === CHATGPT_TOOL_NAMES.get)
    const editTool = listed.tools.find((tool) => tool.name === CHATGPT_TOOL_NAMES.edit)
    expect(listTool?._meta?.ui).toBeUndefined()
    expect(generateTool?.annotations?.openWorldHint).toBe(true)
    expect(generateTool?._meta?.["openai/fileParams"]).toEqual([
      "first_frame",
      "last_frame",
      "images",
      "videos",
      "audios",
    ])
    expect((generateTool?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe(PIPPIT_WIDGET_URI)
    expect(generateTool?._meta?.["ui/resourceUri"]).toBe(PIPPIT_WIDGET_URI)
    expect((generateTool?.outputSchema?.properties as Record<string, unknown> | undefined)).not.toHaveProperty(
      "unsigned_urls",
    )
    expect((getTool?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe(PIPPIT_WIDGET_URI)
    expect((editTool?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe(PIPPIT_WIDGET_URI)
    expect(generateTool?._meta?.["openai/widgetAccessible"]).toBe(true)
    expect(getTool?._meta?.["openai/widgetAccessible"]).toBe(true)
    expect(editTool?._meta?.["openai/widgetAccessible"]).toBe(true)

    for (const tool of [listTool, getTool, editTool]) {
      const shared = PIPPIT_TOOL_DEFINITIONS.find((definition) => definition.name === tool?.name)
      expect(shared).toBeDefined()
      expect(tool).toMatchObject({
        annotations: shared?.annotations,
        description: shared?.description,
        title: shared?.title,
      })
    }

    const resources = await client.listResources()
    expect(resources.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mimeType: "text/html;profile=mcp-app", uri: PIPPIT_WIDGET_URI }),
      ]),
    )
    const resource = await client.readResource({ uri: PIPPIT_WIDGET_URI })
    expect(resource.contents[0]).toMatchObject({
      mimeType: "text/html;profile=mcp-app",
      uri: PIPPIT_WIDGET_URI,
    })
    expect((resource.contents[0]?._meta?.ui as { domain?: string } | undefined)?.domain).toBe(
      "https://apps.example.test",
    )

    const generated = await client.callTool({
      arguments: {
        audios: [
          {
            download_url: "https://files.example.test/audio.mp3",
            file_id: "file_audio",
            file_name: "audio.mp3",
            mime_type: "audio/mpeg",
          },
        ],
        byok_id: "credential_1",
        idempotency_key: "retry_1",
        image_urls: ["https://images.example.test/reference.png"],
        model: "pippit/test",
        prompt: "Animate this product",
        thread_id: "thread_1",
      },
      name: CHATGPT_TOOL_NAMES.generate,
    })
    expect(calls.at(-1)).toMatchObject({
      args: {
        byok_id: "credential_1",
        idempotency_key: "retry_1",
        input_references: [
          { image_url: { url: "https://images.example.test/reference.png" }, type: "image_url" },
          { audio_url: { url: "https://files.example.test/audio.mp3" }, type: "audio_url" },
        ],
        thread_id: "thread_1",
      },
      name: CHATGPT_TOOL_NAMES.generate,
    })
    expect(generated.structuredContent).not.toHaveProperty("unsigned_urls")
    expect(generated.content).toEqual([
      expect.objectContaining({ text: expect.not.stringContaining("unsigned_urls") }),
    ])
    expect((generated._meta?.["pippit/media"] as unknown[] | undefined)).toEqual([
      expect.objectContaining({ index: 0, kind: "video", url: expect.stringContaining("/media?token=") }),
    ])

    const edited = await client.callTool({
      arguments: {
        annotations: [
          {
            at_ms: 51_000,
            instruction: "Turn the product matte black",
            region: { height: 0.4, width: 0.3, x: 0.2, y: 0.1 },
          },
        ],
        byok_id: "credential_1",
        idempotency_key: "edit_retry_1",
        model: "pippit/test",
        prompt: "Preserve the camera movement",
        resolution: "1080p",
        seed: 7,
        segment: { end_ms: 60_000, start_ms: 45_000 },
        source_index: 0,
        source_job_id: "job_123",
        thread_id: "thread_1",
      },
      name: CHATGPT_TOOL_NAMES.edit,
    })
    expect(calls.at(-1)).toEqual({
      args: {
        annotations: [
          {
            at_ms: 51_000,
            instruction: "Turn the product matte black",
            region: { height: 0.4, width: 0.3, x: 0.2, y: 0.1 },
          },
        ],
        byok_id: "credential_1",
        idempotency_key: "edit_retry_1",
        model: "pippit/test",
        prompt: "Preserve the camera movement",
        resolution: "1080p",
        seed: 7,
        segment: { end_ms: 60_000, start_ms: 45_000 },
        source_index: 0,
        source_job_id: "job_123",
        thread_id: "thread_1",
      },
      name: "pippit_edit_video_segment",
    })
    expect(edited.structuredContent).not.toHaveProperty("unsigned_urls")
    expect((edited._meta?.["pippit/media"] as unknown[] | undefined)).toHaveLength(1)
  })

  it("validates edit duration, region bounds, and instruction presence", () => {
    const base = {
      annotations: [],
      idempotency_key: "edit_1",
      model: "pippit/test",
      prompt: "Keep the subject centered",
      segment: { end_ms: 60_000, start_ms: 45_000 },
      source_job_id: "job_123",
    }
    expect(chatGptEditInputSchema.parse(base)).toMatchObject({ source_index: 0 })
    expect(
      chatGptEditInputSchema.safeParse({
        ...base,
        segment: { end_ms: 75_001, start_ms: 45_000 },
      }).success,
    ).toBe(false)
    expect(
      chatGptEditInputSchema.safeParse({
        ...base,
        annotations: [
          {
            at_ms: 50_000,
            instruction: "Change this area",
            region: { height: 0.5, width: 0.3, x: 0.8, y: 0.1 },
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      chatGptEditInputSchema.safeParse({
        ...base,
        annotations: [
          {
            at_ms: 50_000,
            instruction: "x".repeat(2_001),
            region: { height: 0.5, width: 0.3, x: 0.2, y: 0.1 },
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      chatGptEditInputSchema.safeParse({
        ...base,
        annotations: [],
        prompt: undefined,
      }).success,
    ).toBe(false)
  })
})
