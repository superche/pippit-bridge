import { Readable, Transform } from "node:stream"
import { resolve } from "node:path"
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify"
import { z } from "zod"
import {
  authenticateFacadeApiKey,
  authenticateManagementKey,
  type AuthenticatedApiKey,
} from "./auth.js"
import {
  ByokStoreError,
  FileByokStore,
  byokActiveSelectionQuerySchema,
  byokActiveSelectionUpdateSchema,
  byokCredentialCreateSchema,
  byokCredentialDeleteQuerySchema,
  byokCredentialListQuerySchema,
  byokCredentialUpdateSchema,
  type ByokStore,
} from "./byok/index.js"
import { loadConfig, mergeConfig, parseConfig, type AppConfig } from "./config.js"
import { ApiError, invalidRequest, toOpenRouterError } from "./errors.js"
import { createJobId, parseJobId, type JobTokenPayload } from "./jobs/job-token.js"
import {
  createReferenceLoader,
  createPublicHttpFetcher,
  ReferenceLoadError,
  IMAGE_MODELS,
  publicImageModel,
  type ReferenceLookup,
  type ReferenceLoader,
  type ReferenceTransport,
  publicVideoModel,
  resolveImageModel,
  resolveVideoModel,
  UnknownImageModelError,
  UnknownVideoModelError,
  VIDEO_MODELS,
  PIPPIT_RELEASE_EPOCH_HEADER,
  classifyReleaseEpoch,
} from "@pippit-bridge/core"
import {
  createReferenceWorkGate,
  prepareImageReferences,
  prepareReferences,
  readPippitProviderOptions,
} from "./media/prepare-references.js"
import {
  imageGenerationRequestSchema,
  type ImageGenerationRequest,
  type ImageGenerationResponse,
  type VideoGenerationJob,
  type VideoGenerationStatus,
  type VideoEditRequest,
  type VideoGenerationRequest,
  videoEditRequestSchema,
  videoGenerationRequestSchema,
} from "./openrouter/contracts.js"
import { pippitStateToOpenRouterStatus, resolveOutputGeometry } from "./openrouter/video-mapping.js"
import { OPENAPI_DOCUMENT } from "./openapi.js"
import {
  PippitApiError,
  PippitClient,
  type PippitApi,
  type PippitFailReason,
  type PippitVideoResult,
} from "@pippit-bridge/sdk"
import { createRequestSignal } from "./request-signal.js"

export interface BuildAppOptions {
  readonly byokStore?: ByokStore
  readonly config?: Partial<AppConfig>
  readonly contentLookup?: ReferenceLookup
  readonly contentTransport?: ReferenceTransport
  readonly logger?: boolean
  readonly pippit?: PippitApi
  readonly referenceLoader?: ReferenceLoader
}

function routeUrl(config: AppConfig, path: string): string {
  return config.PUBLIC_BASE_URL ? new URL(path, config.PUBLIC_BASE_URL).toString() : path
}

function sanitizeMessage(message: string, accessKey: string): string {
  return message.split(accessKey).join("[REDACTED]")
}

function failureMessage(reason: PippitFailReason | undefined, status: VideoGenerationStatus): string | undefined {
  if (status !== "failed" && status !== "cancelled" && status !== "expired") return undefined
  if (typeof reason === "string" && reason) return reason
  if (typeof reason === "object" && reason) {
    return reason.message || reason.fallback_message || reason.detail || `Pippit video generation ${status}.`
  }
  return `Pippit video generation ${status}.`
}

function jobResponse(input: {
  readonly accessKey: string
  readonly config: AppConfig
  readonly jobId: string
  readonly payload: JobTokenPayload
  readonly result: PippitVideoResult
}): VideoGenerationJob {
  const status = pippitStateToOpenRouterStatus(input.result.runState)
  const contentUrls = input.result.videoUrls.map((_url, index) =>
    routeUrl(input.config, `/api/v1/videos/${encodeURIComponent(input.jobId)}/content?index=${index}`),
  )
  const error = failureMessage(input.result.failReason, status)

  if (status === "completed" && input.result.videoUrls.length === 0) {
    throw new ApiError("Pippit marked the run completed without returning a video URL.", {
      code: "invalid_upstream_response",
      statusCode: 502,
      type: "upstream_error",
    })
  }

  return {
    ...(error === undefined ? {} : { error: sanitizeMessage(error, input.accessKey) }),
    generation_id: input.payload.run_id,
    id: input.jobId,
    model: input.payload.model,
    polling_url: routeUrl(input.config, `/api/v1/videos/${encodeURIComponent(input.jobId)}`),
    status,
    ...(status === "completed" ? { unsigned_urls: contentUrls, usage: { is_byok: true } } : {}),
  }
}

function normalizePippitError(error: PippitApiError): ApiError {
  const metadata = {
    operation: error.operation,
    ...(error.upstreamCode === undefined ? {} : { upstream_code: error.upstreamCode }),
  }

  if (error.code === "HTTP_ERROR" && (error.status === 401 || error.status === 403)) {
    return new ApiError("The selected Pippit BYOK credential was rejected by the upstream service.", {
      code: "byok_credential_rejected",
      metadata,
      statusCode: 502,
      type: "upstream_error",
    })
  }
  if (error.code === "HTTP_ERROR" && error.status === 429) {
    return new ApiError("Pippit rate limited the request.", {
      code: "rate_limit_exceeded",
      metadata,
      statusCode: 429,
      type: "upstream_error",
    })
  }
  if (error.code === "TIMEOUT") {
    return new ApiError("The Pippit upstream request timed out.", {
      code: "upstream_timeout",
      metadata,
      statusCode: 504,
      type: "upstream_error",
    })
  }
  if (error.code === "ABORTED") {
    return new ApiError("The request was cancelled.", {
      code: "request_cancelled",
      metadata,
      statusCode: 408,
      type: "api_error",
    })
  }
  return new ApiError("Pippit could not complete the upstream operation.", {
    code: "pippit_upstream_error",
    metadata,
    statusCode: 502,
    type: "upstream_error",
  })
}

function normalizeReferenceError(error: ReferenceLoadError): ApiError {
  const metadata = {
    reference_error: error.code,
    ...(error.status === undefined ? {} : { upstream_status: error.status }),
  }
  if (error.code === "INVALID_CONFIGURATION" || error.code === "INVALID_KIND") {
    return new ApiError("The reference loader is not configured correctly.", {
      code: "reference_loader_error",
      metadata,
      statusCode: 500,
      type: "api_error",
    })
  }
  if (error.code === "ABORTED") {
    return new ApiError("The request was cancelled while loading a reference.", {
      code: "request_cancelled",
      metadata,
      statusCode: 408,
      type: "api_error",
    })
  }
  if (error.code === "TOO_LARGE" || error.code === "TOTAL_TOO_LARGE") {
    return new ApiError(error.message, {
      code: "reference_too_large",
      metadata,
      param: "input_references",
      statusCode: 413,
      type: "invalid_request_error",
    })
  }
  return new ApiError(error.message, {
    code: error.code === "TIMEOUT" ? "reference_timeout" : "invalid_reference",
    metadata,
    param: "input_references",
    statusCode: 400,
    type: "invalid_request_error",
  })
}

function normalizeByokStoreError(error: ByokStoreError): ApiError {
  if (error.code === "ACTIVE_CREDENTIAL_DELETE_REQUIRES_SWITCH") {
    return new ApiError("Switch away from the active BYOK credential before deleting it.", {
      code: "active_byok_delete_requires_switch",
      statusCode: 409,
      type: "invalid_request_error",
    })
  }
  if (error.code === "ACTIVE_CREDENTIAL_INELIGIBLE") {
    return new ApiError("The requested BYOK credential is not eligible for this facade API key.", {
      code: "byok_credential_ineligible",
      param: "credential_id",
      statusCode: 409,
      type: "invalid_request_error",
    })
  }
  if (error.code === "CREDENTIAL_NOT_FOUND") {
    return new ApiError("The requested BYOK credential does not exist.", {
      code: "byok_credential_not_found",
      param: "credential_id",
      statusCode: 404,
      type: "not_found_error",
    })
  }
  if (error.code === "CREDENTIAL_LIMIT_EXCEEDED") {
    return new ApiError("The BYOK credential store has reached its configured limit.", {
      code: "byok_credential_limit_exceeded",
      statusCode: 409,
      type: "invalid_request_error",
    })
  }
  if (error.code === "INVALID_CONFIGURATION") {
    return new ApiError("The BYOK request is not valid for this provider workspace.", {
      code: "invalid_byok_request",
      statusCode: 400,
      type: "invalid_request_error",
    })
  }
  if (error.code === "STORE_CLOSED") {
    return new ApiError("The BYOK credential store is unavailable.", {
      code: "byok_store_unavailable",
      statusCode: 503,
      type: "api_error",
    })
  }
  return new ApiError("The encrypted BYOK credential store could not complete the operation.", {
    code: "byok_store_error",
    statusCode: 500,
    type: "api_error",
  })
}

function normalizeFrameworkError(error: unknown): unknown {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "FST_ERR_CTP_BODY_TOO_LARGE"
  ) {
    return new ApiError("The request body is too large.", {
      code: "request_too_large",
      statusCode: 413,
      type: "invalid_request_error",
    })
  }
  return error
}

function unsupportedStandardParameters(request: {
  readonly callback_url?: string | undefined
  readonly generate_audio?: boolean | undefined
}): void {
  if (request.callback_url !== undefined) {
    throw invalidRequest("callback_url is not supported by this Pippit facade.", "callback_url", "unsupported_parameter")
  }
  if (request.generate_audio !== undefined) {
    throw invalidRequest(
      "generate_audio is not controllable through the documented Pippit immersive-video API.",
      "generate_audio",
      "unsupported_parameter",
    )
  }
}

const MAX_COMPILED_EDIT_PROMPT_LENGTH = 20_000

function compileVideoEditPrompt(request: VideoEditRequest): string {
  // Pippit receives the complete source video. Segment and normalized ROI values
  // are deterministic provider instructions, not hard-trim or pixel-mask operations.
  const prompt = [
    "Pippit reference-guided video regeneration instruction v1.",
    "The complete source video is attached as the only video reference.",
    "Treat segment and normalized region values as edit guidance only; preserve unrelated content outside them.",
    JSON.stringify({
      annotations: request.annotations,
      instruction: request.prompt ?? null,
      segment: request.segment,
    }),
  ].join("\n")
  if (prompt.length > MAX_COMPILED_EDIT_PROMPT_LENGTH) {
    throw new ApiError("The compiled video edit instructions exceed the supported prompt length.", {
      code: "edit_instruction_too_long",
      param: "annotations",
      statusCode: 422,
      type: "invalid_request_error",
    })
  }
  return prompt
}

function editSourceVideoUrl(result: PippitVideoResult, index: number): string {
  const status = pippitStateToOpenRouterStatus(result.runState)
  if (status !== "completed") {
    throw new ApiError(`The source video is not available while its job is ${status}.`, {
      code: "source_video_not_ready",
      param: "source_job_id",
      statusCode: 400,
      type: "invalid_request_error",
    })
  }
  const videoUrl = result.videoUrls[index]
  if (videoUrl === undefined) {
    throw new ApiError(`Source video output index ${index} does not exist.`, {
      code: "source_video_output_not_found",
      param: "source_index",
      statusCode: 404,
      type: "not_found_error",
    })
  }
  let parsed: URL
  try {
    parsed = new URL(videoUrl)
  } catch {
    throw new ApiError("Pippit returned an invalid source video URL.", {
      code: "invalid_upstream_response",
      statusCode: 502,
      type: "upstream_error",
    })
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw new ApiError("Pippit returned an unsupported source video URL.", {
      code: "invalid_upstream_response",
      statusCode: 502,
      type: "upstream_error",
    })
  }
  return parsed.toString()
}

const jobParamsSchema = z.object({ jobId: z.string().min(1) })
const byokParamsSchema = z.object({ id: z.uuid() })
const contentQuerySchema = z.object({ index: z.coerce.number().int().min(0).default(0) })

function withIdleTimeout(input: {
  readonly onCleanup: () => void
  readonly onIdle: () => void
  readonly source: Readable
  readonly timeoutMs: number
}): Readable {
  let cleaned = false
  let idleTimer: NodeJS.Timeout | undefined
  const clearIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = undefined
  }
  let output: Transform
  const resetIdleTimer = (): void => {
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      const error = new Error("The generated video stream exceeded its idle timeout.")
      input.onIdle()
      input.source.destroy(error)
      output.destroy(error)
    }, input.timeoutMs)
    idleTimer.unref()
  }
  const onSourceError = (error: Error): void => {
    output.destroy(error)
  }
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    clearIdleTimer()
    if (!input.source.destroyed) input.source.destroy()
    input.onCleanup()
  }

  output = new Transform({
    transform(chunk, _encoding, callback) {
      resetIdleTimer()
      callback(null, chunk)
    },
  })
  input.source.once("error", onSourceError)
  input.source.once("close", () => input.source.removeListener("error", onSourceError))
  output.once("close", cleanup)
  output.once("end", cleanup)
  output.once("error", cleanup)
  resetIdleTimer()
  input.source.pipe(output)
  return output
}

async function queryJob(
  request: FastifyRequest,
  jobId: string,
  pippit: PippitApi,
  byokStore: ByokStore,
  config: AppConfig,
  authenticatedCaller?: AuthenticatedApiKey,
): Promise<{ readonly accessKey: string; readonly payload: JobTokenPayload; readonly result: PippitVideoResult }> {
  const caller = authenticatedCaller ?? authenticateFacadeApiKey(request, config.FACADE_API_KEY_SHA256_ALLOWLIST)
  const payload = parseJobId(jobId, caller.apiKey, config.JOB_SIGNING_KEY_HEX)
  const credential = await byokStore.getVersion(payload.credential_id, payload.credential_version_id)
  if (credential === undefined || credential.credential.workspace_id !== payload.workspace_id) {
    throw new ApiError("The BYOK credential version required by this video job is unavailable.", {
      code: "byok_credential_unavailable",
      param: "job_id",
      statusCode: 409,
      type: "api_error",
    })
  }
  const requestSignal = createRequestSignal(request)
  try {
    const result = await pippit.queryVideoResult({
      accessKey: credential.accessKey,
      runId: payload.run_id,
      signal: requestSignal.signal,
      threadId: payload.thread_id,
    })
    return { accessKey: credential.accessKey, payload, result }
  } finally {
    requestSignal.dispose()
  }
}

function canTryNextByokCredential(error: unknown): boolean {
  return (
    error instanceof PippitApiError &&
    error.code === "HTTP_ERROR" &&
    (error.status === 401 || error.status === 403 || error.status === 429)
  )
}

function byokCredentialNotFound(): ApiError {
  return new ApiError("The requested BYOK credential does not exist.", {
    code: "byok_credential_not_found",
    param: "id",
    statusCode: 404,
    type: "not_found_error",
  })
}

function noEligibleByokCredential(): ApiError {
  return new ApiError("No enabled Pippit BYOK credential is eligible for this request.", {
    code: "byok_credential_unavailable",
    statusCode: 503,
    type: "api_error",
  })
}

function generalModel(model: (typeof VIDEO_MODELS)[number]): Record<string, unknown> {
  return {
    architecture: {
      input_modalities: ["text", "image", "video", "audio"],
      instruct_type: null,
      modality: "text+image+video+audio->video",
      output_modalities: ["video"],
      tokenizer: "Other",
    },
    canonical_slug: model.canonical_slug,
    context_length: 0,
    created: model.created,
    default_parameters: null,
    description: model.description,
    expiration_date: null,
    id: model.id,
    knowledge_cutoff: null,
    links: { details: "/api/v1/videos/models" },
    name: model.name,
    per_request_limits: null,
    pricing: { completion: "0", image: "0", prompt: "0", request: "0" },
    supported_parameters: [
      "prompt",
      "duration",
      "resolution",
      "aspect_ratio",
      "frame_images",
      "input_references",
      "seed",
      "provider",
    ],
    supported_voices: null,
    top_provider: { context_length: 0, is_moderated: true, max_completion_tokens: 0 },
  }
}

function resolveFacadeVideoModel(modelId: string): (typeof VIDEO_MODELS)[number] {
  try {
    return resolveVideoModel(modelId)
  } catch (error) {
    if (error instanceof UnknownVideoModelError) {
      throw invalidRequest(error.message, "model", "model_not_found")
    }
    throw error
  }
}

function resolveFacadeImageModel(modelId: string): (typeof IMAGE_MODELS)[number] {
  try {
    return resolveImageModel(modelId)
  } catch (error) {
    if (error instanceof UnknownImageModelError) {
      throw invalidRequest(error.message, "model", "model_not_found")
    }
    throw error
  }
}

function generalImageModel(model: (typeof IMAGE_MODELS)[number]): Record<string, unknown> {
  return {
    architecture: {
      input_modalities: [...model.architecture.input_modalities],
      instruct_type: null,
      modality: "text+image->image",
      output_modalities: ["image"],
      tokenizer: "Other",
    },
    canonical_slug: model.canonical_slug,
    context_length: 0,
    created: model.created,
    default_parameters: null,
    description: model.description,
    expiration_date: null,
    id: model.id,
    knowledge_cutoff: null,
    links: { details: "/api/v1/images/models" },
    name: model.name,
    per_request_limits: null,
    pricing: { completion: "0", image: "0", prompt: "0", request: "0" },
    supported_parameters: ["prompt", ...Object.keys(model.supported_parameters), "provider"],
    supported_voices: null,
    top_provider: { context_length: 0, is_moderated: true, max_completion_tokens: 0 },
  }
}

function waitForPollDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new ApiError("The request was cancelled.", {
    code: "request_cancelled",
    statusCode: 408,
    type: "api_error",
  }))
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolveDelay()
    }, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      rejectDelay(new ApiError("The request was cancelled.", {
        code: "request_cancelled",
        statusCode: 408,
        type: "api_error",
      }))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config =
    options.config === undefined
      ? loadConfig()
      : mergeConfig(parseConfig({}), options.config)
  const byokStore =
    options.byokStore ??
    new FileByokStore({
      filePath: resolve(config.BYOK_STORE_PATH),
      masterKey: Buffer.from(config.BYOK_ENCRYPTION_KEY_HEX, "hex"),
    })
  const contentFetcher = createPublicHttpFetcher({
    ...(options.contentLookup === undefined ? {} : { lookup: options.contentLookup }),
    maxRedirects: config.REFERENCE_MAX_REDIRECTS,
    ...(options.contentTransport === undefined ? {} : { transport: options.contentTransport }),
  })
  const pippit =
    options.pippit ??
    new PippitClient({
      baseUrl: config.PIPPIT_BASE_URL,
      timeoutMs: config.PIPPIT_REQUEST_TIMEOUT_MS,
    })
  const referenceLoader =
    options.referenceLoader ??
    createReferenceLoader({
      allowPrivateUrls: config.ALLOW_PRIVATE_REFERENCE_URLS,
      maxBytesByKind: {
        audio: config.REFERENCE_MAX_AUDIO_BYTES,
        image: config.REFERENCE_MAX_IMAGE_BYTES,
        video: config.REFERENCE_MAX_VIDEO_BYTES,
      },
      maxRedirects: config.REFERENCE_MAX_REDIRECTS,
      timeoutMs: config.REFERENCE_FETCH_TIMEOUT_MS,
    })
  const referenceGate = createReferenceWorkGate(config.REFERENCE_GLOBAL_CONCURRENCY)
  const app = Fastify({
    logger: options.logger
      ? {
          redact: ["req.headers.authorization", "req.body.key"],
        }
      : false,
    routerOptions: {
      maxParamLength: 16 * 1024,
    },
  })

  app.addHook("onRequest", async request => {
    const rawEpoch = request.headers[PIPPIT_RELEASE_EPOCH_HEADER]
    const epoch = Array.isArray(rawEpoch) ? rawEpoch[0] : rawEpoch
    if (classifyReleaseEpoch(epoch) === "stale") {
      throw new ApiError("This plugin task is outside the supported compatibility window. Start a new task.", {
        code: "PLUGIN_TASK_STALE",
        statusCode: 409,
        type: "invalid_request_error",
      })
    }
  })

  const submitVideoGeneration = async (
    request: FastifyRequest,
    caller: AuthenticatedApiKey,
    body: VideoGenerationRequest,
  ): Promise<VideoGenerationJob> => {
    const model = resolveFacadeVideoModel(body.model)
    unsupportedStandardParameters(body)
    const geometry = resolveOutputGeometry(body, model)
    const providerOptions = readPippitProviderOptions(body)
    const workspaceId = await byokStore.getWorkspaceId()
    const candidates = await byokStore.resolveCandidates({
      apiKeyHash: caller.apiKeyHash,
      ...(providerOptions.byok_id === undefined ? {} : { credentialId: providerOptions.byok_id }),
      model: model.id,
      provider: "pippit",
      workspaceId,
    })
    if (candidates.length === 0) throw noEligibleByokCredential()
    if (
      providerOptions.thread_id !== undefined &&
      providerOptions.byok_id === undefined &&
      candidates.length > 1
    ) {
      throw invalidRequest(
        "provider.options.pippit.byok_id is required when continuing a thread with multiple eligible BYOK credentials.",
        "provider.options.pippit.byok_id",
        "byok_credential_required",
      )
    }
    const requestSignal = createRequestSignal(request)

    try {
      for (const [index, candidate] of candidates.entries()) {
        try {
          const references = await prepareReferences({
            accessKey: candidate.accessKey,
            concurrency: config.REFERENCE_UPLOAD_CONCURRENCY,
            gate: referenceGate,
            loader: referenceLoader,
            maxTotalBytes: config.REFERENCE_MAX_TOTAL_BYTES,
            maxTotalBytesByKind: { audio: config.REFERENCE_MAX_AUDIO_BYTES },
            pippit,
            request: body,
            signal: requestSignal.signal,
          })
          const submitted = await pippit.submitRun({
            accessKey: candidate.accessKey,
            request: {
              asset_ids: [...references.assetIds],
              message: body.prompt,
              ...(providerOptions.thread_id === undefined ? {} : { thread_id: providerOptions.thread_id }),
              video_part_tool_param: {
                ...(references.audios.length === 0 ? {} : { audios: [...references.audios] }),
                duration_sec: body.duration ?? 5,
                ...(references.generateType === undefined ? {} : { generate_type: references.generateType }),
                ...(references.images.length === 0 ? {} : { images: [...references.images] }),
                model: model.upstreamModel,
                prompt: body.prompt,
                ...(geometry.aspectRatio === undefined ? {} : { ratio: geometry.aspectRatio }),
                ...(geometry.resolution === undefined ? {} : { resolution: geometry.resolution }),
                ...(body.seed === undefined ? {} : { seed: body.seed }),
                ...(references.videos.length === 0 ? {} : { videos: [...references.videos] }),
              },
            },
            signal: requestSignal.signal,
          })
          const jobId = createJobId(
            {
              created_at: Date.now(),
              credential_id: candidate.credential.id,
              credential_version_id: candidate.keyVersion.id,
              model: model.id,
              run_id: submitted.run.runId,
              thread_id: submitted.run.threadId,
              workspace_id: workspaceId,
            },
            caller.apiKey,
            config.JOB_SIGNING_KEY_HEX,
          )
          return {
            generation_id: submitted.run.runId,
            id: jobId,
            model: model.id,
            polling_url: routeUrl(config, `/api/v1/videos/${encodeURIComponent(jobId)}`),
            status: pippitStateToOpenRouterStatus(submitted.run.state),
            usage: { is_byok: true },
          }
        } catch (error) {
          const hasNextCandidate = index + 1 < candidates.length
          if (!hasNextCandidate || !canTryNextByokCredential(error)) throw error
        }
      }
      throw noEligibleByokCredential()
    } finally {
      requestSignal.dispose()
    }
  }

  const submitImageGeneration = async (
    request: FastifyRequest,
    caller: AuthenticatedApiKey,
    body: ImageGenerationRequest,
  ): Promise<ImageGenerationResponse> => {
    const model = resolveFacadeImageModel(body.model)
    if (model.upstreamModel === "seedream_5.0" && body.resolution !== undefined) {
      throw invalidRequest(
        "resolution is not supported by pippit/seedream-5.0; omit the field entirely.",
        "resolution",
        "unsupported_parameter",
      )
    }

    const providerOptions = readPippitProviderOptions(body)
    const workspaceId = await byokStore.getWorkspaceId()
    const candidates = await byokStore.resolveCandidates({
      apiKeyHash: caller.apiKeyHash,
      ...(providerOptions.byok_id === undefined ? {} : { credentialId: providerOptions.byok_id }),
      model: model.id,
      provider: "pippit",
      workspaceId,
    })
    if (candidates.length === 0) throw noEligibleByokCredential()
    if (providerOptions.thread_id !== undefined && providerOptions.byok_id === undefined && candidates.length > 1) {
      throw invalidRequest(
        "provider.options.pippit.byok_id is required when continuing a thread with multiple eligible BYOK credentials.",
        "provider.options.pippit.byok_id",
        "byok_credential_required",
      )
    }

    const requestSignal = createRequestSignal(request)
    try {
      let selectedAccessKey: string | undefined
      let submitted: Awaited<ReturnType<PippitApi["submitRun"]>> | undefined
      for (const [index, candidate] of candidates.entries()) {
        try {
          const assetIds = await prepareImageReferences({
            accessKey: candidate.accessKey,
            concurrency: config.REFERENCE_UPLOAD_CONCURRENCY,
            gate: referenceGate,
            loader: referenceLoader,
            maxTotalBytes: config.REFERENCE_MAX_TOTAL_BYTES,
            pippit,
            request: body,
            signal: requestSignal.signal,
          })
          submitted = await pippit.submitRun({
            accessKey: candidate.accessKey,
            request: {
              ...(assetIds.length === 0 ? {} : { asset_ids: [...assetIds] }),
              general_agent_settings: {
                generate_image_count: body.n,
                image_model: model.upstreamModel,
                ...(body.resolution === undefined ? {} : { resolution: body.resolution }),
              },
              message: body.prompt,
              ...(providerOptions.thread_id === undefined ? {} : { thread_id: providerOptions.thread_id }),
            },
            signal: requestSignal.signal,
          })
          selectedAccessKey = candidate.accessKey
          break
        } catch (error) {
          const hasNextCandidate = index + 1 < candidates.length
          if (!hasNextCandidate || !canTryNextByokCredential(error)) throw error
        }
      }
      if (selectedAccessKey === undefined || submitted === undefined) throw noEligibleByokCredential()

      const deadline = Date.now() + config.IMAGE_GENERATION_TIMEOUT_MS
      let result: PippitVideoResult
      while (true) {
        result = await pippit.queryVideoResult({
          accessKey: selectedAccessKey,
          runId: submitted.run.runId,
          signal: requestSignal.signal,
          threadId: submitted.run.threadId,
        })
        const status = pippitStateToOpenRouterStatus(result.runState)
        if (status === "completed") break
        if (status === "failed" || status === "cancelled" || status === "expired") {
          const detail = failureMessage(result.failReason, status) ?? `Pippit image generation ${status}.`
          throw new ApiError(sanitizeMessage(detail, selectedAccessKey), {
            code: "image_generation_failed",
            statusCode: 502,
            type: "upstream_error",
          })
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          throw new ApiError("Pippit image generation timed out.", {
            code: "upstream_timeout",
            statusCode: 504,
            type: "upstream_error",
          })
        }
        await waitForPollDelay(Math.min(config.IMAGE_GENERATION_POLL_INTERVAL_MS, remaining), requestSignal.signal)
      }

      if (result.imageUrls.length === 0) {
        throw new ApiError("Pippit marked the run completed without returning an image URL.", {
          code: "invalid_upstream_response",
          statusCode: 502,
          type: "upstream_error",
        })
      }

      const data: Array<{ b64_json: string; media_type?: string }> = []
      let totalBytes = 0
      for (const imageUrl of result.imageUrls) {
        const image = await referenceLoader.load(imageUrl, "image", requestSignal.signal)
        totalBytes += image.bytes.byteLength
        if (totalBytes > config.REFERENCE_MAX_TOTAL_BYTES) throw new ReferenceLoadError("TOTAL_TOO_LARGE")
        data.push({
          b64_json: Buffer.from(image.bytes).toString("base64"),
          ...(image.mediaType === "image/png" ? {} : { media_type: image.mediaType }),
        })
      }

      return {
        created: Math.floor(Date.now() / 1_000),
        data,
        model: model.id,
        usage: { cost: null, is_byok: true },
      }
    } finally {
      requestSignal.dispose()
    }
  }

  app.addHook("onReady", async () => {
    await byokStore.getWorkspaceId()
  })
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0]
    if (path === "/api/v1/byok" || path?.startsWith("/api/v1/byok/")) {
      reply.header("cache-control", "no-store")
    }
  })
  app.addHook("onClose", async () => {
    await byokStore.close()
  })

  app.setErrorHandler((error, _request, reply) => {
    const normalized =
      error instanceof PippitApiError
        ? normalizePippitError(error)
        : error instanceof ReferenceLoadError
          ? normalizeReferenceError(error)
          : error instanceof ByokStoreError
            ? normalizeByokStoreError(error)
            : normalizeFrameworkError(error)
    const response = toOpenRouterError(normalized)
    if (response.statusCode === 401) reply.header("www-authenticate", "Bearer")
    void reply.status(response.statusCode).send(response.body)
  })

  app.get("/health", async () => {
    await byokStore.getWorkspaceId()
    return { status: "ok" }
  })
  app.get("/openapi.json", async () => OPENAPI_DOCUMENT)

  app.get("/api/v1/videos/models", async (request) => {
    authenticateFacadeApiKey(request, config.FACADE_API_KEY_SHA256_ALLOWLIST)
    return { data: VIDEO_MODELS.map(publicVideoModel) }
  })

  app.get("/api/v1/images/models", async (request) => {
    authenticateFacadeApiKey(request, config.FACADE_API_KEY_SHA256_ALLOWLIST)
    return { data: IMAGE_MODELS.map(publicImageModel) }
  })

  app.get("/api/v1/images/models/:provider/:model/endpoints", async (request) => {
    authenticateFacadeApiKey(request, config.FACADE_API_KEY_SHA256_ALLOWLIST)
    const params = z.object({ model: z.string().min(1), provider: z.string().min(1) }).parse(request.params)
    const model = resolveFacadeImageModel(`${params.provider}/${params.model}`)
    return {
      endpoints: [{
        allowed_passthrough_parameters: ["byok_id", "thread_id"],
        pricing: [],
        provider_name: "Pippit",
        provider_slug: "pippit",
        provider_tag: "pippit",
        supported_parameters: model.supported_parameters,
        supports_streaming: false,
      }],
      id: model.id,
    }
  })

  app.get("/api/v1/models", async (request) => {
    authenticateFacadeApiKey(request, config.FACADE_API_KEY_SHA256_ALLOWLIST)
    return { data: [...VIDEO_MODELS.map(generalModel), ...IMAGE_MODELS.map(generalImageModel)] }
  })

  app.post("/api/v1/byok", async (request, reply) => {
    authenticateManagementKey(request, config.BYOK_MANAGEMENT_KEY_SHA256)
    const input = byokCredentialCreateSchema.parse(request.body)
    const credential = await byokStore.create(input)
    reply.header("cache-control", "no-store")
    return reply.status(201).send({ data: credential })
  })

  app.get("/api/v1/byok", async (request, reply) => {
    authenticateManagementKey(request, config.BYOK_MANAGEMENT_KEY_SHA256)
    const query = byokCredentialListQuerySchema.parse(request.query)
    const credentials = await byokStore.list(query)
    reply.header("cache-control", "no-store")
    return credentials
  })

  app.get("/api/v1/byok/active", async (request, reply) => {
    authenticateManagementKey(request, config.BYOK_MANAGEMENT_KEY_SHA256)
    const query = byokActiveSelectionQuerySchema.parse(request.query)
    const selection = await byokStore.getActiveSelection(query.facade_api_key_hash)
    reply.header("cache-control", "no-store")
    return { data: selection ?? null }
  })

  app.put("/api/v1/byok/active", async (request, reply) => {
    authenticateManagementKey(request, config.BYOK_MANAGEMENT_KEY_SHA256)
    const input = byokActiveSelectionUpdateSchema.parse(request.body)
    const selection = await byokStore.setActiveSelection(
      input.facade_api_key_hash,
      input.credential_id,
    )
    reply.header("cache-control", "no-store")
    return { data: selection }
  })

  app.get("/api/v1/byok/:id", async (request, reply) => {
    authenticateManagementKey(request, config.BYOK_MANAGEMENT_KEY_SHA256)
    const { id } = byokParamsSchema.parse(request.params)
    const credential = await byokStore.get(id)
    if (credential === undefined) throw byokCredentialNotFound()
    reply.header("cache-control", "no-store")
    return { data: credential }
  })

  app.patch("/api/v1/byok/:id", async (request, reply) => {
    authenticateManagementKey(request, config.BYOK_MANAGEMENT_KEY_SHA256)
    const { id } = byokParamsSchema.parse(request.params)
    const input = byokCredentialUpdateSchema.parse(request.body)
    const credential = await byokStore.update(id, input)
    if (credential === undefined) throw byokCredentialNotFound()
    reply.header("cache-control", "no-store")
    return { data: credential }
  })

  app.delete("/api/v1/byok/:id", async (request, reply) => {
    authenticateManagementKey(request, config.BYOK_MANAGEMENT_KEY_SHA256)
    const { id } = byokParamsSchema.parse(request.params)
    const query = byokCredentialDeleteQuerySchema.parse(request.query)
    const deleted = await byokStore.delete(id, query.facade_api_key_hash)
    if (!deleted) throw byokCredentialNotFound()
    reply.header("cache-control", "no-store")
    return { deleted: true }
  })

  app.post("/api/v1/videos", async (request, reply) => {
    const caller = authenticateFacadeApiKey(request, config.FACADE_API_KEY_SHA256_ALLOWLIST)
    const body = videoGenerationRequestSchema.parse(request.body)
    return reply.status(202).send(await submitVideoGeneration(request, caller, body))
  })

  app.post("/api/v1/images", async (request) => {
    const caller = authenticateFacadeApiKey(request, config.FACADE_API_KEY_SHA256_ALLOWLIST)
    const body = imageGenerationRequestSchema.parse(request.body)
    return submitImageGeneration(request, caller, body)
  })

  app.post("/api/v1/videos/edits", async (request, reply) => {
    const caller = authenticateFacadeApiKey(request, config.FACADE_API_KEY_SHA256_ALLOWLIST)
    const edit = videoEditRequestSchema.parse(request.body)
    const source = await queryJob(
      request,
      edit.source_job_id,
      pippit,
      byokStore,
      config,
      caller,
    )
    const sourceUrl = editSourceVideoUrl(source.result, edit.source_index)
    const body = videoGenerationRequestSchema.parse({
      duration: Math.max(1, Math.ceil((edit.segment.end_ms - edit.segment.start_ms) / 1_000)),
      input_references: [{ type: "video_url", video_url: { url: sourceUrl } }],
      model: edit.model,
      prompt: compileVideoEditPrompt(edit),
      ...(edit.provider === undefined ? {} : { provider: edit.provider }),
      ...(edit.resolution === undefined ? {} : { resolution: edit.resolution }),
      ...(edit.seed === undefined ? {} : { seed: edit.seed }),
    })
    return reply.status(202).send(await submitVideoGeneration(request, caller, body))
  })

  app.get("/api/v1/videos/:jobId", async (request) => {
    const { jobId } = jobParamsSchema.parse(request.params)
    const queried = await queryJob(request, jobId, pippit, byokStore, config)
    return jobResponse({ config, jobId, ...queried })
  })

  app.get("/api/v1/videos/:jobId/content", async (request, reply) => {
    const { jobId } = jobParamsSchema.parse(request.params)
    const { index } = contentQuerySchema.parse(request.query)
    const queried = await queryJob(request, jobId, pippit, byokStore, config)
    const status = pippitStateToOpenRouterStatus(queried.result.runState)

    if (status !== "completed") {
      throw new ApiError(`Video content is not available while the job is ${status}.`, {
        code: "video_not_ready",
        param: "job_id",
        statusCode: 400,
        type: "invalid_request_error",
      })
    }
    const videoUrl = queried.result.videoUrls[index]
    if (!videoUrl) {
      throw new ApiError(`Video output index ${index} does not exist.`, {
        code: "video_output_not_found",
        param: "index",
        statusCode: 404,
        type: "not_found_error",
      })
    }

    let parsedVideoUrl: URL
    try {
      parsedVideoUrl = new URL(videoUrl)
    } catch {
      throw new ApiError("Pippit returned an invalid video content URL.", {
        code: "invalid_upstream_response",
        statusCode: 502,
        type: "upstream_error",
      })
    }
    if (!new Set(["http:", "https:"]).has(parsedVideoUrl.protocol) || parsedVideoUrl.username || parsedVideoUrl.password) {
      throw new ApiError("Pippit returned an unsupported video content URL.", {
        code: "invalid_upstream_response",
        statusCode: 502,
        type: "upstream_error",
      })
    }

    const downloadHeaders = new Headers()
    if (request.headers.range) downloadHeaders.set("range", request.headers.range)
    const downstreamController = new AbortController()
    const headerTimeoutController = new AbortController()
    const abortDownstream = (): void => downstreamController.abort()
    request.raw.socket.once("close", abortDownstream)
    reply.raw.once("close", abortDownstream)
    const headerTimer = setTimeout(() => headerTimeoutController.abort(), config.PIPPIT_REQUEST_TIMEOUT_MS)
    const downloadSignal = AbortSignal.any([downstreamController.signal, headerTimeoutController.signal])
    const cleanupDownload = (): void => {
      clearTimeout(headerTimer)
      request.raw.socket.removeListener("close", abortDownstream)
      reply.raw.removeListener("close", abortDownstream)
    }
    let response: Response
    try {
      const fetched = await contentFetcher.fetch(parsedVideoUrl, {
        headers: downloadHeaders,
        signal: downloadSignal,
      })
      response = fetched.response
      clearTimeout(headerTimer)
    } catch {
      cleanupDownload()
      if (headerTimeoutController.signal.aborted) {
        throw new ApiError("Downloading the generated video from Pippit timed out.", {
          code: "upstream_download_timeout",
          statusCode: 504,
          type: "upstream_error",
        })
      }
      if (downstreamController.signal.aborted) {
        throw new ApiError("The downstream request was cancelled.", {
          code: "request_cancelled",
          statusCode: 408,
          type: "api_error",
        })
      }
      throw new ApiError("The generated video could not be downloaded from Pippit.", {
        code: "upstream_download_failed",
        statusCode: 502,
        type: "upstream_error",
      })
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      cleanupDownload()
      throw new ApiError("The generated video could not be downloaded from Pippit.", {
        code: "upstream_download_failed",
        metadata: { upstream_status: response.status },
        statusCode: 502,
        type: "upstream_error",
      })
    }

    const upstreamContentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    if (
      upstreamContentType !== undefined &&
      upstreamContentType !== "application/octet-stream" &&
      !upstreamContentType.startsWith("video/")
    ) {
      await response.body.cancel().catch(() => undefined)
      cleanupDownload()
      throw new ApiError("Pippit returned a non-video content type for the generated result.", {
        code: "invalid_upstream_response",
        statusCode: 502,
        type: "upstream_error",
      })
    }
    const contentType = upstreamContentType?.startsWith("video/") ? upstreamContentType : "video/mp4"
    const contentLength = response.headers.get("content-length")
    const contentRange = response.headers.get("content-range")
    const acceptRanges = response.headers.get("accept-ranges")
    reply.status(response.status)
    reply.header("content-type", contentType)
    reply.header("x-content-type-options", "nosniff")
    if (contentLength) reply.header("content-length", contentLength)
    if (contentRange) reply.header("content-range", contentRange)
    if (acceptRanges) reply.header("accept-ranges", acceptRanges)
    const contentStream = Readable.fromWeb(
      response.body as import("node:stream/web").ReadableStream<Uint8Array>,
    )
    const timedContentStream = withIdleTimeout({
      onCleanup: cleanupDownload,
      onIdle: () => downstreamController.abort(),
      source: contentStream,
      timeoutMs: config.CONTENT_STREAM_IDLE_TIMEOUT_MS,
    })
    return reply.send(timedContentStream)
  })

  return app
}
