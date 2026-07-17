import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

export type ReferenceKind = 'image' | 'video' | 'audio';

export interface LoadedReference {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mediaType: string;
}

export interface ReferenceLoader {
  load(url: string, kind: ReferenceKind, signal?: AbortSignal): Promise<LoadedReference>;
}

export type ReferenceFetch = typeof fetch;

export interface ReferenceLookupAddress {
  readonly address: string;
  readonly family: number;
}

export type ReferenceLookup = (
  hostname: string,
  options: { readonly all: true; readonly verbatim: true },
) => Promise<readonly ReferenceLookupAddress[]>;

export interface ReferenceLoaderConfig {
  readonly allowPrivateUrls?: boolean;
  readonly fetchImpl?: ReferenceFetch;
  readonly lookup?: ReferenceLookup;
  readonly maxBytes?: number;
  readonly maxBytesByKind?: Readonly<Record<ReferenceKind, number>>;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly transport?: ReferenceTransport;
}

export interface PublicHttpFetchOptions {
  readonly headers?: HeadersInit;
  readonly signal?: AbortSignal;
}

export interface PublicHttpFetchResult {
  readonly response: Response;
  readonly url: URL;
}

export interface PublicHttpFetcher {
  fetch(url: string | URL, options?: PublicHttpFetchOptions): Promise<PublicHttpFetchResult>;
}

export interface PublicHttpFetcherConfig {
  readonly allowPrivateUrls?: boolean;
  /** Test seam only. The production default pins the validated address to the socket lookup. */
  readonly fetchImpl?: ReferenceFetch;
  readonly lookup?: ReferenceLookup;
  readonly maxRedirects?: number;
  readonly transport?: ReferenceTransport;
}

export type ReferenceTransport = (
  url: URL,
  target: ReferenceLookupAddress | undefined,
  options: PublicHttpFetchOptions,
) => Promise<Response>;

export type ReferenceLoadErrorCode =
  | 'ABORTED'
  | 'DNS_LOOKUP_FAILED'
  | 'HTTP_ERROR'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_DATA_URL'
  | 'INVALID_KIND'
  | 'INVALID_REDIRECT'
  | 'INVALID_URL'
  | 'MEDIA_TYPE_MISMATCH'
  | 'NETWORK_ERROR'
  | 'PRIVATE_ADDRESS'
  | 'REDIRECT_LIMIT_EXCEEDED'
  | 'TIMEOUT'
  | 'TOTAL_TOO_LARGE'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_FORMAT'
  | 'UNSUPPORTED_SCHEME'
  | 'URL_CREDENTIALS_NOT_ALLOWED';

function errorMessage(code: ReferenceLoadErrorCode, status?: number): string {
  switch (code) {
    case 'ABORTED':
      return 'Reference loading was aborted';
    case 'DNS_LOOKUP_FAILED':
      return 'The reference host could not be resolved';
    case 'HTTP_ERROR':
      return `The reference server returned HTTP status ${status ?? 'unknown'}`;
    case 'INVALID_CONFIGURATION':
      return 'The reference loader configuration is invalid';
    case 'INVALID_DATA_URL':
      return 'The reference data URL is invalid';
    case 'INVALID_KIND':
      return 'The reference kind is invalid';
    case 'INVALID_REDIRECT':
      return 'The reference server returned an invalid redirect';
    case 'INVALID_URL':
      return 'The reference URL is invalid';
    case 'MEDIA_TYPE_MISMATCH':
      return 'The reference media type does not match its declared reference kind';
    case 'NETWORK_ERROR':
      return 'The reference network request failed';
    case 'PRIVATE_ADDRESS':
      return 'References to private network addresses are not allowed';
    case 'REDIRECT_LIMIT_EXCEEDED':
      return 'The reference redirect limit was exceeded';
    case 'TIMEOUT':
      return 'Reference loading timed out';
    case 'TOTAL_TOO_LARGE':
      return 'The references exceed the configured total byte limit';
    case 'TOO_LARGE':
      return 'The reference exceeds the configured byte limit';
    case 'UNSUPPORTED_MEDIA_FORMAT':
      return 'The reference media format is not supported';
    case 'UNSUPPORTED_SCHEME':
      return 'The reference URL scheme is not supported';
    case 'URL_CREDENTIALS_NOT_ALLOWED':
      return 'Credentials in reference URLs are not allowed';
  }
}

/**
 * A deliberately sanitized error. It never retains the source URL, a response
 * body, or a lower-level error cause, because each of those may contain secrets.
 */
export class ReferenceLoadError extends Error {
  readonly code: ReferenceLoadErrorCode;
  readonly status?: number;

  constructor(code: ReferenceLoadErrorCode, options: { readonly status?: number } = {}) {
    super(errorMessage(code, options.status));
    this.name = 'ReferenceLoadError';
    this.code = code;
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}

const DEFAULT_MAX_BYTES_BY_KIND: Readonly<Record<ReferenceKind, number>> = {
  audio: 15 * 1024 * 1024,
  image: 30 * 1024 * 1024,
  video: 200 * 1024 * 1024,
};
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const GENERIC_MEDIA_TYPES = new Set(['application/octet-stream', 'binary/octet-stream']);

const DEFAULT_METADATA: Readonly<Record<ReferenceKind, { extension: string; mediaType: string }>> = {
  audio: { extension: 'mp3', mediaType: 'audio/mpeg' },
  image: { extension: 'jpg', mediaType: 'image/jpeg' },
  video: { extension: 'mp4', mediaType: 'video/mp4' },
};

const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  aac: 'audio/aac',
  avi: 'video/x-msvideo',
  avif: 'image/avif',
  bmp: 'image/bmp',
  flac: 'audio/flac',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  m4a: 'audio/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  ogv: 'video/ogg',
  png: 'image/png',
  svg: 'image/svg+xml',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
};

const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/mpeg': 'mpg',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
};

const defaultLookup: ReferenceLookup = async (hostname, options) =>
  dnsLookup(hostname, options);

function assertPositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new ReferenceLoadError('INVALID_CONFIGURATION');
  }
}

function assertNonNegativeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReferenceLoadError('INVALID_CONFIGURATION');
  }
}

function isReferenceKind(value: unknown): value is ReferenceKind {
  return value === 'image' || value === 'video' || value === 'audio';
}

function parseUrl(value: string): URL {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ReferenceLoadError('INVALID_URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ReferenceLoadError('INVALID_URL');
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new ReferenceLoadError('URL_CREDENTIALS_NOT_ALLOWED');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ReferenceLoadError('UNSUPPORTED_SCHEME');
  }

  return parsed;
}

function parseIpv4(address: string): readonly number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return undefined;
  }

  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return undefined;
  }
  return octets;
}

function isBlockedIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (octets === undefined) {
    return true;
  }

  const first = octets[0] ?? 0;
  const second = octets[1] ?? 0;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && octets[2] === 100) ||
    (first === 203 && second === 0 && octets[2] === 113) ||
    first >= 224
  );
}

function ipv4ToWords(address: string): readonly [number, number] | undefined {
  const octets = parseIpv4(address);
  if (octets === undefined) {
    return undefined;
  }
  return [((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)];
}

function parseIpv6(address: string): readonly number[] | undefined {
  let normalized = address.toLowerCase();
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex !== -1) {
    normalized = normalized.slice(0, zoneIndex);
  }

  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    if (lastColon === -1) {
      return undefined;
    }
    const words = ipv4ToWords(normalized.slice(lastColon + 1));
    if (words === undefined) {
      return undefined;
    }
    normalized = `${normalized.slice(0, lastColon)}:${words[0].toString(16)}:${words[1].toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) {
    return undefined;
  }

  const left = halves[0] === '' ? [] : (halves[0]?.split(':') ?? []);
  const right = halves.length === 1 || halves[1] === '' ? [] : (halves[1]?.split(':') ?? []);
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return undefined;
  }

  const wordStrings = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (wordStrings.length !== 8) {
    return undefined;
  }

  const words = wordStrings.map((word) => Number.parseInt(word, 16));
  if (
    wordStrings.some((word) => !/^[0-9a-f]{1,4}$/u.test(word)) ||
    words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)
  ) {
    return undefined;
  }
  return words;
}

function isBlockedIpv6(address: string): boolean {
  const words = parseIpv6(address);
  if (words === undefined) {
    return true;
  }

  const first = words[0] ?? 0;
  const allButLastAreZero = words.slice(0, 7).every((word) => word === 0);
  if (words.every((word) => word === 0) || (allButLastAreZero && words[7] === 1)) {
    return true;
  }
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) {
    return true;
  }
  if ((first & 0xff00) === 0xff00) {
    return true;
  }
  if (
    (first === 0x0064 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0)) ||
    (first === 0x0100 && words.slice(1, 4).every((word) => word === 0)) ||
    (first === 0x2001 && (words[1] === 0x0db8 || (words[1] ?? 0) < 0x0200)) ||
    first === 0x2002
  ) {
    return true;
  }

  const isIpv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const isIpv4Compatible = words.slice(0, 6).every((word) => word === 0);
  if (isIpv4Mapped || isIpv4Compatible) {
    const high = words[6] ?? 0;
    const low = words[7] ?? 0;
    return isBlockedIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }

  return false;
}

function isBlockedAddress(address: string): boolean {
  const withoutBrackets = address.startsWith('[') && address.endsWith(']')
    ? address.slice(1, -1)
    : address;
  const version = isIP(withoutBrackets.split('%', 1)[0] ?? withoutBrackets);
  if (version === 4) {
    return isBlockedIpv4(withoutBrackets);
  }
  if (version === 6) {
    return isBlockedIpv6(withoutBrackets);
  }
  return true;
}

async function assertPublicHttpUrl(
  url: URL,
  allowPrivateUrls: boolean,
  lookup: ReferenceLookup,
): Promise<ReferenceLookupAddress | undefined> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ReferenceLoadError('UNSUPPORTED_SCHEME');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ReferenceLoadError('URL_CREDENTIALS_NOT_ALLOWED');
  }
  if (allowPrivateUrls) {
    return undefined;
  }

  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (isIP(hostname) !== 0) {
    if (isBlockedAddress(hostname)) {
      throw new ReferenceLoadError('PRIVATE_ADDRESS');
    }
    return { address: hostname, family: isIP(hostname) };
  }

  let addresses: readonly ReferenceLookupAddress[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ReferenceLoadError('DNS_LOOKUP_FAILED');
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isIP(address) === 0)) {
    throw new ReferenceLoadError('DNS_LOOKUP_FAILED');
  }
  if (addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new ReferenceLoadError('PRIVATE_ADDRESS');
  }
  const selected = addresses[0];
  if (selected === undefined) {
    throw new ReferenceLoadError('DNS_LOOKUP_FAILED');
  }
  return { address: selected.address, family: isIP(selected.address) };
}

function toRequestHeaders(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

function toResponseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
}

function fetchWithPinnedNodeTransport(
  url: URL,
  target: ReferenceLookupAddress | undefined,
  options: PublicHttpFetchOptions,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const requestFactory = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const pinnedLookup: LookupFunction | undefined =
      target === undefined
        ? undefined
        : (_hostname, lookupOptions, callback) => {
            const family = target.family === 6 ? 6 : 4;
            if (lookupOptions.all) callback(null, [{ address: target.address, family }]);
            else callback(null, target.address, family);
          };
    const request = requestFactory(
      url,
      {
        headers: toRequestHeaders(options.headers),
        lookup: pinnedLookup,
        method: 'GET',
        signal: options.signal,
      },
      (incoming) => {
        const status = incoming.statusCode ?? 502;
        const bodyless = status === 101 || status === 204 || status === 205 || status === 304;
        const body = bodyless
          ? null
          : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        try {
          resolve(
            new Response(body, {
              headers: toResponseHeaders(incoming.headers),
              status,
              ...(incoming.statusMessage === undefined ? {} : { statusText: incoming.statusMessage }),
            }),
          );
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      },
    );
    request.once('error', reject);
    request.end();
  });
}

export function createPublicHttpFetcher(config: PublicHttpFetcherConfig = {}): PublicHttpFetcher {
  const allowPrivateUrls = config.allowPrivateUrls ?? false;
  const fetchImpl = config.fetchImpl;
  const lookup = config.lookup ?? defaultLookup;
  const maxRedirects = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const transport = config.transport ?? fetchWithPinnedNodeTransport;
  assertNonNegativeInteger(maxRedirects);

  return {
    async fetch(source, options = {}) {
      const initial = typeof source === 'string' ? source : source.href;
      let currentUrl = parseUrl(initial);
      let redirectCount = 0;

      while (true) {
        const target = await assertPublicHttpUrl(currentUrl, allowPrivateUrls, lookup);
        const response = fetchImpl
          ? await fetchImpl(currentUrl.href, {
              ...(options.headers === undefined ? {} : { headers: options.headers }),
              method: 'GET',
              redirect: 'manual',
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            })
          : await transport(currentUrl, target, options);

        if (!REDIRECT_STATUSES.has(response.status)) {
          return { response, url: currentUrl };
        }
        if (redirectCount >= maxRedirects) {
          await cancelResponseBody(response);
          throw new ReferenceLoadError('REDIRECT_LIMIT_EXCEEDED');
        }
        const location = response.headers.get('location');
        await cancelResponseBody(response);
        if (location === null) {
          throw new ReferenceLoadError('INVALID_REDIRECT');
        }
        try {
          currentUrl = new URL(location, currentUrl);
        } catch {
          throw new ReferenceLoadError('INVALID_REDIRECT');
        }
        if (currentUrl.username !== '' || currentUrl.password !== '') {
          throw new ReferenceLoadError('URL_CREDENTIALS_NOT_ALLOWED');
        }
        redirectCount += 1;
      }
    },
  };
}

function extensionFromFilename(filename: string): string | undefined {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === filename.length - 1) {
    return undefined;
  }
  return filename.slice(dotIndex + 1).toLowerCase();
}

function parseMediaType(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType === undefined || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)) {
    return undefined;
  }
  return mediaType;
}

function sanitizeFilename(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const basename = value
    .split(/[\\/]/u)
    .at(-1)
    ?.split('')
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join('')
    .trim();
  if (basename === undefined || basename === '' || basename === '.' || basename === '..') {
    return undefined;
  }
  return basename.slice(0, 255);
}

function unquoteHeaderValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/gu, '$1');
  }
  return trimmed;
}

function filenameFromContentDisposition(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }

  const encodedMatch = /(?:^|;)\s*filename\*\s*=\s*([^;]+)/iu.exec(value);
  if (encodedMatch?.[1] !== undefined) {
    const encoded = unquoteHeaderValue(encodedMatch[1]);
    const separatorIndex = encoded.indexOf("''");
    const encodedFilename = separatorIndex === -1 ? encoded : encoded.slice(separatorIndex + 2);
    try {
      const filename = sanitizeFilename(decodeURIComponent(encodedFilename));
      if (filename !== undefined) {
        return filename;
      }
    } catch {
      // Fall through to the plain filename parameter.
    }
  }

  const plainMatch = /(?:^|;)\s*filename\s*=\s*("(?:\\.|[^"])*"|[^;]*)/iu.exec(value);
  return sanitizeFilename(plainMatch?.[1] === undefined ? undefined : unquoteHeaderValue(plainMatch[1]));
}

function filenameFromUrl(url: URL): string | undefined {
  const encoded = url.pathname.split('/').at(-1);
  if (encoded === undefined || encoded === '') {
    return undefined;
  }
  try {
    return sanitizeFilename(decodeURIComponent(encoded));
  } catch {
    return sanitizeFilename(encoded);
  }
}

function inferMetadata(
  kind: ReferenceKind,
  explicitMediaType: string | undefined,
  filenameCandidate: string | undefined,
): { readonly filename: string; readonly mediaType: string } {
  const defaults = DEFAULT_METADATA[kind];
  const safeCandidate = sanitizeFilename(filenameCandidate);
  const candidateExtension = safeCandidate === undefined ? undefined : extensionFromFilename(safeCandidate);
  const extensionMediaType = candidateExtension === undefined
    ? undefined
    : MEDIA_TYPE_BY_EXTENSION[candidateExtension];
  const mediaType = explicitMediaType === undefined || GENERIC_MEDIA_TYPES.has(explicitMediaType)
    ? (extensionMediaType ?? defaults.mediaType)
    : explicitMediaType;
  if (!mediaType.startsWith(`${kind}/`)) {
    throw new ReferenceLoadError('MEDIA_TYPE_MISMATCH');
  }
  if (extensionMediaType !== undefined && extensionMediaType !== mediaType) {
    throw new ReferenceLoadError('MEDIA_TYPE_MISMATCH');
  }

  const extension = extensionMediaType === undefined
    ? (EXTENSION_BY_MEDIA_TYPE[mediaType] ?? defaults.extension)
    : candidateExtension;
  const filename = safeCandidate === undefined
    ? `reference.${extension}`
    : extensionMediaType === undefined
      ? `${safeCandidate}.${extension}`
      : safeCandidate;
  return { filename: sanitizeFilename(filename) ?? `reference.${defaults.extension}`, mediaType };
}

function startsWithBytes(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  return Buffer.from(bytes.subarray(offset, offset + length)).toString('ascii');
}

function detectMediaType(bytes: Uint8Array, kind: ReferenceKind): string {
  if (kind === 'image') {
    if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (asciiAt(bytes, 0, 6) === 'GIF87a' || asciiAt(bytes, 0, 6) === 'GIF89a') return 'image/gif';
    if (asciiAt(bytes, 0, 2) === 'BM') return 'image/bmp';
    if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') return 'image/webp';
  }
  if (kind === 'video' && bytes.byteLength >= 12 && asciiAt(bytes, 4, 4) === 'ftyp') {
    return asciiAt(bytes, 8, 4) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (kind === 'audio') {
    if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WAVE') return 'audio/wav';
    if (
      asciiAt(bytes, 0, 3) === 'ID3' ||
      (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe0) === 0xe0)
    ) {
      return 'audio/mpeg';
    }
  }
  throw new ReferenceLoadError('UNSUPPORTED_MEDIA_FORMAT');
}

function canonicalDeclaredMediaType(value: string | undefined): string | undefined {
  if (value === undefined || GENERIC_MEDIA_TYPES.has(value)) return undefined;
  const aliases: Readonly<Record<string, string>> = {
    'application/mp4': 'video/mp4',
    'audio/mp3': 'audio/mpeg',
    'audio/wave': 'audio/wav',
    'audio/x-wav': 'audio/wav',
    'video/mov': 'video/quicktime',
    'video/x-mov': 'video/quicktime',
    'video/x-mp4': 'video/mp4',
    'video/x-quicktime': 'video/quicktime',
  };
  return aliases[value] ?? value;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best effort and its error may contain upstream details.
  }
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/u.test(contentLength.trim())) {
    const declaredBytes = Number(contentLength);
    if (declaredBytes > maxBytes) {
      await cancelResponseBody(response);
      throw new ReferenceLoadError('TOO_LARGE');
    }
  }

  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    const chunk = result.value;
    if (totalBytes + chunk.byteLength > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The byte-limit error is the only safe error to expose here.
      }
      throw new ReferenceLoadError('TOO_LARGE');
    }
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function runWithDeadline<T>(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      callerSignal?.removeEventListener('abort', onCallerAbort);
    };
    const rejectOnce = (error: ReferenceLoadError): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      controller.abort();
      reject(error);
    };
    const onCallerAbort = (): void => {
      rejectOnce(new ReferenceLoadError('ABORTED'));
    };

    if (callerSignal?.aborted === true) {
      onCallerAbort();
      return;
    }
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    timer = setTimeout(() => {
      rejectOnce(new ReferenceLoadError('TIMEOUT'));
    }, timeoutMs);

    task(controller.signal).then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error instanceof ReferenceLoadError ? error : new ReferenceLoadError('NETWORK_ERROR'));
      },
    );
  });
}

async function loadHttpReference(
  initialUrl: URL,
  kind: ReferenceKind,
  options: {
    readonly fetcher: PublicHttpFetcher;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  },
): Promise<LoadedReference> {
  const { response, url } = await options.fetcher.fetch(initialUrl, { signal: options.signal });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new ReferenceLoadError('HTTP_ERROR', { status: response.status });
  }

  const bytes = await readLimitedBody(response, options.maxBytes);
  const detectedMediaType = detectMediaType(bytes, kind);
  const declaredMediaType = canonicalDeclaredMediaType(parseMediaType(response.headers.get('content-type')));
  if (declaredMediaType !== undefined && declaredMediaType !== detectedMediaType) {
    throw new ReferenceLoadError('MEDIA_TYPE_MISMATCH');
  }
  const headerFilename = filenameFromContentDisposition(response.headers.get('content-disposition'));
  const filenameCandidate = headerFilename ?? filenameFromUrl(url);
  const inferred = inferMetadata(kind, detectedMediaType, filenameCandidate);
  return { bytes, filename: inferred.filename, mediaType: inferred.mediaType };
}

/**
 * Creates an HTTP(S)-only reference loader. The production transport pins the
 * validated DNS answer to the actual socket and revalidates every redirect.
 */
export function createReferenceLoader(config: ReferenceLoaderConfig = {}): ReferenceLoader {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  assertPositiveInteger(timeoutMs);
  assertNonNegativeInteger(maxRedirects);
  const maxBytesByKind: Readonly<Record<ReferenceKind, number>> = {
    audio: config.maxBytesByKind?.audio ?? config.maxBytes ?? DEFAULT_MAX_BYTES_BY_KIND.audio,
    image: config.maxBytesByKind?.image ?? config.maxBytes ?? DEFAULT_MAX_BYTES_BY_KIND.image,
    video: config.maxBytesByKind?.video ?? config.maxBytes ?? DEFAULT_MAX_BYTES_BY_KIND.video,
  };
  for (const maxBytes of Object.values(maxBytesByKind)) assertPositiveInteger(maxBytes);
  const fetcher = createPublicHttpFetcher({
    ...(config.allowPrivateUrls === undefined ? {} : { allowPrivateUrls: config.allowPrivateUrls }),
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    ...(config.lookup === undefined ? {} : { lookup: config.lookup }),
    maxRedirects,
    ...(config.transport === undefined ? {} : { transport: config.transport }),
  });

  return {
    load(url, kind, signal) {
      if (!isReferenceKind(kind)) {
        return Promise.reject(new ReferenceLoadError('INVALID_KIND'));
      }

      let parsed: URL;
      try {
        parsed = parseUrl(url);
      } catch (error) {
        return Promise.reject(
          error instanceof ReferenceLoadError ? error : new ReferenceLoadError('INVALID_URL'),
        );
      }

      if (signal?.aborted === true) return Promise.reject(new ReferenceLoadError('ABORTED'));

      return runWithDeadline(timeoutMs, signal, (internalSignal) =>
        loadHttpReference(parsed, kind, {
          fetcher,
          maxBytes: maxBytesByKind[kind],
          signal: internalSignal,
        }));
    },
  };
}
