import type { AddressInfo } from "node:net"
import { request as httpRequest, type Server } from "node:http"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  CHATGPT_TOOL_NAMES,
  type PippitFacadeClientLike,
  type PippitToolRuntimeLike,
} from "../src/app.js"
import type { ChatGptAppConfig } from "../src/config.js"
import { createChatGptHttpServer } from "../src/http.js"
import { createMediaTokenSigner } from "../src/media-token.js"

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)))
        }),
    ),
  )
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function postMcpWithHost(baseUrl: string, host: string): Promise<number> {
  const body = JSON.stringify({ id: 4, jsonrpc: "2.0", method: "tools/list", params: {} })
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${baseUrl}/mcp`, {
      headers: {
        accept: "application/json, text/event-stream",
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json",
        host,
      },
      method: "POST",
    }, (response) => {
      response.resume()
      response.once("end", () => resolve(response.statusCode ?? 0))
    })
    request.once("error", reject)
    request.end(body)
  })
}

function config(previews = false): ChatGptAppConfig {
  return {
    facadeApiKey: "facade-secret",
    facadeBaseUrl: "http://127.0.0.1:3000",
    facadeTimeoutMs: 120_000,
    host: "127.0.0.1",
    ...(previews
      ? { mediaSigningKeyHex: "b".repeat(64), publicBaseUrl: "https://apps.example.test" }
      : {}),
    mediaTtlSeconds: 300,
    port: 8787,
  }
}

function runtime(): PippitToolRuntimeLike {
  return {
    async callTool() {
      return { content: [{ type: "text", text: "ok" }], structuredContent: { data: [] } }
    },
  }
}

describe("ChatGPT App HTTP server", () => {
  it("serves health and enforces the stateless MCP method", async () => {
    const client: PippitFacadeClientLike = { async downloadVideo() { return new Response() } }
    const baseUrl = await listen(
      createChatGptHttpServer({ config: config(), dependencies: { client, runtime: runtime() } }),
    )
    const health = await fetch(`${baseUrl}/health`)
    expect(await health.json()).toEqual({
      media_previews: false,
      service: "@pippit-bridge/chatgpt-app",
      status: "ok",
    })
    const mcpGet = await fetch(`${baseUrl}/mcp`)
    expect(mcpGet.status).toBe(405)
    expect(mcpGet.headers.get("allow")).toBe("POST")

    const initialized = await fetch(`${baseUrl}/mcp`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "http-test", version: "1.0.0" },
          protocolVersion: "2025-06-18",
        },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      method: "POST",
    })
    expect(initialized.status).toBe(200)
    expect(await initialized.json()).toMatchObject({
      id: 1,
      jsonrpc: "2.0",
      result: { serverInfo: { name: "pippit-chatgpt-app", version: "0.2.11" } },
    })

    const toolsResponse = await fetch(`${baseUrl}/mcp`, {
      body: JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list", params: {} }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      method: "POST",
    })
    expect(toolsResponse.status).toBe(200)
    const toolsBody = await toolsResponse.json() as {
      result?: { tools?: Array<{ _meta?: Record<string, unknown>; name?: string; securitySchemes?: unknown }> }
    }
    expect(toolsBody.result?.tools?.map((tool) => tool.name)).toEqual(Object.values(CHATGPT_TOOL_NAMES))
    for (const tool of toolsBody.result?.tools ?? []) {
      expect(tool.securitySchemes).toEqual([{ type: "noauth" }])
      expect(tool._meta?.securitySchemes).toEqual([{ type: "noauth" }])
    }

    const attackerOrigin = await fetch(`${baseUrl}/mcp`, {
      body: JSON.stringify({ id: 3, jsonrpc: "2.0", method: "tools/list", params: {} }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        origin: "https://attacker.example.test",
      },
      method: "POST",
    })
    expect(attackerOrigin.status).toBe(403)

    await expect(postMcpWithHost(baseUrl, "attacker.example.test")).resolves.toBe(403)

    expect(() =>
      createChatGptHttpServer({
        config: { ...config(), host: "0.0.0.0" },
        dependencies: { client, runtime: runtime() },
      }),
    ).toThrow("can listen only on a loopback host")
  })

  it("verifies media tokens, forwards Range, and reflects partial-content headers", async () => {
    const downloadVideo = vi.fn(async () =>
      new Response(Uint8Array.from([1, 2, 3]), {
        headers: {
          "accept-ranges": "bytes",
          "content-length": "3",
          "content-range": "bytes 2-4/9",
          "content-type": "video/mp4",
        },
        status: 206,
      }),
    )
    const previewConfig = config(true)
    const client: PippitFacadeClientLike = { downloadVideo }
    const baseUrl = await listen(
      createChatGptHttpServer({
        config: previewConfig,
        dependencies: { client, runtime: runtime() },
      }),
    )
    const signer = createMediaTokenSigner({
      keyHex: previewConfig.mediaSigningKeyHex ?? "",
      ttlSeconds: previewConfig.mediaTtlSeconds,
    })
    const response = await fetch(`${baseUrl}/media?token=${encodeURIComponent(signer.issue("job_123", 1))}`, {
      headers: { range: "bytes=2-4" },
    })
    expect(response.status).toBe(206)
    expect(response.headers.get("content-range")).toBe("bytes 2-4/9")
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(response.headers.get("content-type")).toBe("video/mp4")
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3]))
    expect(downloadVideo).toHaveBeenCalledWith(
      "job_123",
      expect.objectContaining({ index: 1, range: "bytes=2-4", signal: expect.any(AbortSignal) }),
    )

    const tampered = await fetch(`${baseUrl}/media?token=bad.token`)
    expect(tampered.status).toBe(401)
    const mediaPost = await fetch(`${baseUrl}/media?token=x`, { method: "POST" })
    expect(mediaPost.status).toBe(405)
  })

  it("rejects an unexpected upstream media type instead of relabeling it", async () => {
    const previewConfig = config(true)
    const baseUrl = await listen(createChatGptHttpServer({
      config: previewConfig,
      dependencies: {
        client: {
          async downloadVideo() {
            return new Response("not video", { headers: { "content-type": "text/html" } })
          },
        },
        runtime: runtime(),
      },
    }))
    const signer = createMediaTokenSigner({
      keyHex: previewConfig.mediaSigningKeyHex ?? "",
      ttlSeconds: previewConfig.mediaTtlSeconds,
    })
    const response = await fetch(`${baseUrl}/media?token=${encodeURIComponent(signer.issue("job_123"))}`)
    expect(response.status).toBe(502)
    expect(response.headers.get("content-type")).toContain("application/json")
  })
})
