import type { PippitVideoDownloadOptions } from "./contracts.ts"
import type { PippitMcpResourceProvider } from "./protocol.ts"

export const DEFAULT_MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024
export const DEFAULT_MAX_INLINE_PREVIEW_BYTES = 256 * 1024 * 1024
export const DEFAULT_MAX_RESOURCE_CHUNK_BYTES = 1024 * 1024

export const IMAGE_MEDIA_TYPES = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const

export type PippitWidgetImageExtension = keyof typeof IMAGE_MEDIA_TYPES

export interface PippitWidgetMediaBackend {
  downloadVideo(jobId: string, options?: PippitVideoDownloadOptions): Promise<Response>
}

export interface PippitWidgetMediaServer extends PippitMcpResourceProvider {
  close(): Promise<void>
  prepareImage?(
    data: string,
    mimeType: string,
  ): Promise<PippitPreparedWidgetImage>
  preparePreview(jobId: string, index: number): Promise<PippitPreparedWidgetMedia>
  readImage?(resourceUri: string): Promise<PippitWidgetImageArtifact | undefined>
  readChunk(resourceUri: string, offset: number, length: number): Promise<PippitWidgetMediaChunk | undefined>
  revealImage?(resourceUri: string): Promise<boolean>
}

export interface PippitPreparedWidgetImage {
  readonly bytes: number
  readonly filename: string
  readonly localPath: string
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp"
  readonly resourceUri: string
}

export interface PippitWidgetImageArtifact {
  readonly blob: string
  readonly bytes: number
  readonly filename: string
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp"
  readonly resourceUri: string
}

export interface PippitPreparedWidgetMedia {
  readonly bytes: number
  readonly filename: string
  readonly localPath: string
  readonly resourceUri: string
}

export interface PippitWidgetMediaChunk {
  readonly blob: string
  readonly bytes: number
  readonly complete: boolean
  readonly mimeType: "video/mp4"
  readonly offset: number
  readonly resourceUri: string
  readonly totalBytes: number
}

export interface PippitWidgetMediaServerOptions {
  readonly artifactRoot: string | (() => Promise<string>)
  readonly backend: PippitWidgetMediaBackend
  readonly maxArtifactBytes?: number
  readonly maxInlinePreviewBytes?: number
  readonly maxResourceChunkBytes?: number
  readonly revealFile?: (path: string) => Promise<void>
}

export interface CachedWidgetArtifact {
  readonly artifactId: string
  readonly filename: string
  readonly path: string
  readonly size: number
}

export interface WidgetArtifactResourceRequest {
  readonly artifactId: string
  readonly length: number
  readonly offset: number
  readonly resourceUri: string
}
