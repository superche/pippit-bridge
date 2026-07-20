import { PippitApiError, type PippitOperation } from "./errors.js"
import {
  PIPPIT_RUN_STATES,
  PIPPIT_VIDEO_AGENT_NAME,
  type PippitApi,
  type PippitClientConfig,
  type PippitFailReason,
  type PippitFailReasonObject,
  type PippitFetch,
  type PippitRunState,
  type PippitSubmitRunRequest,
  type PippitSubmitRunResult,
  type PippitUploadResult,
  type PippitVideoResult,
  type QueryVideoResultInput,
  type SubmitRunInput,
  type UploadFileInput,
} from './types.js';

export const PIPPIT_DEFAULT_BASE_URL = 'https://xyq.jianying.com';
export const PIPPIT_DEFAULT_TIMEOUT_MS = 12 * 60 * 60 * 1_000;

const ABORT_SENTINEL = Symbol('PIPPIT_REQUEST_ABORTED');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRunState(value: unknown): value is PippitRunState {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (PIPPIT_RUN_STATES as readonly number[]).includes(value)
  );
}

function invalidResponse(operation: PippitOperation): PippitApiError {
  return new PippitApiError({ code: 'INVALID_RESPONSE', operation });
}

function sanitizeUpstreamCode(
  value: string | number,
  accessKey: string,
): string | number | undefined {
  if (typeof value === 'number') {
    return String(value).includes(accessKey) ? undefined : value;
  }
  const sanitized = value.split(accessKey).join('<redacted>');
  return sanitized.includes(accessKey) ? undefined : sanitized;
}

function readEnvelopeData(
  value: unknown,
  operation: PippitOperation,
  accessKey: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidResponse(operation);
  }

  const ret = value.ret;
  if (typeof ret !== 'string' && typeof ret !== 'number') {
    throw invalidResponse(operation);
  }
  if (ret !== 0 && ret !== '0') {
    const upstreamCode = sanitizeUpstreamCode(ret, accessKey);
    throw new PippitApiError({
      code: 'UPSTREAM_ERROR',
      operation,
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
    });
  }
  if (!isRecord(value.data)) {
    throw invalidResponse(operation);
  }
  return value.data;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  operation: PippitOperation,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!isNonEmptyString(value)) {
    throw invalidResponse(operation);
  }
  return value;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
  operation: PippitOperation,
): string[] {
  const value = record[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    throw invalidResponse(operation);
  }
  return [...value];
}

function readOptionalStringField(
  record: Record<string, unknown>,
  key: string,
  operation: PippitOperation,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalidResponse(operation);
  }
  return value;
}

function parseStringMap(
  value: unknown,
  operation: PippitOperation,
): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value) || !Object.values(value).every((item) => typeof item === 'string')) {
    throw invalidResponse(operation);
  }
  return { ...value } as Record<string, string>;
}

function parseFailReason(
  value: unknown,
  operation: PippitOperation,
): PippitFailReason | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (!isRecord(value)) {
    throw invalidResponse(operation);
  }

  const result: PippitFailReasonObject = {};
  if (value.code !== undefined && value.code !== null) {
    if (typeof value.code !== 'number' || !Number.isFinite(value.code)) {
      throw invalidResponse(operation);
    }
    result.code = value.code;
  }
  if (value.is_not_retryable !== undefined && value.is_not_retryable !== null) {
    if (typeof value.is_not_retryable !== 'boolean') {
      throw invalidResponse(operation);
    }
    result.is_not_retryable = value.is_not_retryable;
  }

  const extra = parseStringMap(value.extra, operation);
  if (extra !== undefined) {
    result.extra = extra;
  }

  for (const key of [
    'message',
    'starling_key',
    'payload',
    'fallback_message',
    'detail',
  ] as const) {
    const field = readOptionalStringField(value, key, operation);
    if (field !== undefined) {
      result[key] = field;
    }
  }
  return result;
}

function normalizeAccessKey(accessKey: string, operation: PippitOperation): string {
  if (!isNonEmptyString(accessKey)) {
    throw new PippitApiError({ code: 'INVALID_INPUT', operation });
  }
  const normalized = accessKey.trim();
  if (!/^[\x21-\x7e]+$/.test(normalized)) {
    throw new PippitApiError({ code: 'INVALID_INPUT', operation });
  }
  return normalized;
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isMediaReference(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.pippit_asset_id)) {
    return false;
  }
  if (
    !isOptionalNonEmptyString(value.asset_id) ||
    !isOptionalNonEmptyString(value.url)
  ) {
    return false;
  }
  return (
    value.security_check_scene === undefined ||
    (Array.isArray(value.security_check_scene) &&
      value.security_check_scene.every(isNonEmptyString))
  );
}

function validateSubmitRequest(
  value: PippitSubmitRunRequest,
  operation: PippitOperation,
): void {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.message) ||
    !Array.isArray(value.asset_ids) ||
    !value.asset_ids.every(isNonEmptyString) ||
    !isOptionalNonEmptyString(value.thread_id) ||
    !isRecord(value.video_part_tool_param)
  ) {
    throw new PippitApiError({ code: 'INVALID_INPUT', operation });
  }

  const params = value.video_part_tool_param;
  if (
    !isNonEmptyString(params.model) ||
    !isNonEmptyString(params.prompt) ||
    typeof params.duration_sec !== 'number' ||
    !Number.isFinite(params.duration_sec) ||
    params.duration_sec <= 0 ||
    !isOptionalNonEmptyString(params.ratio) ||
    !isOptionalNonEmptyString(params.resolution) ||
    (params.generate_type !== undefined &&
      params.generate_type !== 0 &&
      params.generate_type !== 1) ||
    (params.seed !== undefined && !Number.isSafeInteger(params.seed))
  ) {
    throw new PippitApiError({ code: 'INVALID_INPUT', operation });
  }

  for (const key of ['images', 'videos', 'audios'] as const) {
    const references = params[key];
    if (
      references !== undefined &&
      (!Array.isArray(references) || !references.every(isMediaReference))
    ) {
      throw new PippitApiError({ code: 'INVALID_INPUT', operation });
    }
  }
}

function stringifyJson(value: unknown, operation: PippitOperation): string {
  try {
    const result = JSON.stringify(value);
    if (typeof result === 'string') {
      return result;
    }
  } catch {
    // The fixed typed error below intentionally discards the serialization cause.
  }
  throw new PippitApiError({ code: 'INVALID_INPUT', operation });
}

function validateConfig(config: PippitClientConfig): {
  baseUrl: string;
  fetchImpl: PippitFetch;
  timeoutMs: number;
} {
  const operation = 'client';
  const timeoutMs = config.timeoutMs ?? PIPPIT_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new PippitApiError({ code: 'INVALID_INPUT', operation });
  }

  let url: URL;
  try {
    url = new URL(config.baseUrl ?? PIPPIT_DEFAULT_BASE_URL);
  } catch {
    throw new PippitApiError({ code: 'INVALID_INPUT', operation });
  }
  const localDevelopmentHttp =
    url.protocol === 'http:' && new Set(['127.0.0.1', '::1', 'localhost']).has(url.hostname);
  if ((url.protocol !== 'https:' && !localDevelopmentHttp) || url.username || url.password) {
    throw new PippitApiError({ code: 'INVALID_INPUT', operation });
  }
  url.search = '';
  url.hash = '';

  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new PippitApiError({ code: 'INVALID_INPUT', operation });
  }

  return {
    baseUrl: url.toString().replace(/\/+$/, ''),
    fetchImpl,
    timeoutMs,
  };
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
    const data = readEnvelopeData(response, operation, accessKey);
    if (!isNonEmptyString(data.pippit_asset_id)) {
      throw invalidResponse(operation);
    }
    return { assetId: data.pippit_asset_id };
  }

  async submitRun(input: SubmitRunInput): Promise<PippitSubmitRunResult> {
    const operation = 'submit_run';
    const accessKey = normalizeAccessKey(input.accessKey, operation);
    validateSubmitRequest(input.request, operation);
    const response = await this.requestJson(
      operation,
      '/api/biz/v1/skill/submit_run',
      accessKey,
      {
        body: stringifyJson({
          ...input.request,
          agent_name: PIPPIT_VIDEO_AGENT_NAME,
        }, operation),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      },
      input.signal,
    );
    const data = readEnvelopeData(response, operation, accessKey);
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
    const data = readEnvelopeData(response, operation, accessKey);
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
  ): Promise<unknown> {
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
      if (!response.ok) {
        throw new PippitApiError({
          code: 'HTTP_ERROR',
          operation,
          status: response.status,
        });
      }
      try {
        return (await response.json()) as unknown;
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
