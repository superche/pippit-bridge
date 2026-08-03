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

function expectNoPpeHeaders(init: RequestInit | undefined): void {
  const headers = new Headers(init?.headers);
  expect(headers.has('x-tt-env')).toBe(false);
  expect(headers.has('x-use-ppe')).toBe(false);
}

function readSeedance25SkillRequest(init: RequestInit | undefined): {
  body: Record<string, unknown>
  params: Record<string, unknown>
} {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>
  expect(body.agent_name).toBe(PIPPIT_VIDEO_AGENT_NAME)
  return {
    body,
    params: body.video_part_tool_param as Record<string, unknown>,
  }
}

describe('PippitClient', () => {
  it('uses a 12-hour default request timeout', () => {
    expect(PIPPIT_DEFAULT_TIMEOUT_MS).toBe(43_200_000);
  });

  it('uploads bytes as multipart and returns the Pippit asset identity', async () => {
    const fetchImpl = vi.fn<PippitFetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('accept')).toBe('application/json');
      expect(headers.get('authorization')).toBe('Bearer ak-upload');
      expect(headers.has('content-type')).toBe(false);
      expectNoPpeHeaders(init);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');

      const form = init?.body as FormData;
      const file = form.get('file');
      expect(file).toBeInstanceOf(Blob);
      expect((file as File).name).toBe('reference.png');
      expect((file as Blob).type).toBe('image/png');
      expect(await (file as Blob).text()).toBe('image bytes');
      return jsonResponse({
        ret: '0',
        data: { asset_id: 'everphoto-1', pippit_asset_id: 'pippit-1' },
      });
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
    ).resolves.toEqual({
      assetId: 'pippit-1',
      asset_id: 'everphoto-1',
      pippit_asset_id: 'pippit-1',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://xyq.jianying.com/api/biz/v1/skill/upload_file',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('resolves generated video asset identities from the skill thread artifact', async () => {
    const fetchImpl = vi.fn<PippitFetch>(async (url, init) => {
      expect(url).toBe('https://xyq.jianying.com/api/biz/v1/skill/get_thread');
      expectNoPpeHeaders(init);
      expect(JSON.parse(String(init?.body))).toEqual({
        limit: 1,
        run_id: 'run-source',
        scopes: ['run_list.entry_list'],
        thread_id: 'thread-source',
      });
      return jsonResponse({
        ret: '0',
        data: {
          thread: {
            run_list: [{
              run_id: 'run-source',
              entry_list: [
                { message: { content: [{ data: 'ignored', sub_type: 'text/plain' }] } },
                {
                  artifact: {
                    content: [{
                      data: JSON.stringify({
                        video: {
                          asset_id: 'everphoto-source',
                          url: 'https://cdn.test/source.mp4',
                        },
                      }),
                      pippit_asset_id: 'pippit-source',
                      sub_type: 'biz/x_data_video',
                    }],
                  },
                },
              ],
            }],
          },
        },
      });
    });
    const client = new PippitClient({ fetchImpl });

    await expect(client.getVideoAssets({
      accessKey: 'ak-source',
      runId: 'run-source',
      threadId: 'thread-source',
    })).resolves.toEqual([{
      asset_id: 'everphoto-source',
      pippit_asset_id: 'pippit-source',
      url: 'https://cdn.test/source.mp4',
    }]);
  });

  it('submits the documented video-part request with the fixed agent name', async () => {
    const fetchImpl = vi.fn<PippitFetch>(async (url, init) => {
      expect(url).toBe('https://upstream.test/api/biz/v1/skill/submit_run');
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer ak-submit');
      expect(headers.get('content-type')).toBe('application/json');
      expectNoPpeHeaders(init);
      const { body, params } = readSeedance25SkillRequest(init)
      expect(body.thread_id).toBe('requested-thread')
      expect(body.asset_ids).toEqual(['asset-image'])
      expect(params).toEqual({
        audios: [],
        duration_sec: 10,
        images: [{ pippit_asset_id: 'asset-image' }],
        imitation_videos: [],
        language: 'zh',
        model: 'Seedance_2.5',
        prompt: 'a cat in the rain',
        ratio: '16:9',
        resolution: '720p',
        seed: 42,
        task_type: 'reference',
        videos: [],
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
            images: [{ pippit_asset_id: 'asset-image' }],
            model: 'Seedance_2.5',
            prompt: 'a cat in the rain',
            ratio: '16:9',
            resolution: '720p',
            seed: 42,
          },
          thread_id: 'requested-thread',
        },
      }),
    ).resolves.toEqual({
      run: { runId: 'run-1', threadId: 'thread-1', state: 1 },
      webThreadLink: 'https://xyq.jianying.com/thread/thread-1',
    });
  });

  it('adds the provider security scene to ordinary video references', async () => {
    const fetchImpl = vi.fn<PippitFetch>(async (_url, init) => {
      const { body, params } = readSeedance25SkillRequest(init)
      expect(body.asset_ids).toEqual(['pippit-source'])
      expect(params).toMatchObject({
        duration_sec: 10,
        model: 'seedance2.0_vision',
        videos: [{
          asset_id: 'everphoto-source',
          pippit_asset_id: 'pippit-source',
          security_check_scene: ['pippit_seedance2_0_user_input_video'],
        }],
      })
      expect(params).not.toHaveProperty('partial_edit_videos')
      return jsonResponse({
        ret: 0,
        data: { run: { run_id: 'run-edit-20', thread_id: 'thread-edit-20', state: 1 } },
      })
    })
    const client = new PippitClient({ fetchImpl })

    await expect(client.submitRun({
      accessKey: 'ak-edit-20',
      request: {
        asset_ids: [],
        message: 'reference-guided edit',
        video_part_tool_param: {
          duration_sec: 10,
          model: 'seedance2.0_vision',
          prompt: 'reference-guided edit',
          ratio: '16:9',
          videos: [{
            asset_id: 'everphoto-source',
            pippit_asset_id: 'pippit-source',
          }],
        },
      },
    })).resolves.toMatchObject({ run: { runId: 'run-edit-20' } })
  })

  it('adds the successful Seedance 2.5 curl fields while preserving the required skill ratio', async () => {
    const fetchImpl = vi.fn<PippitFetch>(async (_url, init) => {
      const { params } = readSeedance25SkillRequest(init)
      expect(params).toMatchObject({
        audios: [],
        duration_sec: 10,
        images: [],
        imitation_videos: [],
        language: 'zh',
        model: 'Seedance_2.5',
        prompt: 'ordinary generation',
        resolution: '720p',
        task_type: 'reference',
        videos: [],
      })
      expect(params.ratio).toBe('16:9')
      expect(params.seed).toEqual(expect.any(Number))
      expect(params.seed).toBeGreaterThanOrEqual(0)
      expect(params.seed).toBeLessThan(2 ** 32)
      return jsonResponse({
        ret: 0,
        data: { run: { run_id: 'run-25', thread_id: 'thread-25', state: 1 } },
      })
    })
    const client = new PippitClient({ fetchImpl })

    await expect(client.submitRun({
      accessKey: 'ak-seedance-25',
      request: {
        asset_ids: [],
        message: 'ordinary generation',
        video_part_tool_param: {
          duration_sec: 10,
          model: 'Seedance_2.5',
          prompt: 'ordinary generation',
          ratio: '16:9',
          resolution: '720p',
        },
      },
    })).resolves.toMatchObject({ run: { runId: 'run-25' } })
  })

  it('submits one native partial-edit video with an exact microsecond range', async () => {
    const fetchImpl = vi.fn<PippitFetch>(async (url, init) => {
      expect(url).toBe('https://xyq.jianying.com/api/biz/v1/skill/submit_run')
      const { body, params } = readSeedance25SkillRequest(init)
      expect(body.asset_ids).toEqual(['pippit-1'])
      expect(params).toMatchObject({
        audios: [],
        duration_sec: -1,
        images: [],
        imitation_videos: [],
        language: 'zh',
        partial_edit_videos: [{
          asset_id: 'everphoto-1',
          pippit_asset_id: 'pippit-1',
          security_check_scene: ['pippit_seedance2_0_user_input_video'],
          time_range: { end_time_us: 5_600_000, start_time_us: 1_200_000 },
        }],
        ratio: 'adaptive',
        seed: expect.any(Number),
        videos: [],
      })
      expect(params).not.toHaveProperty('task_type')
      return jsonResponse({
        ret: 0,
        data: { run: { run_id: 'run-edit', thread_id: 'thread-edit', state: 1 } },
      })
    })
    const client = new PippitClient({ fetchImpl })

    await expect(client.submitRun({
      accessKey: 'ak-edit',
      request: {
        asset_ids: [],
        message: 'partial edit',
        video_part_tool_param: {
          model: 'Seedance_2.5',
          partial_edit_videos: [{
            asset_id: 'everphoto-1',
            pippit_asset_id: 'pippit-1',
            time_range: { end_time_us: 5_600_000, start_time_us: 1_200_000 },
          }],
          prompt: 'partial edit',
        },
      },
    })).resolves.toMatchObject({ run: { runId: 'run-edit' } })
  })

  it('normalizes the source-segment sentinel only for native partial edits', async () => {
    const fetchImpl = vi.fn<PippitFetch>(async (_url, init) => {
      const { params } = readSeedance25SkillRequest(init)
      expect(params).toMatchObject({
        duration_sec: -1,
        ratio: 'adaptive',
        videos: [],
      })
      return jsonResponse({
        ret: 0,
        data: { run: { run_id: 'run-edit', thread_id: 'thread-edit', state: 1 } },
      })
    })
    const client = new PippitClient({ fetchImpl })

    await expect(client.submitRun({
      accessKey: 'ak-edit',
      request: {
        asset_ids: [],
        message: 'partial edit',
        video_part_tool_param: {
          duration_sec: 4.4,
          model: 'Seedance_2.5',
          partial_edit_videos: [{
            asset_id: 'everphoto-1',
            pippit_asset_id: 'pippit-1',
            time_range: { end_time_us: 5_600_000, start_time_us: 1_200_000 },
          }],
          prompt: 'partial edit',
        },
      },
    })).resolves.toMatchObject({ run: { runId: 'run-edit' } })

    await expect(client.submitRun({
      accessKey: 'ak-generate',
      request: {
        asset_ids: [],
        message: 'ordinary generation',
        video_part_tool_param: {
          duration_sec: -1,
          model: 'Seedance_2.0_mini',
          prompt: 'ordinary generation',
        },
      },
    })).rejects.toMatchObject({ code: 'INVALID_INPUT', operation: 'submit_run' })

    await expect(client.submitRun({
      accessKey: 'ak-edit',
      request: {
        asset_ids: [],
        message: 'partial edit without cloud identity',
        video_part_tool_param: {
          duration_sec: -1,
          model: 'Seedance_2.0',
          partial_edit_videos: [{
            asset_id: '',
            pippit_asset_id: 'pippit-1',
            time_range: { end_time_us: 4_000_000, start_time_us: 0 },
          }],
          prompt: 'partial edit without cloud identity',
        },
      },
    })).rejects.toMatchObject({ code: 'INVALID_INPUT', operation: 'submit_run' })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not add Seedance 2.5 protocol fields to other video models', async () => {
    const fetchImpl = vi.fn<PippitFetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        agent_name: PIPPIT_VIDEO_AGENT_NAME,
        asset_ids: [],
        message: 'legacy video',
        video_part_tool_param: {
          duration_sec: 8,
          model: 'Seedance_2.0_mini',
          prompt: 'legacy video',
          resolution: '720p',
        },
      })
      return jsonResponse({
        ret: 0,
        data: { run: { run_id: 'run-legacy', thread_id: 'thread-legacy', state: 1 } },
      })
    })
    const client = new PippitClient({ fetchImpl })

    await expect(client.submitRun({
      accessKey: 'ak-legacy',
      request: {
        asset_ids: [],
        message: 'legacy video',
        video_part_tool_param: {
          duration_sec: 8,
          model: 'Seedance_2.0_mini',
          prompt: 'legacy video',
          resolution: '720p',
        },
      },
    })).resolves.toMatchObject({ run: { runId: 'run-legacy' } })
  })

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
      expectNoPpeHeaders(init);
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

  it('emits redacted Seedance request diagnostics with upstream correlation fields', async () => {
    const events: unknown[] = []
    const logId = '20260730174415A1B2C3D4E5F6071829AB'
    const client = new PippitClient({
      diagnostics: event => { events.push(event) },
      fetchImpl: async () => new Response(JSON.stringify({
        data: { run: { run_id: 'run-1', state: 0, thread_id: 'thread-1' } },
        ret: 0,
      }), {
        headers: { 'content-type': 'application/json', 'x-tt-logid': logId },
        status: 200,
      }),
    })

    await client.submitRun({
      accessKey: 'ak-must-never-appear',
      request: {
        asset_ids: [],
        message: 'prompt-must-never-appear',
        video_part_tool_param: {
          duration_sec: 8,
          model: 'Seedance_2.5',
          prompt: 'prompt-must-never-appear',
          ratio: '16:9',
          resolution: '720p',
        },
      },
    })

    expect(events).toHaveLength(2)
    expect(events).toEqual([
      expect.objectContaining({
        event: 'upstream_request_started',
        operation: 'submit_run',
        params: expect.objectContaining({
          duration_sec: 8,
          model: 'Seedance_2.5',
          prompt_length: 24,
          ratio: '16:9',
          resolution: '720p',
          seed_present: true,
        }),
        path: '/api/biz/v1/skill/submit_run',
      }),
      expect.objectContaining({
        event: 'upstream_response_received',
        http_status: 200,
        upstream_code: 0,
        upstream_log_id: logId,
      }),
    ])
    expect(JSON.stringify(events)).not.toContain('ak-must-never-appear')
    expect(JSON.stringify(events)).not.toContain('prompt-must-never-appear')
  })

  it('emits a bounded redacted upstream business message for diagnosis', async () => {
    const events: unknown[] = []
    const client = new PippitClient({
      diagnostics: event => { events.push(event) },
      fetchImpl: async () => jsonResponse({
        data: {},
        errmsg: 'missing ratio; ak-secret and prompt-secret must not escape',
        ret: '2',
      }),
    })

    await expect(client.submitRun({
      accessKey: 'ak-secret',
      request: {
        asset_ids: [],
        message: 'prompt-secret',
        video_part_tool_param: {
          model: 'Seedance_2.5',
          prompt: 'prompt-secret',
          ratio: '16:9',
          resolution: '720p',
        },
      },
    })).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', upstreamCode: '2' })

    expect(events).toHaveLength(2)
    expect(events[1]).toEqual(expect.objectContaining({
      event: 'upstream_response_received',
      upstream_code: '2',
      upstream_message: 'missing ratio; <redacted> and <redacted> must not escape',
    }))
    expect(JSON.stringify(events)).not.toContain('ak-secret')
    expect(JSON.stringify(events)).not.toContain('prompt-secret')
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
