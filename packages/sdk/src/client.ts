import { PippitApiError, type PippitOperation } from "./errors.js"
import {
  PIPPIT_IMAGE_AGENT_NAME,
  PIPPIT_VIDEO_AGENT_NAME,
  type PippitApi,
  type PippitClientConfig,
  type PippitDiagnosticEvent,
  type PippitDiagnosticSink,
  type PippitFetch,
  type PippitVideoAsset,
  type PippitSubmitRunResult,
  type PippitUploadResult,
  type PippitVideoResult,
  type GetVideoAssetsInput,
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
import {
  normalizeSubmitRunRequest,
} from "./submit-run-normalization.js"

export { PIPPIT_DEFAULT_BASE_URL, PIPPIT_DEFAULT_TIMEOUT_MS } from "./client-validation.js"

const ABORT_SENTINEL = Symbol('PIPPIT_REQUEST_ABORTED');
interface PippitJsonResponse {
  readonly body: unknown;
  readonly logId?: string;
}

interface PippitRequestDiagnostics {
  readonly params?: Readonly<Record<string, boolean | number | string>>;
  readonly redactions?: readonly string[];
}

type PippitRequestOperation = Exclude<PippitOperation, 'client'>;

function parseVideoArtifactPart(part: unknown): PippitVideoAsset | undefined {
  if (
    !isRecord(part) ||
    part.sub_type !== 'biz/x_data_video' ||
    !isNonEmptyString(part.data) ||
    !isNonEmptyString(part.pippit_asset_id)
  ) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(part.data) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(payload) || !isRecord(payload.video)) return undefined;
  const { video } = payload;
  if (!isNonEmptyString(video.asset_id) || !isNonEmptyString(video.url)) return undefined;
  return {
    asset_id: video.asset_id,
    pippit_asset_id: part.pippit_asset_id,
    url: video.url,
  };
}

function readVideoAssets(data: Record<string, unknown>, runId: string): readonly PippitVideoAsset[] {
  if (!isRecord(data.thread) || !Array.isArray(data.thread.run_list)) return [];
  const assets: PippitVideoAsset[] = [];
  for (const run of data.thread.run_list) {
    if (!isRecord(run) || run.run_id !== runId || !Array.isArray(run.entry_list)) continue;
    for (const entry of run.entry_list) {
      if (!isRecord(entry) || !isRecord(entry.artifact) || !Array.isArray(entry.artifact.content)) continue;
      for (const part of entry.artifact.content) {
        const asset = parseVideoArtifactPart(part);
        if (asset !== undefined) assets.push(asset);
      }
    }
  }
  return assets;
}

function readResponseLogId(response: Response): string | undefined {
  const value = response.headers.get('x-tt-logid')?.trim();
  return value !== undefined && /^[A-Za-z0-9_-]{8,128}$/u.test(value) ? value : undefined;
}

function readSafeUpstreamMessage(
  body: unknown,
  accessKey: string,
  redactions: readonly string[] = [],
): string | undefined {
  if (!isRecord(body) || typeof body.errmsg !== 'string') return undefined;
  let value = body.errmsg.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  for (const secret of [accessKey, ...redactions]) {
    if (secret.length > 0) value = value.split(secret).join('<redacted>');
  }
  if (value.length === 0) return undefined;
  return value.slice(0, 300);
}

export class PippitClient implements PippitApi {
  private readonly baseUrl: string;
  private readonly diagnostics: PippitDiagnosticSink | undefined;
  private readonly fetchImpl: PippitFetch;
  private readonly timeoutMs: number;

  constructor(config: PippitClientConfig = {}) {
    const validated = validateConfig(config);
    this.baseUrl = validated.baseUrl;
    this.diagnostics = validated.diagnostics;
    this.fetchImpl = validated.fetchImpl;
    this.timeoutMs = validated.timeoutMs;
  }

  async getVideoAssets(input: GetVideoAssetsInput): Promise<readonly PippitVideoAsset[]> {
    const operation = 'get_thread';
    const accessKey = normalizeAccessKey(input.accessKey, operation);
    if (!isNonEmptyString(input.threadId) || !isNonEmptyString(input.runId)) {
      throw new PippitApiError({ code: 'INVALID_INPUT', operation });
    }
    const response = await this.requestJson(
      operation,
      '/api/biz/v1/skill/get_thread',
      accessKey,
      {
        body: stringifyJson(
          {
            limit: 1,
            run_id: input.runId.trim(),
            scopes: ['run_list.entry_list'],
            thread_id: input.threadId.trim(),
          },
          operation,
        ),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      },
      input.signal,
      { params: { run_entry_list: true } },
    );
    const data = readEnvelopeData(response.body, operation, accessKey, response.logId);
    return readVideoAssets(data, input.runId.trim());
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
    const assetId = readOptionalString(data, 'asset_id', operation);
    return {
      assetId: data.pippit_asset_id,
      ...(assetId === undefined ? {} : { asset_id: assetId }),
      pippit_asset_id: data.pippit_asset_id,
    };
  }

  async submitRun(input: SubmitRunInput): Promise<PippitSubmitRunResult> {
    const operation = 'submit_run';
    const accessKey = normalizeAccessKey(input.accessKey, operation);
    const request = normalizeSubmitRunRequest(input.request);
    validateSubmitRequest(request, operation);
    const agentName = 'general_agent_settings' in request
      ? PIPPIT_IMAGE_AGENT_NAME
      : PIPPIT_VIDEO_AGENT_NAME;
    const diagnosticParams: Readonly<Record<string, boolean | number | string>> =
      'video_part_tool_param' in request
        ? {
            asset_count: request.asset_ids.length,
            audio_count: request.video_part_tool_param.audios?.length ?? 0,
            duration_sec: request.video_part_tool_param.duration_sec ?? 0,
            image_count: request.video_part_tool_param.images?.length ?? 0,
            imitation_video_count: request.video_part_tool_param.imitation_videos?.length ?? 0,
            model: request.video_part_tool_param.model,
            partial_edit: request.video_part_tool_param.partial_edit_videos !== undefined,
            partial_edit_video_count: request.video_part_tool_param.partial_edit_videos?.length ?? 0,
            prompt_length: request.video_part_tool_param.prompt.length,
            ratio: request.video_part_tool_param.ratio ?? "",
            resolution: request.video_part_tool_param.resolution ?? "",
            seed_present: request.video_part_tool_param.seed !== undefined,
            task_type: request.video_part_tool_param.task_type ?? "",
            video_count: request.video_part_tool_param.videos?.length ?? 0,
          }
        : {
            asset_count: request.asset_ids?.length ?? 0,
            image_model: request.general_agent_settings.image_model,
            prompt_length: request.message.length,
          };
    const response = await this.requestJson(
      operation,
      '/api/biz/v1/skill/submit_run',
      accessKey,
      {
        body: stringifyJson({
          ...request,
          agent_name: agentName,
        }, operation),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      },
      input.signal,
      {
        params: diagnosticParams,
        redactions: [
          request.message,
          ...('video_part_tool_param' in request ? [request.video_part_tool_param.prompt] : []),
        ],
      },
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
    operation: PippitRequestOperation,
    path: string,
    accessKey: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
    requestDiagnostics: PippitRequestDiagnostics = {},
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
    const requestId = globalThis.crypto.randomUUID();
    const startedAt = Date.now();
    this.emitDiagnostic({
      event: 'upstream_request_started',
      operation,
      ...(requestDiagnostics.params === undefined ? {} : { params: requestDiagnostics.params }),
      path,
      request_id: requestId,
      timestamp: new Date().toISOString(),
    });
    const requestPromise = Promise.resolve().then(async () => {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        redirect: 'error',
        signal: controller.signal,
      });
      const logId = readResponseLogId(response);
      let body: unknown;
      if (!response.ok) {
        const error = new PippitApiError({
          code: 'HTTP_ERROR',
          ...(logId === undefined ? {} : { logId }),
          operation,
          status: response.status,
        });
        this.emitFailureDiagnostic(operation, error, path, requestId, startedAt, requestDiagnostics.params);
        throw error;
      }
      try {
        body = (await response.json()) as unknown;
      } catch {
        if (controller.signal.aborted) {
          throw ABORT_SENTINEL;
        }
        throw invalidResponse(operation);
      }
      const upstreamCode = isRecord(body) && (typeof body.ret === 'string' || typeof body.ret === 'number')
        ? body.ret
        : undefined;
      const upstreamMessage = readSafeUpstreamMessage(body, accessKey, requestDiagnostics.redactions);
      this.emitDiagnostic({
        duration_ms: Date.now() - startedAt,
        event: 'upstream_response_received',
        http_status: response.status,
        operation,
        ...(requestDiagnostics.params === undefined ? {} : { params: requestDiagnostics.params }),
        path,
        request_id: requestId,
        timestamp: new Date().toISOString(),
        ...(upstreamCode === undefined ? {} : { upstream_code: upstreamCode }),
        ...(logId === undefined ? {} : { upstream_log_id: logId }),
        ...(upstreamMessage === undefined ? {} : { upstream_message: upstreamMessage }),
      });
      return {
        body,
        ...(logId === undefined ? {} : { logId }),
      };
    });

    try {
      return await Promise.race([requestPromise, abortPromise]);
    } catch (error) {
      if (error instanceof PippitApiError) {
        if (error.code !== 'HTTP_ERROR') {
          this.emitFailureDiagnostic(operation, error, path, requestId, startedAt, requestDiagnostics.params);
        }
        throw error;
      }
      if (timedOut) {
        const normalized = new PippitApiError({ code: 'TIMEOUT', operation });
        this.emitFailureDiagnostic(operation, normalized, path, requestId, startedAt, requestDiagnostics.params);
        throw normalized;
      }
      if (externallyAborted || externalSignal?.aborted) {
        const normalized = new PippitApiError({ code: 'ABORTED', operation });
        this.emitFailureDiagnostic(operation, normalized, path, requestId, startedAt, requestDiagnostics.params);
        throw normalized;
      }
      const normalized = new PippitApiError({ code: 'NETWORK_ERROR', operation });
      this.emitFailureDiagnostic(operation, normalized, path, requestId, startedAt, requestDiagnostics.params);
      throw normalized;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onControllerAbort);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private emitDiagnostic(event: PippitDiagnosticEvent): void {
    if (this.diagnostics === undefined) return;
    try {
      const result = this.diagnostics(event);
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // Diagnostics must never change request behavior.
    }
  }

  private emitFailureDiagnostic(
    operation: PippitRequestOperation,
    error: PippitApiError,
    path: string,
    requestId: string,
    startedAt: number,
    params?: Readonly<Record<string, boolean | number | string>>,
  ): void {
    this.emitDiagnostic({
      duration_ms: Date.now() - startedAt,
      error_code: error.code,
      event: 'upstream_request_failed',
      ...(error.status === undefined ? {} : { http_status: error.status }),
      operation,
      ...(params === undefined ? {} : { params }),
      path,
      request_id: requestId,
      timestamp: new Date().toISOString(),
      ...(error.upstreamCode === undefined ? {} : { upstream_code: error.upstreamCode }),
      ...(error.logId === undefined ? {} : { upstream_log_id: error.logId }),
    });
  }
}
