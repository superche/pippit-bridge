import { isAbsolute, resolve } from "node:path"

import {
  DEFAULT_MAX_ARTIFACT_BYTES,
  DEFAULT_MAX_INLINE_PREVIEW_BYTES,
  DEFAULT_MAX_RESOURCE_CHUNK_BYTES,
  IMAGE_MEDIA_TYPES,
  type CachedWidgetArtifact,
  type PippitWidgetMediaServer,
  type PippitWidgetMediaServerOptions,
} from "./widget-media-contracts.ts"
import {
  parseWidgetArtifactResourceIdentity,
  readWidgetArtifactChunk,
  readWidgetArtifactResource,
  readWidgetImageArtifact,
  revealFileInSystemManager,
  revealWidgetImageArtifact,
  widgetArtifactId,
  widgetArtifactPath,
  widgetArtifactResourceUri,
  widgetImageExtension,
} from "./widget-media-resources.ts"
import {
  downloadWidgetArtifact,
  ensurePrivateWidgetArtifactDirectory,
  findExistingWidgetArtifact,
  persistWidgetImageArtifact,
} from "./widget-media-store.ts"
import {
  pippitWidgetListResources,
  pippitWidgetReadResource,
} from "./widget-protocol.ts"

export type {
  PippitPreparedWidgetImage,
  PippitPreparedWidgetMedia,
  PippitWidgetImageArtifact,
  PippitWidgetMediaBackend,
  PippitWidgetMediaChunk,
  PippitWidgetMediaServer,
  PippitWidgetMediaServerOptions,
} from "./widget-media-contracts.ts"

export function createPippitWidgetMediaServer(
  options: PippitWidgetMediaServerOptions,
): PippitWidgetMediaServer {
  const maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES
  const maxInlinePreviewBytes = options.maxInlinePreviewBytes ?? Math.min(
    DEFAULT_MAX_INLINE_PREVIEW_BYTES,
    maxArtifactBytes,
  )
  const maxResourceChunkBytes = options.maxResourceChunkBytes ?? DEFAULT_MAX_RESOURCE_CHUNK_BYTES
  const revealFile = options.revealFile ?? revealFileInSystemManager
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
  const downloads = new Map<string, Promise<CachedWidgetArtifact>>()
  const downloadControllers = new Set<AbortController>()

  const resolveArtifactRoot = async (): Promise<string> => {
    rootPromise ??= (async () => {
      const configured = typeof options.artifactRoot === "string"
        ? options.artifactRoot
        : await options.artifactRoot()
      if (!isAbsolute(configured)) throw new Error("Widget media artifact root must be absolute.")
      const root = resolve(configured)
      await ensurePrivateWidgetArtifactDirectory(root)
      return root
    })().catch((error: unknown) => {
      rootPromise = undefined
      throw error
    })
    return await rootPromise
  }

  const ensureArtifact = async (jobId: string, index: number): Promise<CachedWidgetArtifact> => {
    if (closed) throw new Error("The widget media server is closed.")
    if (jobId === "" || !Number.isSafeInteger(index) || index < 0) {
      throw new Error("Widget media identity is invalid.")
    }
    const root = await resolveArtifactRoot()
    const id = widgetArtifactId(jobId, index)
    const path = widgetArtifactPath(root, id)
    const present = await findExistingWidgetArtifact(path, id)
    if (present !== undefined) return present
    let active = downloads.get(id)
    if (active === undefined) {
      active = downloadWidgetArtifact({
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
            description: "Read one private local generated Pippit image artifact.",
            mimeType: "image/*",
            name: "Pippit local image",
            uriTemplate: "pippit-image://artifact/{artifact_id}.{extension}",
          },
          {
            description: "Read a bounded chunk from a private local Pippit MP4 artifact.",
            mimeType: "video/mp4",
            name: "Pippit local video chunk",
            uriTemplate: "pippit-video://artifact/{artifact_id}{?length,offset}",
          },
        ],
      }
    },
    async prepareImage(data, mimeType) {
      if (closed) throw new Error("The widget media server is closed.")
      const extension = widgetImageExtension(mimeType)
      if (extension === undefined) throw new Error("The generated Pippit image type is unsupported.")
      return await persistWidgetImageArtifact({
        data,
        extension,
        maxBytes: maxInlinePreviewBytes,
        mimeType: IMAGE_MEDIA_TYPES[extension],
        root: await resolveArtifactRoot(),
      })
    },
    async preparePreview(jobId, index) {
      const cached = await ensureArtifact(jobId, index)
      return {
        bytes: cached.size,
        filename: cached.filename,
        localPath: cached.path,
        resourceUri: widgetArtifactResourceUri(cached.artifactId),
      }
    },
    async readImage(resourceUri) {
      if (closed) throw new Error("The widget media server is closed.")
      return await readWidgetImageArtifact(resourceUri, resolveArtifactRoot, maxInlinePreviewBytes)
    },
    async revealImage(resourceUri) {
      if (closed) throw new Error("The widget media server is closed.")
      return await revealWidgetImageArtifact(
        resourceUri,
        resolveArtifactRoot,
        maxInlinePreviewBytes,
        revealFile,
      )
    },
    async readChunk(resourceUri, offset, length) {
      if (closed) throw new Error("The widget media server is closed.")
      const artifactId = parseWidgetArtifactResourceIdentity(resourceUri)
      if (
        artifactId === undefined ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 1 ||
        length > maxResourceChunkBytes
      ) return undefined
      return await readWidgetArtifactChunk(
        { artifactId, length, offset, resourceUri },
        resolveArtifactRoot,
        maxInlinePreviewBytes,
      )
    },
    async readResource(uri) {
      if (closed) throw new Error("The widget media server is closed.")
      const widgetResource = pippitWidgetReadResource(uri)
      if (widgetResource !== undefined) return widgetResource
      const image = await readWidgetImageArtifact(uri, resolveArtifactRoot, maxInlinePreviewBytes)
      if (image !== undefined) {
        return { contents: [{ blob: image.blob, mimeType: image.mimeType, uri }] }
      }
      return await readWidgetArtifactResource(
        uri,
        resolveArtifactRoot,
        maxInlinePreviewBytes,
        maxResourceChunkBytes,
      )
    },
  }
}
