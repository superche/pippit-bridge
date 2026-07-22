import {
  assertNonNegativeInteger,
  assertPositiveInteger,
  DEFAULT_MAX_BYTES_BY_KIND,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_METADATA,
  EXTENSION_BY_MEDIA_TYPE,
  GENERIC_MEDIA_TYPES,
  isReferenceKind,
  MEDIA_TYPE_BY_EXTENSION,
  PIPPIT_DEFAULT_REFERENCE_TIMEOUT_MS,
  REDIRECT_STATUSES,
  ReferenceLoadError,
  type LoadedReference,
  type PublicHttpFetcher,
  type PublicHttpFetcherConfig,
  type ReferenceLoader,
  type ReferenceLoaderConfig,
  type ReferenceKind,
} from "./contracts.js"
import { assertPublicHttpUrl, defaultLookup, parseUrl } from "./network-policy.js"
import { fetchWithPinnedNodeTransport } from "./pinned-transport.js"

export {
  PIPPIT_DEFAULT_REFERENCE_TIMEOUT_MS,
  ReferenceLoadError,
  type LoadedReference,
  type PublicHttpFetchOptions,
  type PublicHttpFetchResult,
  type PublicHttpFetcher,
  type PublicHttpFetcherConfig,
  type ReferenceFetch,
  type ReferenceKind,
  type ReferenceLoader,
  type ReferenceLoaderConfig,
  type ReferenceLoadErrorCode,
  type ReferenceLookup,
  type ReferenceLookupAddress,
  type ReferenceTransport,
} from "./contracts.js"

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

/**
 * Applies the same signature and filename checks used by the remote loader to
 * bytes that a trusted host application already read from local storage.
 */
export function inspectReferenceBytes(input: {
  readonly bytes: Uint8Array;
  readonly filename?: string;
  readonly kind: ReferenceKind;
}): LoadedReference {
  if (!(input.bytes instanceof Uint8Array) || !isReferenceKind(input.kind)) {
    throw new ReferenceLoadError('INVALID_KIND');
  }
  const mediaType = detectMediaType(input.bytes, input.kind);
  const metadata = inferMetadata(input.kind, mediaType, input.filename);
  return { bytes: input.bytes, ...metadata };
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
  const timeoutMs = config.timeoutMs ?? PIPPIT_DEFAULT_REFERENCE_TIMEOUT_MS;
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
