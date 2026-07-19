import { createHash, randomBytes } from "node:crypto"
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
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

import type { PippitVideoDownloadOptions } from "./contracts.ts"
import type { PippitMcpResourceProvider } from "./protocol.ts"
import {
  pippitWidgetListResources,
  pippitWidgetReadResource,
} from "./widget-protocol.ts"

const DEFAULT_MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024
const DEFAULT_MAX_INLINE_PREVIEW_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_RESOURCE_CHUNK_BYTES = 1024 * 1024
const ARTIFACT_ID_PATTERN = /^[a-f0-9]{64}$/u
const ARTIFACT_RESOURCE_HOST = "artifact"
const ARTIFACT_RESOURCE_PROTOCOL = "pippit-video:"

export interface PippitWidgetMediaBackend {
  downloadVideo(jobId: string, options?: PippitVideoDownloadOptions): Promise<Response>
}

export interface PippitWidgetMediaServer extends PippitMcpResourceProvider {
  close(): Promise<void>
  preparePreview(jobId: string, index: number): Promise<PippitPreparedWidgetMedia>
}

export interface PippitPreparedWidgetMedia {
  readonly bytes: number
  readonly filename: string
  readonly localPath: string
  readonly resourceUri: string
}

export interface PippitWidgetMediaServerOptions {
  readonly artifactRoot: string | (() => Promise<string>)
  readonly backend: PippitWidgetMediaBackend
  readonly maxArtifactBytes?: number
  readonly maxInlinePreviewBytes?: number
  readonly maxResourceChunkBytes?: number
}

interface CachedArtifact {
  readonly artifactId: string
  readonly filename: string
  readonly path: string
  readonly size: number
}

interface ArtifactResourceRequest {
  readonly artifactId: string
  readonly length: number
  readonly offset: number
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

function artifactResourceUri(id: string): string {
  return `${ARTIFACT_RESOURCE_PROTOCOL}//${ARTIFACT_RESOURCE_HOST}/${id}`
}

function parseArtifactResourceUri(uri: string, maxChunkBytes: number): ArtifactResourceRequest | undefined {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return undefined
  }
  if (
    parsed.protocol !== ARTIFACT_RESOURCE_PROTOCOL ||
    parsed.hostname !== ARTIFACT_RESOURCE_HOST ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) return undefined
  const resourceArtifactId = parsed.pathname.slice(1)
  if (
    !ARTIFACT_ID_PATTERN.test(resourceArtifactId) ||
    parsed.pathname !== `/${resourceArtifactId}`
  ) return undefined
  const keys = [...parsed.searchParams.keys()]
  if (
    keys.length !== 2 ||
    new Set(keys).size !== 2 ||
    !keys.includes("length") ||
    !keys.includes("offset")
  ) return undefined
  const length = Number(parsed.searchParams.get("length"))
  const offset = Number(parsed.searchParams.get("offset"))
  if (
    !Number.isSafeInteger(length) ||
    !Number.isSafeInteger(offset) ||
    length < 1 ||
    length > maxChunkBytes ||
    offset < 0
  ) return undefined
  return { artifactId: resourceArtifactId, length, offset }
}

async function readArtifactResource(
  uri: string,
  resolveRoot: () => Promise<string>,
  maxReadableBytes: number,
  maxChunkBytes: number,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const request = parseArtifactResourceUri(uri, maxChunkBytes)
  if (request === undefined) return undefined
  const root = await resolveRoot()
  let handle: FileHandle
  try {
    handle = await open(artifactPath(root, request.artifactId), constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  try {
    const stats = await handle.stat()
    if (
      !stats.isFile() ||
      stats.size <= 0 ||
      stats.size > maxReadableBytes ||
      (process.platform !== "win32" && (stats.mode & 0o077) !== 0)
    ) {
      throw new Error("The local Pippit video artifact is unsafe.")
    }
    if (request.offset >= stats.size) return undefined
    const requestedBytes = Math.min(request.length, stats.size - request.offset)
    const buffer = Buffer.allocUnsafe(requestedBytes)
    let bytesRead = 0
    while (bytesRead < requestedBytes) {
      const next = await handle.read(
        buffer,
        bytesRead,
        requestedBytes - bytesRead,
        request.offset + bytesRead,
      )
      if (next.bytesRead === 0) {
        throw new Error("The local Pippit video artifact changed while being read.")
      }
      bytesRead += next.bytesRead
    }
    return {
      contents: [
        {
          _meta: {
            "pippit/chunk": {
              bytes: bytesRead,
              complete: request.offset + bytesRead === stats.size,
              offset: request.offset,
              total_bytes: stats.size,
            },
          },
          blob: buffer.toString("base64"),
          mimeType: "video/mp4",
          uri,
        },
      ],
    }
  } finally {
    await handle.close()
  }
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

export function createPippitWidgetMediaServer(
  options: PippitWidgetMediaServerOptions,
): PippitWidgetMediaServer {
  const maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES
  const maxInlinePreviewBytes = options.maxInlinePreviewBytes ?? Math.min(
    DEFAULT_MAX_INLINE_PREVIEW_BYTES,
    maxArtifactBytes,
  )
  const maxResourceChunkBytes = options.maxResourceChunkBytes ?? DEFAULT_MAX_RESOURCE_CHUNK_BYTES
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1) {
    throw new Error("Widget media artifact limit must be a positive integer.")
  }
  if (!Number.isSafeInteger(maxResourceChunkBytes) || maxResourceChunkBytes < 1) {
    throw new Error("Widget media resource chunk limit must be a positive integer.")
  }
  if (
    !Number.isSafeInteger(maxInlinePreviewBytes) ||
    maxInlinePreviewBytes < 1 ||
    maxInlinePreviewBytes > maxArtifactBytes
  ) {
    throw new Error("Widget inline preview limit must be a positive integer no larger than the artifact limit.")
  }
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

  const preparePreview = async (jobId: string, index: number): Promise<PippitPreparedWidgetMedia> => {
    const cached = await ensureArtifact(jobId, index)
    return {
      bytes: cached.size,
      filename: cached.filename,
      localPath: cached.path,
      resourceUri: artifactResourceUri(cached.artifactId),
    }
  }

  return {
    async close() {
      closed = true
      closePromise ??= (async () => {
        for (const controller of downloadControllers) controller.abort()
        await Promise.allSettled(downloads.values())
      })()
      await closePromise
    },
    async listResources() {
      return pippitWidgetListResources()
    },
    async listResourceTemplates() {
      return {
        resourceTemplates: [
          {
            description: "Read a bounded chunk from a private local Pippit MP4 artifact.",
            mimeType: "video/mp4",
            name: "Pippit local video chunk",
            uriTemplate: "pippit-video://artifact/{artifact_id}{?length,offset}",
          },
        ],
      }
    },
    preparePreview,
    async readResource(uri) {
      if (closed) throw new Error("The widget media server is closed.")
      const widgetResource = pippitWidgetReadResource(uri)
      if (widgetResource !== undefined) return widgetResource
      return await readArtifactResource(
        uri,
        resolveArtifactRoot,
        maxInlinePreviewBytes,
        maxResourceChunkBytes,
      )
    },
  }
}
