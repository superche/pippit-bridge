import { describe, expect, it, vi } from "vitest"

import {
  PIPPIT_DEFAULT_TIMEOUT_MS,
  PIPPIT_IMAGE_AGENT_NAME,
  PIPPIT_VIDEO_AGENT_NAME,
  PippitApiError,
  PippitClient,
  type PippitFetch,
} from "../src/index.js"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

describe('PippitClient', () => {
  it('uses a 12-hour default request timeout', () => {
    expect(PIPPIT_DEFAULT_TIMEOUT_MS).toBe(43_200_000);
  });

  it('uploads bytes as multipart and returns the pippit asset id', async () => {
    const fetchImpl = vi.fn<PippitFetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('accept')).toBe('application/json');
      expect(headers.get('authorization')).toBe('Bearer ak-upload');
      expect(headers.has('content-type')).toBe(false);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');

      const form = init?.body as FormData;
      const file = form.get('file');
      expect(file).toBeInstanceOf(Blob);
      expect((file as File).name).toBe('reference.png');
      expect((file as Blob).type).toBe('image/png');
      expect(await (file as Blob).text()).toBe('image bytes');
      return jsonResponse({ ret: '0', data: { pippit_asset_id: 'asset-1' } });
    });
    const client = new PippitClient({ fetchImpl });

    await expect(
      client.uploadFile({
        accessKey: 'ak-upload',
        file: {
          bytes: new TextEncoder().encode('image bytes'),
          filename: 'reference.png',
          mediaType: 'image/png',
        },
      }),
    ).resolves.toEqual({ assetId: 'asset-1' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://xyq.jianying.com/api/biz/v1/skill/upload_file',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('submits the documented video-part request with the fixed agent name', async () => {
    const fetchImpl = vi.fn<PippitFetch>(async (url, init) => {
      expect(url).toBe('https://upstream.test/api/biz/v1/skill/submit_run');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ak-submit');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toEqual({
        message: 'make a short film',
        asset_ids: ['asset-image'],
        video_part_tool_param: {
          model: 'seedance-2',
          duration_sec: 5,
          prompt: 'a cat in the rain',
          ratio: '16:9',
          seed: 42,
          images: [{ pippit_asset_id: 'asset-image' }],
        },
        thread_id: 'requested-thread',
        agent_name: PIPPIT_VIDEO_AGENT_NAME,
      });
      return jsonResponse({
        ret: 0,
        data: {
          run: { run_id: 'run-1', thread_id: 'thread-1', state: 1 },
          web_thread_link: 'https://xyq.jianying.com/thread/thread-1',
        },
      });
    });
    const client = new PippitClient({ baseUrl: 'https://upstream.test/', fetchImpl });

    await expect(
      client.submitRun({
        accessKey: 'ak-submit',
        request: {
          message: 'make a short film',
          asset_ids: ['asset-image'],
          video_part_tool_param: {
            model: 'seedance-2',
            duration_sec: 5,
            prompt: 'a cat in the rain',
            ratio: '16:9',
            seed: 42,
            images: [{ pippit_asset_id: 'asset-image' }],
          },
          thread_id: 'requested-thread',
        },
      }),
    ).resolves.toEqual({
      run: { runId: 'run-1', threadId: 'thread-1', state: 1 },
      webThreadLink: 'https://xyq.jianying.com/thread/thread-1',
    });
  });

  it('submits Seedream image runs with the Nest agent and model-specific resolution rules', async () => {
    const fetchImpl = vi.fn<PippitFetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        agent_name: PIPPIT_IMAGE_AGENT_NAME,
        asset_ids: ['asset-image'],
        general_agent_settings: {
          generate_image_count: 2,
          image_model: 'seedream_5.0_pro',
          resolution: '4K',
        },
        message: 'Create two product images',
      })
      return jsonResponse({
        ret: '0',
        data: { run: { run_id: 'image-run', thread_id: 'image-thread', state: 1 } },
      })
    })
    const client = new PippitClient({ fetchImpl })

    await expect(client.submitRun({
      accessKey: 'ak-image',
      request: {
        asset_ids: ['asset-image'],
        general_agent_settings: {
          generate_image_count: 2,
          image_model: 'seedream_5.0_pro',
          resolution: '4K',
        },
        message: 'Create two product images',
      },
    })).resolves.toMatchObject({ run: { runId: 'image-run', threadId: 'image-thread' } })

    await expect(client.submitRun({
      accessKey: 'ak-image',
      request: {
        general_agent_settings: { image_model: 'seedream_5.0', resolution: '2K' },
        message: 'This must fail locally',
      },
    })).rejects.toMatchObject({ code: 'INVALID_INPUT', operation: 'submit_run' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('queries generated media and parses a structured failure reason', async () => {
    const fetchImpl = vi.fn<PippitFetch>(async (url, init) => {
      expect(url).toBe(
        'https://xyq.jianying.com/api/biz/v1/agent/query_generate_video_result',
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        thread_id: 'thread-1',
        run_id: 'run-1',
      });
      return jsonResponse({
        ret: '0',
        data: {
          run_state: 4,
          video_urls: [],
          image_urls: ['https://cdn.test/poster.jpg'],
          fail_reason: {
            code: 4001,
            message: 'generation rejected',
            is_not_retryable: true,
          },
        },
      });
    });
    const client = new PippitClient({ fetchImpl });

    await expect(
      client.queryVideoResult({
        accessKey: 'ak-query',
        threadId: 'thread-1',
        runId: 'run-1',
      }),
    ).resolves.toEqual({
      runState: 4,
      videoUrls: [],
      imageUrls: ['https://cdn.test/poster.jpg'],
      failReason: {
        code: 4001,
        message: 'generation rejected',
        is_not_retryable: true,
      },
    });
  });

  it('accepts the nullable fail_reason shape returned by current pippit-cn', async () => {
    const client = new PippitClient({
      fetchImpl: async () =>
        jsonResponse({
          ret: 0,
          data: {
            fail_reason: {
              code: null,
              detail: null,
              fallback_message: null,
              is_not_retryable: null,
              message: null,
            },
            image_urls: [],
            run_state: 3,
            video_urls: ['https://cdn.test/video.mp4'],
          },
        }),
    });

    await expect(
      client.queryVideoResult({ accessKey: 'ak-test', runId: 'run-1', threadId: 'thread-1' }),
    ).resolves.toEqual({
      failReason: {},
      imageUrls: [],
      runState: 3,
      videoUrls: ['https://cdn.test/video.mp4'],
    });
  });

  it('rejects cleartext remote Pippit origins but permits local HTTP development', () => {
    expect(() => new PippitClient({ baseUrl: 'http://upstream.test' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT', operation: 'client' }),
    );
    expect(() => new PippitClient({ baseUrl: 'http://127.0.0.1:3001' })).not.toThrow();
  });

  it('rejects malformed success responses with a typed error', async () => {
    const client = new PippitClient({
      fetchImpl: async () => jsonResponse({ ret: 0, data: { run: { run_id: 'run-1' } } }),
    });

    await expect(
      client.submitRun({
        accessKey: 'ak-test',
        request: {
          message: 'test',
          asset_ids: [],
          video_part_tool_param: { model: 'model', duration_sec: 5, prompt: 'test' },
        },
      }),
    ).rejects.toMatchObject({
      name: 'PippitApiError',
      code: 'INVALID_RESPONSE',
      operation: 'submit_run',
    });
  });

  it('rejects reference media that has not been uploaded to a pippit asset', async () => {
    const fetchImpl = vi.fn<PippitFetch>();
    const client = new PippitClient({ fetchImpl });

    await expect(
      client.submitRun({
        accessKey: 'ak-test',
        request: {
          message: 'test',
          asset_ids: [],
          video_part_tool_param: {
            model: 'model',
            duration_sec: 5,
            prompt: 'test',
            images: [{ pippit_asset_id: '' }],
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', operation: 'submit_run' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never exposes the access key through upstream or network errors', async () => {
    const accessKey = 'ak-secret-never-leak';
    const businessClient = new PippitClient({
      fetchImpl: async () =>
        jsonResponse({ ret: `denied:${accessKey}`, errmsg: `echo ${accessKey}`, data: {} }),
    });

    let businessError: unknown;
    try {
      await businessClient.queryVideoResult({
        accessKey,
        threadId: 'thread-1',
        runId: 'run-1',
      });
    } catch (error) {
      businessError = error;
    }
    expect(businessError).toBeInstanceOf(PippitApiError);
    expect(String(businessError)).not.toContain(accessKey);
    expect(JSON.stringify(businessError)).not.toContain(accessKey);

    const networkClient = new PippitClient({
      fetchImpl: async () => {
        throw new Error(`network failed with ${accessKey}`);
      },
    });
    let networkError: unknown;
    try {
      await networkClient.queryVideoResult({
        accessKey,
        threadId: 'thread-1',
        runId: 'run-1',
      });
    } catch (error) {
      networkError = error;
    }
    expect(networkError).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(String(networkError)).not.toContain(accessKey);
    expect(JSON.stringify(networkError)).not.toContain(accessKey);
  });

  it('retains only a safe Pippit log id on upstream errors', async () => {
    const safeLogId = '20260722163045A1B2C3D4E5F6071829AB'
    const safeClient = new PippitClient({
      fetchImpl: async () => new Response(JSON.stringify({ ret: 2, data: {} }), {
        headers: { 'content-type': 'application/json', 'x-tt-logid': safeLogId },
        status: 200,
      }),
    })
    await expect(safeClient.queryVideoResult({
      accessKey: 'ak-test',
      runId: 'run-1',
      threadId: 'thread-1',
    })).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      logId: safeLogId,
      operation: 'query_generate_video_result',
      upstreamCode: 2,
    })

    const unsafeClient = new PippitClient({
      fetchImpl: async () => new Response(JSON.stringify({ ret: 2, data: {} }), {
        headers: { 'content-type': 'application/json', 'x-tt-logid': 'unsafe log id' },
        status: 200,
      }),
    })
    const error = await unsafeClient.queryVideoResult({
      accessKey: 'ak-test',
      runId: 'run-1',
      threadId: 'thread-1',
    }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', upstreamCode: 2 })
    expect((error as PippitApiError).logId).toBeUndefined()
  })

  it('times out even when an injected fetch implementation ignores abort', async () => {
    vi.useFakeTimers();
    try {
      const client = new PippitClient({
        fetchImpl: () => new Promise<Response>(() => undefined),
        timeoutMs: 25,
      });
      const pending = client.queryVideoResult({
        accessKey: 'ak-timeout',
        threadId: 'thread-1',
        runId: 'run-1',
      });

      const assertion = expect(pending).rejects.toMatchObject({
        code: 'TIMEOUT',
        operation: 'query_generate_video_result',
      });
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps caller cancellation separately from timeout', async () => {
    const abortController = new AbortController();
    const client = new PippitClient({
      fetchImpl: () => new Promise<Response>(() => undefined),
    });
    const pending = client.queryVideoResult({
      accessKey: 'ak-abort',
      threadId: 'thread-1',
      runId: 'run-1',
      signal: abortController.signal,
    });

    abortController.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'ABORTED',
      operation: 'query_generate_video_result',
    });
  });
});
