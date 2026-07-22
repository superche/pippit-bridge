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
import { basename, dirname } from "node:path"

import type {
  CachedWidgetArtifact,
  PippitPreparedWidgetImage,
  PippitWidgetImageArtifact,
  PippitWidgetImageExtension,
  PippitWidgetMediaBackend,
} from "./widget-media-contracts.ts"
import {
  widgetImageArtifactPath,
  widgetImageArtifactResourceUri,
} from "./widget-media-resources.ts"

export async function ensurePrivateWidgetArtifactDirectory(path: string): Promise<void> {
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

export async function findExistingWidgetArtifact(
  path: string,
  id: string,
): Promise<CachedWidgetArtifact | undefined> {
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

function decodeCanonicalBase64Image(data: string): Buffer {
  if (data === "" || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) {
    throw new Error("The generated Pippit image is not valid base64.")
  }
  const bytes = Buffer.from(data, "base64")
  if (bytes.length === 0 || bytes.toString("base64") !== data) {
    throw new Error("The generated Pippit image is not canonical base64.")
  }
  return bytes
}

export async function persistWidgetImageArtifact(input: {
  readonly data: string
  readonly extension: PippitWidgetImageExtension
  readonly maxBytes: number
  readonly mimeType: PippitWidgetImageArtifact["mimeType"]
  readonly root: string
}): Promise<PippitPreparedWidgetImage> {
  const bytes = decodeCanonicalBase64Image(input.data)
  if (bytes.byteLength > input.maxBytes) {
    throw new Error("The generated Pippit image exceeds the local artifact limit.")
  }
  const id = createHash("sha256")
    .update("pippit-image-artifact\0", "utf8")
    .update(input.mimeType, "utf8")
    .update("\0", "utf8")
    .update(bytes)
    .digest("hex")
  const path = widgetImageArtifactPath(input.root, id, input.extension)
  const present = await findExistingWidgetArtifact(path, id)
  if (present !== undefined) {
    return {
      bytes: present.size,
      filename: present.filename,
      localPath: present.path,
      mimeType: input.mimeType,
      resourceUri: widgetImageArtifactResourceUri(id, input.extension),
    }
  }

  const temporaryPath = `${path}.partial-${process.pid}-${randomBytes(8).toString("hex")}`
  let handle: FileHandle | undefined
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      await link(temporaryPath, path)
      await syncWidgetArtifactDirectory(dirname(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    await unlink(temporaryPath)
    const cached = await findExistingWidgetArtifact(path, id)
    if (cached === undefined) throw new Error("The Pippit image artifact could not be committed.")
    return {
      bytes: cached.size,
      filename: cached.filename,
      localPath: cached.path,
      mimeType: input.mimeType,
      resourceUri: widgetImageArtifactResourceUri(id, input.extension),
    }
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
  }
}

async function syncWidgetArtifactDirectory(path: string): Promise<void> {
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
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error("Pippit returned an invalid media length.")
  }
  return length
}

function playableContentType(value: string | null): boolean {
  if (value === null) return true
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase()
  return normalized === "application/octet-stream" || normalized === "video/mp4"
}

export async function downloadWidgetArtifact(input: {
  readonly backend: PippitWidgetMediaBackend
  readonly closed: () => boolean
  readonly controllers: Set<AbortController>
  readonly id: string
  readonly index: number
  readonly jobId: string
  readonly maxBytes: number
  readonly path: string
}): Promise<CachedWidgetArtifact> {
  await ensurePrivateWidgetArtifactDirectory(dirname(input.path))
  const present = await findExistingWidgetArtifact(input.path, input.id)
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
      await syncWidgetArtifactDirectory(dirname(input.path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    await unlink(temporaryPath)
    const cached = await findExistingWidgetArtifact(input.path, input.id)
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
