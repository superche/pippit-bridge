import { PippitApiError, type PippitOperation } from "./errors.js"
import {
  PIPPIT_IMAGE_AGENT_NAME,
  PIPPIT_VIDEO_AGENT_NAME,
  type PippitApi,
  type PippitClientConfig,
  type PippitFetch,
  type PippitSubmitRunResult,
  type PippitUploadResult,
  type PippitVideoResult,
  type QueryVideoResultInput,
  type SubmitRunInput,
  type UploadFileInput,
} from './types.js';
import {
  invalidResponse,
  isNonEmptyString,
  isRecord,
  isRunState,
  normalizeAccessKey,
  parseFailReason,
  readEnvelopeData,
  readOptionalString,
  readStringArray,
  stringifyJson,
  validateConfig,
  validateSubmitRequest,
} from "./client-validation.js"

export { PIPPIT_DEFAULT_BASE_URL, PIPPIT_DEFAULT_TIMEOUT_MS } from "./client-validation.js"

const ABORT_SENTINEL = Symbol('PIPPIT_REQUEST_ABORTED');

interface PippitJsonResponse {
  readonly body: unknown;
  readonly logId?: string;
}

function readResponseLogId(response: Response): string | undefined {
  const value = response.headers.get('x-tt-logid')?.trim();
  return value !== undefined && /^[A-Za-z0-9_-]{8,128}$/u.test(value) ? value : undefined;
}

export class PippitClient implements PippitApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: PippitFetch;
  private readonly timeoutMs: number;

  constructor(config: PippitClientConfig = {}) {
    const validated = validateConfig(config);
    this.baseUrl = validated.baseUrl;
    this.fetchImpl = validated.fetchImpl;
    this.timeoutMs = validated.timeoutMs;
  }

  async uploadFile(input: UploadFileInput): Promise<PippitUploadResult> {
    const operation = 'upload_file';
    const accessKey = normalizeAccessKey(input.accessKey, operation);
    if (
      !(input.file.bytes instanceof Uint8Array) ||
      !isNonEmptyString(input.file.filename) ||
      !isNonEmptyString(input.file.mediaType)
    ) {
      throw new PippitApiError({ code: 'INVALID_INPUT', operation });
    }

    const form = new FormData();
    form.append(
      'file',
      new Blob([input.file.bytes as Uint8Array<ArrayBuffer>], { type: input.file.mediaType.trim() }),
      input.file.filename,
    );

    const response = await this.requestJson(
      operation,
      '/api/biz/v1/skill/upload_file',
      accessKey,
      { body: form, method: 'POST' },
      input.signal,
    );
    const data = readEnvelopeData(response.body, operation, accessKey, response.logId);
    if (!isNonEmptyString(data.pippit_asset_id)) {
      throw invalidResponse(operation);
    }
    return { assetId: data.pippit_asset_id };
  }

  async submitRun(input: SubmitRunInput): Promise<PippitSubmitRunResult> {
    const operation = 'submit_run';
    const accessKey = normalizeAccessKey(input.accessKey, operation);
    validateSubmitRequest(input.request, operation);
    const agentName = 'general_agent_settings' in input.request
      ? PIPPIT_IMAGE_AGENT_NAME
      : PIPPIT_VIDEO_AGENT_NAME;
    const response = await this.requestJson(
      operation,
      '/api/biz/v1/skill/submit_run',
      accessKey,
      {
        body: stringifyJson({
          ...input.request,
          agent_name: agentName,
        }, operation),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      },
      input.signal,
    );
    const data = readEnvelopeData(response.body, operation, accessKey, response.logId);
    if (!isRecord(data.run)) {
      throw invalidResponse(operation);
    }

    const { run } = data;
    if (
      !isNonEmptyString(run.run_id) ||
      !isNonEmptyString(run.thread_id) ||
      !isRunState(run.state)
    ) {
      throw invalidResponse(operation);
    }

    const result: PippitSubmitRunResult = {
      run: {
        runId: run.run_id,
        threadId: run.thread_id,
        state: run.state,
      },
    };
    const webThreadLink = readOptionalString(data, 'web_thread_link', operation);
    if (webThreadLink !== undefined) {
      result.webThreadLink = webThreadLink;
    }
    return result;
  }

  async queryVideoResult(input: QueryVideoResultInput): Promise<PippitVideoResult> {
    const operation = 'query_generate_video_result';
    const accessKey = normalizeAccessKey(input.accessKey, operation);
    if (!isNonEmptyString(input.threadId) || !isNonEmptyString(input.runId)) {
      throw new PippitApiError({ code: 'INVALID_INPUT', operation });
    }

    const response = await this.requestJson(
      operation,
      '/api/biz/v1/agent/query_generate_video_result',
      accessKey,
      {
        body: stringifyJson(
          {
            thread_id: input.threadId.trim(),
            run_id: input.runId.trim(),
          },
          operation,
        ),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      },
      input.signal,
    );
    const data = readEnvelopeData(response.body, operation, accessKey, response.logId);
    if (!isRunState(data.run_state)) {
      throw invalidResponse(operation);
    }

    const result: PippitVideoResult = {
      runState: data.run_state,
      videoUrls: readStringArray(data, 'video_urls', operation),
      imageUrls: readStringArray(data, 'image_urls', operation),
    };
    const failReason = parseFailReason(data.fail_reason, operation);
    if (failReason !== undefined) {
      result.failReason = failReason;
    }
    return result;
  }

  private async requestJson(
    operation: PippitOperation,
    path: string,
    accessKey: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
  ): Promise<PippitJsonResponse> {
    if (externalSignal?.aborted) {
      throw new PippitApiError({ code: 'ABORTED', operation });
    }

    const controller = new AbortController();
    let externallyAborted = false;
    let timedOut = false;
    let rejectAbort: ((reason: typeof ABORT_SENTINEL) => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onControllerAbort = () => rejectAbort?.(ABORT_SENTINEL);
    controller.signal.addEventListener('abort', onControllerAbort, { once: true });

    const onExternalAbort = () => {
      externallyAborted = true;
      controller.abort();
    };
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    headers.set('authorization', `Bearer ${accessKey}`);
    const requestPromise = Promise.resolve().then(async () => {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        redirect: 'error',
        signal: controller.signal,
      });
      const logId = readResponseLogId(response);
      if (!response.ok) {
        throw new PippitApiError({
          code: 'HTTP_ERROR',
          ...(logId === undefined ? {} : { logId }),
          operation,
          status: response.status,
        });
      }
      try {
        return {
          body: (await response.json()) as unknown,
          ...(logId === undefined ? {} : { logId }),
        };
      } catch {
        if (controller.signal.aborted) {
          throw ABORT_SENTINEL;
        }
        throw invalidResponse(operation);
      }
    });

    try {
      return await Promise.race([requestPromise, abortPromise]);
    } catch (error) {
      if (error instanceof PippitApiError) {
        throw error;
      }
      if (timedOut) {
        throw new PippitApiError({ code: 'TIMEOUT', operation });
      }
      if (externallyAborted || externalSignal?.aborted) {
        throw new PippitApiError({ code: 'ABORTED', operation });
      }
      throw new PippitApiError({ code: 'NETWORK_ERROR', operation });
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onControllerAbort);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
