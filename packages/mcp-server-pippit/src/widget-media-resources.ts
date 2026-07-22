import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"

import {
  IMAGE_MEDIA_TYPES,
  type PippitWidgetImageArtifact,
  type PippitWidgetImageExtension,
  type PippitWidgetMediaChunk,
  type WidgetArtifactResourceRequest,
} from "./widget-media-contracts.ts"

const ARTIFACT_ID_PATTERN = /^[a-f0-9]{64}$/u
const ARTIFACT_RESOURCE_HOST = "artifact"
const ARTIFACT_RESOURCE_PROTOCOL = "pippit-video:"
const IMAGE_ARTIFACT_RESOURCE_PROTOCOL = "pippit-image:"
const execFileAsync = promisify(execFile)

export async function revealFileInSystemManager(path: string): Promise<void> {
  if (process.platform === "darwin") {
    await execFileAsync("open", ["-R", path])
    return
  }
  if (process.platform === "win32") {
    await execFileAsync("explorer.exe", ["/select,", path])
    return
  }
  await execFileAsync("xdg-open", [dirname(path)])
}

export function widgetArtifactId(jobId: string, index: number): string {
  return createHash("sha256").update("pippit-media-artifact\0", "utf8").update(jobId, "utf8")
    .update("\0", "utf8").update(String(index), "utf8").digest("hex")
}

export function widgetArtifactPath(root: string, id: string): string {
  return join(root, `pippit-video-${id}.mp4`)
}

export function widgetArtifactResourceUri(id: string): string {
  return `${ARTIFACT_RESOURCE_PROTOCOL}//${ARTIFACT_RESOURCE_HOST}/${id}`
}

export function parseWidgetArtifactResourceIdentity(uri: string): string | undefined {
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
    parsed.hash !== "" ||
    parsed.search !== ""
  ) return undefined
  const artifactId = parsed.pathname.slice(1)
  if (!ARTIFACT_ID_PATTERN.test(artifactId) || parsed.pathname !== `/${artifactId}`) {
    return undefined
  }
  return artifactId
}

export function widgetImageExtension(mimeType: string): PippitWidgetImageExtension | undefined {
  if (mimeType === "image/jpeg") return "jpg"
  if (mimeType === "image/png") return "png"
  if (mimeType === "image/webp") return "webp"
  return undefined
}

export function widgetImageArtifactPath(
  root: string,
  id: string,
  extension: PippitWidgetImageExtension,
): string {
  return join(root, `pippit-image-${id}.${extension}`)
}

export function widgetImageArtifactResourceUri(
  id: string,
  extension: PippitWidgetImageExtension,
): string {
  return `${IMAGE_ARTIFACT_RESOURCE_PROTOCOL}//${ARTIFACT_RESOURCE_HOST}/${id}.${extension}`
}

function parseImageArtifactResourceUri(uri: string): {
  readonly artifactId: string
  readonly extension: PippitWidgetImageExtension
  readonly mimeType: PippitWidgetImageArtifact["mimeType"]
} | undefined {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return undefined
  }
  if (
    parsed.protocol !== IMAGE_ARTIFACT_RESOURCE_PROTOCOL ||
    parsed.hostname !== ARTIFACT_RESOURCE_HOST ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.search !== ""
  ) return undefined
  const match = /^\/([a-f0-9]{64})\.(jpg|png|webp)$/u.exec(parsed.pathname)
  if (match === null) return undefined
  const artifactId = match[1]
  const extension = match[2] as PippitWidgetImageExtension
  if (artifactId === undefined) return undefined
  return { artifactId, extension, mimeType: IMAGE_MEDIA_TYPES[extension] }
}

function parseArtifactResourceUri(
  uri: string,
  maxChunkBytes: number,
): WidgetArtifactResourceRequest | undefined {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return undefined
  }
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
  parsed.search = ""
  const resourceUri = parsed.toString()
  const artifactId = parseWidgetArtifactResourceIdentity(resourceUri)
  if (artifactId === undefined) return undefined
  return { artifactId, length, offset, resourceUri }
}

export async function readWidgetArtifactChunk(
  request: WidgetArtifactResourceRequest,
  resolveRoot: () => Promise<string>,
  maxReadableBytes: number,
): Promise<PippitWidgetMediaChunk | undefined> {
  const root = await resolveRoot()
  let handle: FileHandle
  try {
    handle = await open(
      widgetArtifactPath(root, request.artifactId),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
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
    ) throw new Error("The local Pippit video artifact is unsafe.")
    if (request.offset >= stats.size) return undefined
    const requestedBytes = Math.min(request.length, stats.size - request.offset)
    const buffer = Buffer.allocUnsafe(requestedBytes)
    let bytesRead = 0
    while (bytesRead < requestedBytes) {
      const next = await handle.read(buffer, bytesRead, requestedBytes - bytesRead, request.offset + bytesRead)
      if (next.bytesRead === 0) {
        throw new Error("The local Pippit video artifact changed while being read.")
      }
      bytesRead += next.bytesRead
    }
    return {
      blob: buffer.toString("base64"),
      bytes: bytesRead,
      complete: request.offset + bytesRead === stats.size,
      mimeType: "video/mp4",
      offset: request.offset,
      resourceUri: request.resourceUri,
      totalBytes: stats.size,
    }
  } finally {
    await handle.close()
  }
}

export async function readWidgetArtifactResource(
  uri: string,
  resolveRoot: () => Promise<string>,
  maxReadableBytes: number,
  maxChunkBytes: number,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const request = parseArtifactResourceUri(uri, maxChunkBytes)
  if (request === undefined) return undefined
  const chunk = await readWidgetArtifactChunk(request, resolveRoot, maxReadableBytes)
  if (chunk === undefined) return undefined
  return {
    contents: [{
      _meta: {
        "pippit/chunk": {
          bytes: chunk.bytes,
          complete: chunk.complete,
          offset: chunk.offset,
          total_bytes: chunk.totalBytes,
        },
      },
      blob: chunk.blob,
      mimeType: chunk.mimeType,
      uri,
    }],
  }
}

export async function readWidgetImageArtifact(
  uri: string,
  resolveRoot: () => Promise<string>,
  maxReadableBytes: number,
): Promise<PippitWidgetImageArtifact | undefined> {
  const parsed = parseImageArtifactResourceUri(uri)
  if (parsed === undefined) return undefined
  const path = widgetImageArtifactPath(await resolveRoot(), parsed.artifactId, parsed.extension)
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
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
    ) throw new Error("The local Pippit image artifact is unsafe.")
    const bytes = await handle.readFile()
    if (bytes.byteLength !== stats.size) {
      throw new Error("The local Pippit image artifact changed while being read.")
    }
    return {
      blob: bytes.toString("base64"),
      bytes: bytes.byteLength,
      filename: basename(path),
      mimeType: parsed.mimeType,
      resourceUri: uri,
    }
  } finally {
    await handle.close()
  }
}

export async function revealWidgetImageArtifact(
  uri: string,
  resolveRoot: () => Promise<string>,
  maxReadableBytes: number,
  revealFile: (path: string) => Promise<void>,
): Promise<boolean> {
  const parsed = parseImageArtifactResourceUri(uri)
  if (parsed === undefined) return false
  const path = widgetImageArtifactPath(await resolveRoot(), parsed.artifactId, parsed.extension)
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
  try {
    const stats = await handle.stat()
    if (
      !stats.isFile() ||
      stats.size <= 0 ||
      stats.size > maxReadableBytes ||
      (process.platform !== "win32" && (stats.mode & 0o077) !== 0)
    ) throw new Error("The local Pippit image artifact is unsafe.")
  } finally {
    await handle.close()
  }
  await revealFile(path)
  return true
}
