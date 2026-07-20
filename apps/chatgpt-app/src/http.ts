import { Readable } from "node:stream"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"

import {
  type ChatGptAppDependencies,
  type PippitFacadeClientLike,
  createChatGptAppMcpServer,
  createChatGptAppRuntime,
} from "./app.js"
import {
  type ChatGptAppConfig,
  mediaPreviewsEnabled,
} from "./config.js"
import { createMediaTokenSigner } from "./media-token.js"

const MAX_MCP_BODY_BYTES = 1024 * 1024
const FORWARDED_MEDIA_HEADERS = [
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
] as const

type RangeDownloadClient = PippitFacadeClientLike

export interface ChatGptHttpServerOptions {
  readonly config: ChatGptAppConfig
  readonly dependencies?: ChatGptAppDependencies
}

function canonicalHostname(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/u, "")
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized
}

function requestHost(value: string | undefined): { readonly hostname: string; readonly origin: string } | undefined {
  if (value === undefined || value.trim() === "") return undefined
  try {
    const url = new URL(`http://${value}`)
    if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      return undefined
    }
    return { hostname: canonicalHostname(url.hostname), origin: url.origin }
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
}

function isAllowedMcpRequestSource(request: IncomingMessage, config: ChatGptAppConfig): boolean {
  const host = requestHost(request.headers.host)
  if (host === undefined) return false
  const configuredHost = canonicalHostname(config.host)
  const publicUrl = config.publicBaseUrl === undefined ? undefined : new URL(config.publicBaseUrl)
  const publicHostname = publicUrl === undefined ? undefined : canonicalHostname(publicUrl.hostname)
  const concreteConfiguredHost = configuredHost !== "0.0.0.0" && configuredHost !== "::"
  const loopbackHostAllowed = isLoopbackHostname(configuredHost) && isLoopbackHostname(host.hostname)
  if (
    !loopbackHostAllowed &&
    host.hostname !== publicHostname &&
    !(concreteConfiguredHost && host.hostname === configuredHost)
  ) {
    return false
  }

  const originHeader = request.headers.origin
  if (originHeader === undefined) return true
  let origin: URL
  try {
    origin = new URL(originHeader)
  } catch {
    return false
  }
  if (origin.username !== "" || origin.password !== "" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
    return false
  }
  if (publicUrl !== undefined && origin.origin === publicUrl.origin) return true
  return isLoopbackHostname(host.hostname) && origin.origin === host.origin
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  const value = JSON.stringify(body)
  response.statusCode = statusCode
  response.setHeader("content-type", "application/json; charset=utf-8")
  response.setHeader("content-length", Buffer.byteLength(value))
  response.setHeader("cache-control", "no-store")
  response.end(value)
}

async function parseJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    totalBytes += buffer.byteLength
    if (totalBytes > MAX_MCP_BODY_BYTES) throw new Error("MCP request body is too large.")
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
}

async function handleMcp(
  request: IncomingMessage,
  response: ServerResponse,
  config: ChatGptAppConfig,
  dependencies: ChatGptAppDependencies,
): Promise<void> {
  let body: unknown
  try {
    body = await parseJsonBody(request)
  } catch (error) {
    json(response, 400, {
      error: error instanceof Error ? error.message : "Invalid JSON request body.",
    })
    return
  }

  const { server } = createChatGptAppMcpServer({ config, dependencies })
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  })
  const close = (): void => {
    void transport.close().catch(() => undefined)
    void server.close().catch(() => undefined)
  }
  response.once("close", close)
  try {
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0])
    await transport.handleRequest(request, response, body)
  } catch {
    if (!response.headersSent) {
      json(response, 500, {
        error: { code: -32603, message: "Internal MCP server error." },
        id: null,
        jsonrpc: "2.0",
      })
    } else if (!response.writableEnded) {
      response.end()
    }
  }
}

async function handleMedia(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  config: ChatGptAppConfig,
  client: RangeDownloadClient,
): Promise<void> {
  if (!mediaPreviewsEnabled(config)) {
    json(response, 404, { error: "Media previews are disabled." })
    return
  }
  const token = url.searchParams.get("token")
  if (token === null || token === "") {
    json(response, 400, { error: "A media token is required." })
    return
  }
  const signer = createMediaTokenSigner({
    keyHex: config.mediaSigningKeyHex,
    ttlSeconds: config.mediaTtlSeconds,
  })
  let payload
  try {
    payload = signer.verify(token)
  } catch {
    json(response, 401, { error: "The media token is invalid or expired." })
    return
  }

  const controller = new AbortController()
  const abort = (): void => controller.abort()
  request.once("aborted", abort)
  response.once("close", abort)
  let upstream: Response
  try {
    upstream = await client.downloadVideo(payload.jobId, {
      index: payload.index,
      ...(request.headers.range === undefined ? {} : { range: request.headers.range }),
      signal: controller.signal,
    })
  } catch {
    json(response, 502, { error: "The facade media request failed." })
    return
  } finally {
    request.removeListener("aborted", abort)
  }

  if ((upstream.status !== 200 && upstream.status !== 206) || upstream.body === null) {
    await upstream.body?.cancel().catch(() => undefined)
    json(response, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502, {
      error: "The facade did not return playable video content.",
    })
    return
  }

  const mediaType = upstream.headers.get("content-type")
  const playableMediaType = mediaType !== null && mediaType.toLowerCase().startsWith("video/")
    ? mediaType
    : mediaType === null || mediaType.toLowerCase() === "application/octet-stream"
      ? "video/mp4"
      : undefined
  if (playableMediaType === undefined) {
    await upstream.body.cancel().catch(() => undefined)
    json(response, 502, { error: "The facade did not return a supported video media type." })
    return
  }

  response.statusCode = upstream.status
  for (const header of FORWARDED_MEDIA_HEADERS) {
    const value = upstream.headers.get(header)
    if (value !== null) response.setHeader(header, value)
  }
  response.setHeader("content-type", playableMediaType)
  response.setHeader("access-control-allow-origin", "*")
  response.setHeader("cache-control", `private, max-age=${Math.max(0, payload.expiresAt - Math.floor(Date.now() / 1000))}`)
  response.setHeader("cross-origin-resource-policy", "cross-origin")
  response.setHeader("x-content-type-options", "nosniff")

  const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>)
  stream.once("error", () => {
    if (!response.writableEnded) response.destroy()
  })
  stream.pipe(response)
}

export function createChatGptHttpServer(options: ChatGptHttpServerOptions): Server {
  const { config } = options
  if (!isLoopbackHostname(canonicalHostname(config.host))) {
    throw new Error("The current noauth ChatGPT App can listen only on a loopback host.")
  }
  const appRuntime = createChatGptAppRuntime(config, options.dependencies)
  const dependencies: ChatGptAppDependencies = {
    client: appRuntime.client,
    lineage: appRuntime.lineage,
    runtime: appRuntime.runtime,
  }

  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://chatgpt-app.local")
      if (url.pathname === "/health") {
        if (request.method !== "GET") {
          response.setHeader("allow", "GET")
          json(response, 405, { error: "Method not allowed." })
          return
        }
        json(response, 200, {
          media_previews: mediaPreviewsEnabled(config),
          service: "@pippit-bridge/chatgpt-app",
          status: "ok",
        })
        return
      }
      if (url.pathname === "/mcp") {
        if (request.method !== "POST") {
          response.setHeader("allow", "POST")
          json(response, 405, { error: "Method not allowed." })
          return
        }
        if (!isAllowedMcpRequestSource(request, config)) {
          json(response, 403, { error: "The MCP request Host or Origin is not allowed." })
          return
        }
        await handleMcp(request, response, config, dependencies)
        return
      }
      if (url.pathname === "/media") {
        if (request.method !== "GET") {
          response.setHeader("allow", "GET")
          json(response, 405, { error: "Method not allowed." })
          return
        }
        await handleMedia(request, response, url, config, appRuntime.client as RangeDownloadClient)
        return
      }
      json(response, 404, { error: "Not found." })
    })().catch(() => {
      if (!response.headersSent) json(response, 500, { error: "Internal server error." })
      else if (!response.writableEnded) response.end()
    })
  })
}
