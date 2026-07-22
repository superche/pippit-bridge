export type ReferenceKind = "image" | "video" | "audio"

export interface LoadedReference {
  readonly bytes: Uint8Array
  readonly filename: string
  readonly mediaType: string
}

export interface ReferenceLoader {
  load(url: string, kind: ReferenceKind, signal?: AbortSignal): Promise<LoadedReference>
}

export type ReferenceFetch = typeof fetch
export interface ReferenceLookupAddress { readonly address: string; readonly family: number }
export type ReferenceLookup = (
  hostname: string,
  options: { readonly all: true; readonly verbatim: true },
) => Promise<readonly ReferenceLookupAddress[]>

export interface ReferenceLoaderConfig {
  readonly allowPrivateUrls?: boolean
  readonly fetchImpl?: ReferenceFetch
  readonly lookup?: ReferenceLookup
  readonly maxBytes?: number
  readonly maxBytesByKind?: Readonly<Record<ReferenceKind, number>>
  readonly maxRedirects?: number
  readonly timeoutMs?: number
  readonly transport?: ReferenceTransport
}

export interface PublicHttpFetchOptions { readonly headers?: HeadersInit; readonly signal?: AbortSignal }
export interface PublicHttpFetchResult { readonly response: Response; readonly url: URL }
export interface PublicHttpFetcher {
  fetch(url: string | URL, options?: PublicHttpFetchOptions): Promise<PublicHttpFetchResult>
}
export interface PublicHttpFetcherConfig {
  readonly allowPrivateUrls?: boolean
  /** Test seam only. The production default pins the validated address to the socket lookup. */
  readonly fetchImpl?: ReferenceFetch
  readonly lookup?: ReferenceLookup
  readonly maxRedirects?: number
  readonly transport?: ReferenceTransport
}
export type ReferenceTransport = (
  url: URL,
  target: ReferenceLookupAddress | undefined,
  options: PublicHttpFetchOptions,
) => Promise<Response>

export type ReferenceLoadErrorCode =
  | "ABORTED" | "DNS_LOOKUP_FAILED" | "HTTP_ERROR" | "INVALID_CONFIGURATION"
  | "INVALID_DATA_URL" | "INVALID_KIND" | "INVALID_REDIRECT" | "INVALID_URL"
  | "MEDIA_TYPE_MISMATCH" | "NETWORK_ERROR" | "PRIVATE_ADDRESS"
  | "REDIRECT_LIMIT_EXCEEDED" | "TIMEOUT" | "TOTAL_TOO_LARGE" | "TOO_LARGE"
  | "UNSUPPORTED_MEDIA_FORMAT" | "UNSUPPORTED_SCHEME" | "URL_CREDENTIALS_NOT_ALLOWED"

function errorMessage(code: ReferenceLoadErrorCode, status?: number): string {
  const messages: Record<Exclude<ReferenceLoadErrorCode, "HTTP_ERROR">, string> = {
    ABORTED: "Reference loading was aborted",
    DNS_LOOKUP_FAILED: "The reference host could not be resolved",
    INVALID_CONFIGURATION: "The reference loader configuration is invalid",
    INVALID_DATA_URL: "The reference data URL is invalid",
    INVALID_KIND: "The reference kind is invalid",
    INVALID_REDIRECT: "The reference server returned an invalid redirect",
    INVALID_URL: "The reference URL is invalid",
    MEDIA_TYPE_MISMATCH: "The reference media type does not match its declared reference kind",
    NETWORK_ERROR: "The reference network request failed",
    PRIVATE_ADDRESS: "References to private network addresses are not allowed",
    REDIRECT_LIMIT_EXCEEDED: "The reference redirect limit was exceeded",
    TIMEOUT: "Reference loading timed out",
    TOTAL_TOO_LARGE: "The references exceed the configured total byte limit",
    TOO_LARGE: "The reference exceeds the configured byte limit",
    UNSUPPORTED_MEDIA_FORMAT: "The reference media format is not supported",
    UNSUPPORTED_SCHEME: "The reference URL scheme is not supported",
    URL_CREDENTIALS_NOT_ALLOWED: "Credentials in reference URLs are not allowed",
  }
  return code === "HTTP_ERROR"
    ? `The reference server returned HTTP status ${status ?? "unknown"}`
    : messages[code]
}

/** Sanitized: never retains source URL, upstream body, or lower-level cause. */
export class ReferenceLoadError extends Error {
  readonly code: ReferenceLoadErrorCode
  readonly status?: number
  constructor(code: ReferenceLoadErrorCode, options: { readonly status?: number } = {}) {
    super(errorMessage(code, options.status))
    this.name = "ReferenceLoadError"
    this.code = code
    if (options.status !== undefined) this.status = options.status
  }
}

export const DEFAULT_MAX_BYTES_BY_KIND: Readonly<Record<ReferenceKind, number>> = {
  audio: 15 * 1024 * 1024, image: 30 * 1024 * 1024, video: 200 * 1024 * 1024,
}
export const DEFAULT_MAX_REDIRECTS = 3
export const PIPPIT_DEFAULT_REFERENCE_TIMEOUT_MS = 12 * 60 * 60 * 1_000
export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
export const GENERIC_MEDIA_TYPES = new Set(["application/octet-stream", "binary/octet-stream"])
export const DEFAULT_METADATA: Readonly<Record<ReferenceKind, { extension: string; mediaType: string }>> = {
  audio: { extension: "mp3", mediaType: "audio/mpeg" },
  image: { extension: "jpg", mediaType: "image/jpeg" },
  video: { extension: "mp4", mediaType: "video/mp4" },
}

export const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  aac: "audio/aac", avi: "video/x-msvideo", avif: "image/avif", bmp: "image/bmp",
  flac: "audio/flac", gif: "image/gif", jpeg: "image/jpeg", jpg: "image/jpeg", m4a: "audio/mp4",
  m4v: "video/mp4", mkv: "video/x-matroska", mov: "video/quicktime", mp3: "audio/mpeg",
  mp4: "video/mp4", mpeg: "video/mpeg", mpg: "video/mpeg", oga: "audio/ogg", ogg: "audio/ogg",
  ogv: "video/ogg", png: "image/png", svg: "image/svg+xml", wav: "audio/wav", webm: "video/webm", webp: "image/webp",
}

export const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  "audio/aac": "aac", "audio/flac": "flac", "audio/mp4": "m4a", "audio/mpeg": "mp3",
  "audio/ogg": "ogg", "audio/wav": "wav", "image/avif": "avif", "image/bmp": "bmp",
  "image/gif": "gif", "image/jpeg": "jpg", "image/png": "png", "image/svg+xml": "svg",
  "image/webp": "webp", "video/mp4": "mp4", "video/mpeg": "mpg", "video/ogg": "ogv",
  "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv", "video/x-msvideo": "avi",
}

export function assertPositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new ReferenceLoadError("INVALID_CONFIGURATION")
  }
}

export function assertNonNegativeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ReferenceLoadError("INVALID_CONFIGURATION")
}

export function isReferenceKind(value: unknown): value is ReferenceKind {
  return value === "image" || value === "video" || value === "audio"
}
