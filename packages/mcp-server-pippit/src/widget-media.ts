import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  unlink,
  type FileHandle,
} from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

import type { PippitVideoDownloadOptions } from "./contracts.ts"
import type { PippitMcpResourceProvider } from "./protocol.ts"
import {
  pippitWidgetListResources,
  pippitWidgetReadResource,
} from "./widget-protocol.ts"

const DEFAULT_MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024
const ARTIFACT_ID_PATTERN = /^[a-f0-9]{64}$/u

export interface PippitWidgetMediaBackend {
  downloadVideo(jobId: string, options?: PippitVideoDownloadOptions): Promise<Response>
}

export interface PippitWidgetMediaServer extends PippitMcpResourceProvider {
  close(): Promise<void>
  preparePreview(jobId: string, index: number): Promise<PippitPreparedWidgetMedia>
  previewUrl(jobId: string, index: number): Promise<string>
}

export interface PippitPreparedWidgetMedia {
  readonly bytes: number
  readonly filename: string
  readonly localPath: string
  readonly url: string
}

export interface PippitWidgetMediaServerOptions {
  readonly artifactRoot: string | (() => Promise<string>)
  readonly backend: PippitWidgetMediaBackend
  readonly maxArtifactBytes?: number
  readonly now?: () => number
  readonly signingKey?: Uint8Array
}

export interface PippitWidgetMediaRequestOptions {
  readonly artifactRoot: string
  readonly expectedOrigin: string
  readonly now?: () => number
  readonly signingKey: Uint8Array
}

interface MediaTokenPayload {
  readonly artifactId: string
  readonly expiresAt?: number
  readonly nonce?: string
  readonly version?: 2
}

interface CachedArtifact {
  readonly artifactId: string
  readonly filename: string
  readonly path: string
  readonly size: number
}

interface ByteRange {
  readonly end: number
  readonly start: number
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  const value = JSON.stringify(body)
  response.statusCode = statusCode
  response.setHeader("access-control-allow-origin", "*")
  response.setHeader("access-control-allow-private-network", "true")
  response.setHeader("access-control-expose-headers", "accept-ranges, content-length, content-range")
  response.setHeader("cache-control", "no-store")
  response.setHeader("content-length", Buffer.byteLength(value))
  response.setHeader("content-type", "application/json; charset=utf-8")
  response.setHeader("vary", "Access-Control-Request-Headers, Access-Control-Request-Method, Access-Control-Request-Private-Network, Origin")
  response.end(value)
}

function tokenSignature(key: Uint8Array, encodedPayload: string): Buffer {
  return createHmac("sha256", key).update(encodedPayload).digest()
}

function decodeToken(key: Uint8Array, token: string, now: () => number): MediaTokenPayload {
  const separator = token.lastIndexOf(".")
  if (separator <= 0 || separator === token.length - 1) throw new Error("invalid token")
  const encodedPayload = token.slice(0, separator)
  const suppliedSignature = Buffer.from(token.slice(separator + 1), "base64url")
  const expectedSignature = tokenSignature(key, encodedPayload)
  if (
    suppliedSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new Error("invalid token")
  }
  const parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as unknown
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid token")
  const payload = parsed as Record<string, unknown>
  if (typeof payload.artifactId !== "string" || !ARTIFACT_ID_PATTERN.test(payload.artifactId)) {
    throw new Error("invalid token")
  }
  if (payload.version === 2) {
    if (payload.expiresAt !== undefined || payload.nonce !== undefined) throw new Error("invalid token")
    return { artifactId: payload.artifactId, version: 2 }
  }
  if (
    typeof payload.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{16}$/u.test(payload.nonce) ||
    typeof payload.expiresAt !== "number" ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= Math.floor(now() / 1_000)
  ) throw new Error("invalid token")
  return {
    artifactId: payload.artifactId,
    expiresAt: payload.expiresAt,
    nonce: payload.nonce,
  }
}

function playableContentType(value: string | null): boolean {
  if (value === null) return true
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase()
  return normalized === "application/octet-stream" || normalized === "video/mp4"
}

function artifactId(jobId: string, index: number): string {
  return createHash("sha256").update("pippit-media-artifact\0", "utf8").update(jobId, "utf8")
    .update("\0", "utf8").update(String(index), "utf8").digest("hex")
}

function artifactPath(root: string, id: string): string {
  return join(root, `pippit-video-${id}.mp4`)
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  let existed = true
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    existed = false
    await mkdir(path, { mode: 0o700, recursive: true })
  }
  let stats = await lstat(path)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("The Pippit media artifact directory is unsafe.")
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("The Pippit media artifact directory must be owned by the current user.")
  }
  if (!existed && process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    await chmod(path, 0o700)
    stats = await lstat(path)
  }
  if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) {
    throw new Error("The Pippit media artifact directory must not be writable by group or other users.")
  }
}

async function existingArtifact(path: string, id: string): Promise<CachedArtifact | undefined> {
  try {
    const stats = await lstat(path)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
      throw new Error("The cached Pippit media artifact is unsafe.")
    }
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new Error("The cached Pippit media artifact is not private.")
    }
    return { artifactId: id, filename: basename(path), path, size: stats.size }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function declaredContentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length")
  if (value === null) return undefined
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("Pippit returned an invalid media length.")
  return length
}

async function downloadArtifact(input: {
  readonly backend: PippitWidgetMediaBackend
  readonly closed: () => boolean
  readonly controllers: Set<AbortController>
  readonly id: string
  readonly index: number
  readonly jobId: string
  readonly maxBytes: number
  readonly path: string
}): Promise<CachedArtifact> {
  await ensurePrivateDirectory(dirname(input.path))
  const present = await existingArtifact(input.path, input.id)
  if (present !== undefined) return present

  const controller = new AbortController()
  input.controllers.add(controller)
  const temporaryPath = `${input.path}.partial-${process.pid}-${randomBytes(8).toString("hex")}`
  let handle: FileHandle | undefined
  let upstream: Response | undefined
  try {
    if (input.closed()) throw new Error("The widget media server is closed.")
    upstream = await input.backend.downloadVideo(input.jobId, {
      index: input.index,
      signal: controller.signal,
    })
    if (upstream.status !== 200 || upstream.body === null) {
      await upstream.body?.cancel().catch(() => undefined)
      throw new Error("Pippit did not return a complete video artifact.")
    }
    if (!playableContentType(upstream.headers.get("content-type"))) {
      await upstream.body.cancel().catch(() => undefined)
      throw new Error("Pippit did not return an MP4 video artifact.")
    }
    const expectedBytes = declaredContentLength(upstream)
    if (expectedBytes !== undefined && expectedBytes > input.maxBytes) {
      await upstream.body.cancel().catch(() => undefined)
      throw new Error("The Pippit video artifact exceeds the local preview limit.")
    }

    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    const reader = upstream.body.getReader()
    let written = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (input.closed()) {
          controller.abort()
          throw new Error("The widget media server is closed.")
        }
        written += chunk.value.byteLength
        if (written > input.maxBytes) {
          controller.abort()
          throw new Error("The Pippit video artifact exceeds the local preview limit.")
        }
        await handle.writeFile(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
    if (written === 0 || (expectedBytes !== undefined && written !== expectedBytes)) {
      throw new Error("The Pippit video artifact download was incomplete.")
    }
    await handle.sync()
    await handle.close()
    handle = undefined

    try {
      await link(temporaryPath, input.path)
      await syncDirectory(dirname(input.path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    await unlink(temporaryPath)
    const cached = await existingArtifact(input.path, input.id)
    if (cached === undefined) throw new Error("The Pippit media artifact could not be committed.")
    return cached
  } finally {
    controller.abort()
    input.controllers.delete(controller)
    await upstream?.body?.cancel().catch(() => undefined)
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
  }
}

function parseRange(value: string | undefined, size: number): ByteRange | undefined | null {
  if (value === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim())
  if (match === null || (match[1] === "" && match[2] === "")) return null
  if (match[1] === "") {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    return { end: size - 1, start: Math.max(0, size - suffix) }
  }
  const start = Number(match[1])
  const requestedEnd = match[2] === "" ? size - 1 : Number(match[2])
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return null
  }
  return { end: Math.min(size - 1, requestedEnd), start }
}

async function serveArtifact(
  request: IncomingMessage,
  response: ServerResponse,
  payload: MediaTokenPayload,
  root: string,
  now: () => number,
): Promise<void> {
  const path = artifactPath(root, payload.artifactId)
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const status = (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500
    json(response, status, { error: status === 404 ? "The local video artifact was not found." : "The local video artifact is unavailable." })
    return
  }

  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size <= 0 || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
      json(response, 500, { error: "The local video artifact is unsafe." })
      return
    }
    const range = parseRange(request.headers.range, stats.size)
    if (range === null) {
      response.statusCode = 416
      response.setHeader("accept-ranges", "bytes")
      response.setHeader("access-control-allow-origin", "*")
      response.setHeader("access-control-allow-private-network", "true")
      response.setHeader("access-control-expose-headers", "accept-ranges, content-length, content-range")
      response.setHeader("cache-control", "no-store")
      response.setHeader("content-range", `bytes */${stats.size}`)
      response.setHeader("vary", "Access-Control-Request-Headers, Access-Control-Request-Method, Access-Control-Request-Private-Network, Origin")
      response.end()
      return
    }
    const start = range?.start ?? 0
    const end = range?.end ?? stats.size - 1
    const contentLength = end - start + 1
    response.statusCode = range === undefined ? 200 : 206
    response.setHeader("accept-ranges", "bytes")
    response.setHeader("access-control-allow-origin", "*")
    response.setHeader("access-control-allow-private-network", "true")
    response.setHeader("access-control-expose-headers", "accept-ranges, content-length, content-range")
    response.setHeader(
      "cache-control",
      payload.version === 2
        ? "private, no-store"
        : `private, max-age=${Math.max(0, (payload.expiresAt ?? 0) - Math.floor(now() / 1_000))}`,
    )
    response.setHeader("content-length", contentLength)
    response.setHeader("content-type", "video/mp4")
    response.setHeader("cross-origin-resource-policy", "cross-origin")
    response.setHeader("timing-allow-origin", "*")
    response.setHeader("vary", "Access-Control-Request-Headers, Access-Control-Request-Method, Access-Control-Request-Private-Network, Origin")
    response.setHeader("x-content-type-options", "nosniff")
    if (range !== undefined) response.setHeader("content-range", `bytes ${start}-${end}/${stats.size}`)
    if (request.method === "HEAD") {
      response.end()
      return
    }
    const stream = handle.createReadStream({ autoClose: false, end, start })
    stream.once("error", () => {
      if (!response.writableEnded) response.destroy()
    })
    response.once("close", () => stream.destroy())
    await new Promise<void>((resolveStream) => {
      stream.once("close", resolveStream)
      stream.pipe(response)
    })
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function handlePippitWidgetMediaRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: PippitWidgetMediaRequestOptions,
): Promise<void> {
  const now = options.now ?? Date.now
  let expectedOrigin: URL
  try {
    expectedOrigin = new URL(options.expectedOrigin)
  } catch {
    json(response, 500, { error: "The media server origin is invalid." })
    return
  }
  if (
    expectedOrigin.protocol !== "http:" ||
    expectedOrigin.hostname !== "127.0.0.1" ||
    expectedOrigin.username !== "" ||
    expectedOrigin.password !== "" ||
    expectedOrigin.pathname !== "/" ||
    expectedOrigin.search !== "" ||
    expectedOrigin.hash !== "" ||
    request.headers.host !== expectedOrigin.host
  ) {
    json(response, 403, { error: "The media request Host is not allowed." })
    return
  }
  if (request.method === "OPTIONS") {
    response.statusCode = 204
    response.setHeader("access-control-allow-headers", "range")
    response.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS")
    response.setHeader("access-control-allow-origin", "*")
    response.setHeader("access-control-allow-private-network", "true")
    response.setHeader("access-control-expose-headers", "accept-ranges, content-length, content-range")
    response.setHeader("cache-control", "no-store")
    response.setHeader("vary", "Access-Control-Request-Headers, Access-Control-Request-Method, Access-Control-Request-Private-Network, Origin")
    response.end()
    return
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD, OPTIONS")
    json(response, 405, { error: "Method not allowed." })
    return
  }
  const url = new URL(request.url ?? "/", expectedOrigin)
  if (url.pathname !== "/media") {
    json(response, 404, { error: "Not found." })
    return
  }
  const token = url.searchParams.get("token")
  if (token === null || token === "") {
    json(response, 400, { error: "A media token is required." })
    return
  }
  let payload: MediaTokenPayload
  try {
    payload = decodeToken(options.signingKey, token, now)
  } catch {
    json(response, 401, { error: "The media token is invalid or expired." })
    return
  }
  await serveArtifact(request, response, payload, options.artifactRoot, now)
}

export function createPippitWidgetMediaServer(
  options: PippitWidgetMediaServerOptions,
): PippitWidgetMediaServer {
  const now = options.now ?? Date.now
  const maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1) {
    throw new Error("Widget media artifact limit must be a positive integer.")
  }
  const signingKey = options.signingKey ?? randomBytes(32)
  if (signingKey.byteLength < 32) throw new Error("Widget media signing key must contain at least 32 bytes.")

  let origin: string | undefined
  let server: Server | undefined
  let startPromise: Promise<string> | undefined
  let rootPromise: Promise<string> | undefined
  let closePromise: Promise<void> | undefined
  let closed = false
  const downloads = new Map<string, Promise<CachedArtifact>>()
  const downloadControllers = new Set<AbortController>()

  const resolveArtifactRoot = async (): Promise<string> => {
    rootPromise ??= (async () => {
      const configured = typeof options.artifactRoot === "string"
        ? options.artifactRoot
        : await options.artifactRoot()
      if (!isAbsolute(configured)) throw new Error("Widget media artifact root must be absolute.")
      const root = resolve(configured)
      await ensurePrivateDirectory(root)
      return root
    })().catch((error: unknown) => {
      rootPromise = undefined
      throw error
    })
    return await rootPromise
  }

  const ensureArtifact = async (jobId: string, index: number): Promise<CachedArtifact> => {
    if (closed) throw new Error("The widget media server is closed.")
    if (jobId === "" || !Number.isSafeInteger(index) || index < 0) {
      throw new Error("Widget media identity is invalid.")
    }
    const root = await resolveArtifactRoot()
    const id = artifactId(jobId, index)
    const path = artifactPath(root, id)
    const present = await existingArtifact(path, id)
    if (present !== undefined) return present
    let active = downloads.get(id)
    if (active === undefined) {
      active = downloadArtifact({
        backend: options.backend,
        closed: () => closed,
        controllers: downloadControllers,
        id,
        index,
        jobId,
        maxBytes: maxArtifactBytes,
        path,
      })
      downloads.set(id, active)
      void active.finally(() => {
        if (downloads.get(id) === active) downloads.delete(id)
      }).catch(() => undefined)
    }
    return await active
  }

  const start = async (): Promise<string> => {
    if (closed) throw new Error("The widget media server is closed.")
    if (origin !== undefined) return origin
    startPromise ??= new Promise<string>((resolveStart, reject) => {
      const listener = createServer((request, response) => {
        void (async () => {
          if (origin === undefined) throw new Error("The media server has not started.")
          await handlePippitWidgetMediaRequest(request, response, {
            artifactRoot: await resolveArtifactRoot(),
            expectedOrigin: origin,
            now,
            signingKey,
          })
        })().catch(() => {
          if (!response.headersSent) json(response, 500, { error: "The media server failed." })
          else if (!response.writableEnded) response.end()
        })
      })
      listener.once("error", reject)
      listener.listen(0, "127.0.0.1", () => {
        listener.removeListener("error", reject)
        const address = listener.address() as AddressInfo
        server = listener
        origin = `http://127.0.0.1:${address.port}`
        listener.unref()
        resolveStart(origin)
      })
    }).catch((error: unknown) => {
      startPromise = undefined
      throw error
    })
    return await startPromise
  }

  const preparePreview = async (jobId: string, index: number): Promise<PippitPreparedWidgetMedia> => {
    const cached = await ensureArtifact(jobId, index)
    const activeOrigin = await start()
    if (closed) throw new Error("The widget media server is closed.")
    const payload: MediaTokenPayload = { artifactId: cached.artifactId, version: 2 }
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
    const signature = tokenSignature(signingKey, encodedPayload).toString("base64url")
    const url = new URL("/media", activeOrigin)
    url.searchParams.set("token", `${encodedPayload}.${signature}`)
    return {
      bytes: cached.size,
      filename: cached.filename,
      localPath: cached.path,
      url: url.toString(),
    }
  }

  return {
    async close() {
      closed = true
      closePromise ??= (async () => {
        for (const controller of downloadControllers) controller.abort()
        await Promise.allSettled(downloads.values())
        await startPromise?.catch(() => undefined)
        const active = server
        server = undefined
        origin = undefined
        if (active === undefined) return
        await new Promise<void>((resolveClose, reject) => {
          active.close((error) => {
            if (error === undefined) resolveClose()
            else reject(error)
          })
          active.closeAllConnections()
        })
      })()
      await closePromise
    },
    async listResources() {
      return pippitWidgetListResources()
    },
    preparePreview,
    async previewUrl(jobId, index) {
      return (await preparePreview(jobId, index)).url
    },
    async readResource(uri) {
      const activeOrigin = await start()
      if (closed) throw new Error("The widget media server is closed.")
      return pippitWidgetReadResource(uri, { origin: activeOrigin })
    },
  }
}
