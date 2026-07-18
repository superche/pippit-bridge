import { describe, expect, it, vi } from 'vitest';

import {
  ReferenceLoadError,
  createReferenceLoader,
  type ReferenceFetch,
  type ReferenceLookup,
  type ReferenceTransport,
} from '../src/reference-loader.js';

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP4_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);

function publicLookup(): ReferenceLookup {
  return async () => [{ address: '93.184.216.34', family: 4 }];
}

describe('createReferenceLoader', () => {
  it('streams HTTP media and infers a safe filename and media type from headers', async () => {
    const fetchImpl = vi.fn<ReferenceFetch>(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(PNG_BYTES.subarray(0, 4));
            controller.enqueue(PNG_BYTES.subarray(4));
            controller.close();
          },
        }),
        {
          headers: {
            'content-disposition': "attachment; filename*=UTF-8''hero%20shot.png",
            'content-type': 'image/png; charset=binary',
          },
        },
      ));
    const loader = createReferenceLoader({ fetchImpl, lookup: publicLookup() });

    await expect(loader.load('https://media.example/source', 'image')).resolves.toEqual({
      bytes: PNG_BYTES,
      filename: 'hero shot.png',
      mediaType: 'image/png',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://media.example/source',
      expect.objectContaining({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) }),
    );
  });

  it('follows redirects manually and validates every destination', async () => {
    const lookup = vi.fn<ReferenceLookup>(publicLookup());
    const fetchImpl = vi.fn<ReferenceFetch>(async (input) => {
      if (String(input) === 'https://origin.example/start') {
        return new Response(null, { headers: { location: 'https://cdn.example/final.mp4' }, status: 302 });
      }
      return new Response(MP4_BYTES, {
        headers: { 'content-type': 'application/octet-stream' },
      });
    });
    const loader = createReferenceLoader({ fetchImpl, lookup, maxRedirects: 1 });

    await expect(loader.load('https://origin.example/start', 'video')).resolves.toEqual({
      bytes: MP4_BYTES,
      filename: 'final.mp4',
      mediaType: 'video/mp4',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls.map(([hostname]) => hostname)).toEqual([
      'origin.example',
      'cdn.example',
    ]);
  });

  it('enforces maxBytes while streaming even without a Content-Length header', async () => {
    const fetchImpl = vi.fn<ReferenceFetch>(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([1, 2, 3]));
            controller.enqueue(Uint8Array.from([4, 5]));
            controller.close();
          },
        }),
      ));
    const loader = createReferenceLoader({ fetchImpl, lookup: publicLookup(), maxBytes: 4 });

    await expect(loader.load('https://media.example/large.jpg', 'image')).rejects.toMatchObject({
      name: 'ReferenceLoadError',
      code: 'TOO_LARGE',
    });
  });

  it('rejects oversized declared responses before consuming the body', async () => {
    const fetchImpl = vi.fn<ReferenceFetch>(async () =>
      new Response(Uint8Array.from([1]), { headers: { 'content-length': '1000' } }));
    const loader = createReferenceLoader({ fetchImpl, lookup: publicLookup(), maxBytes: 10 });

    await expect(loader.load('https://media.example/large.mp3', 'audio')).rejects.toMatchObject({
      code: 'TOO_LARGE',
    });
  });

  it('rejects data URLs so media cannot bypass the JSON body limit', async () => {
    const fetchImpl = vi.fn<ReferenceFetch>();
    const loader = createReferenceLoader({ fetchImpl, maxBytes: 32 });

    await expect(loader.load('data:image/png;base64,iVBORw0KGgo=', 'image')).rejects.toMatchObject({
      code: 'UNSUPPORTED_SCHEME',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an explicit media type that conflicts with the reference kind', async () => {
    const loader = createReferenceLoader({
      fetchImpl: async () => new Response(PNG_BYTES, { headers: { 'content-type': 'video/mp4' } }),
      lookup: publicLookup(),
      maxBytes: 1024,
    });

    await expect(loader.load('https://media.example/image.png', 'image')).rejects.toMatchObject({
      code: 'MEDIA_TYPE_MISMATCH',
    });
  });

  it('pins the validated DNS answer into the production transport seam', async () => {
    const transport = vi.fn<ReferenceTransport>(async () =>
      new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } }));
    const loader = createReferenceLoader({ lookup: publicLookup(), transport });

    await loader.load('https://media.example/reference.png', 'image');

    expect(transport).toHaveBeenCalledWith(
      new URL('https://media.example/reference.png'),
      { address: '93.184.216.34', family: 4 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('blocks private literal addresses and private DNS answers by default', async () => {
    const fetchImpl = vi.fn<ReferenceFetch>();
    const literalLoader = createReferenceLoader({ fetchImpl });
    const dnsLoader = createReferenceLoader({
      fetchImpl,
      lookup: async () => [{ address: '169.254.10.20', family: 4 }],
    });

    await expect(literalLoader.load('http://127.0.0.1/video.mp4', 'video')).rejects.toMatchObject({
      code: 'PRIVATE_ADDRESS',
    });
    await expect(dnsLoader.load('https://media.example/video.mp4', 'video')).rejects.toMatchObject({
      code: 'PRIVATE_ADDRESS',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks a redirect to a private address before making the second request', async () => {
    const fetchImpl = vi.fn<ReferenceFetch>(async () =>
      new Response(null, { headers: { location: 'http://[::1]/private.mp4' }, status: 302 }));
    const loader = createReferenceLoader({ fetchImpl, lookup: publicLookup() });

    await expect(loader.load('https://media.example/start', 'video')).rejects.toMatchObject({
      code: 'PRIVATE_ADDRESS',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('allows private references only when explicitly configured', async () => {
    const lookup = vi.fn<ReferenceLookup>();
    const fetchImpl = vi.fn<ReferenceFetch>(async () =>
      new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } }));
    const loader = createReferenceLoader({ allowPrivateUrls: true, fetchImpl, lookup });

    await expect(loader.load('http://127.0.0.1/reference.png', 'image')).resolves.toEqual({
      bytes: PNG_BYTES,
      filename: 'reference.png',
      mediaType: 'image/png',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('distinguishes a caller abort from its own timeout even when fetch ignores the signal', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<ReferenceFetch>(() => new Promise<Response>(() => undefined));
      const loader = createReferenceLoader({ fetchImpl, lookup: publicLookup(), timeoutMs: 25 });

      const timedOut = loader.load('https://media.example/slow.mp4', 'video');
      const timeoutAssertion = expect(timedOut).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(26);
      await timeoutAssertion;

      const controller = new AbortController();
      const aborted = loader.load('https://media.example/slow-again.mp4', 'video', controller.signal);
      controller.abort();
      await expect(aborted).rejects.toMatchObject({ code: 'ABORTED' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses fixed typed errors without leaking URL credentials or network error text', async () => {
    const secret = 'secret-never-leak';
    const loader = createReferenceLoader({
      fetchImpl: async () => {
        throw new Error(`upstream echoed ${secret}`);
      },
      lookup: publicLookup(),
    });

    const credentialError = await loader
      .load(`https://user:${secret}@media.example/file.png`, 'image')
      .catch((error: unknown) => error);
    expect(credentialError).toBeInstanceOf(ReferenceLoadError);
    expect(credentialError).toMatchObject({ code: 'URL_CREDENTIALS_NOT_ALLOWED' });
    expect(String(credentialError)).not.toContain(secret);
    expect(JSON.stringify(credentialError)).not.toContain(secret);

    const networkError = await loader
      .load('https://media.example/file.png', 'image')
      .catch((error: unknown) => error);
    expect(networkError).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(String(networkError)).not.toContain(secret);
    expect(JSON.stringify(networkError)).not.toContain(secret);
  });

  it('rejects unsupported schemes and excessive redirects with typed errors', async () => {
    const fetchImpl = vi.fn<ReferenceFetch>(async () =>
      new Response(null, { headers: { location: '/again' }, status: 307 }));
    const loader = createReferenceLoader({ fetchImpl, lookup: publicLookup(), maxRedirects: 0 });

    await expect(loader.load('file:///tmp/reference.png', 'image')).rejects.toMatchObject({
      code: 'UNSUPPORTED_SCHEME',
    });
    await expect(loader.load('https://media.example/start', 'video')).rejects.toMatchObject({
      code: 'REDIRECT_LIMIT_EXCEEDED',
    });
  });
});
