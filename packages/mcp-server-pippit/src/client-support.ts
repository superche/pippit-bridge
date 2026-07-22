import { PIPPIT_RELEASE_EPOCH, PIPPIT_RELEASE_EPOCH_HEADER } from "@pippit-bridge/core"
import {
  PIPPIT_VIDEO_GENERATION_STATUSES,
  type PippitAccessKeyCredential,
  type PippitAccessKeySelection,
  type PippitFacadeErrorCode,
  type PippitFacadeFetch,
  type PippitFacadeOperation,
  type PippitImageGenerationResponse,
  type PippitImageModel,
  type PippitVideoGenerationJob,
  type PippitVideoGenerationStatus,
  type PippitVideoModel,
} from "./contracts.ts"
import { normalizePippitFacadeBaseUrl, PIPPIT_DEFAULT_FACADE_TIMEOUT_MS } from "./options.ts"

export const MAX_IMAGE_JSON_RESPONSE_BYTES = 420 * 1024 * 1024
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024
const PIPPIT_UPSTREAM_OPERATIONS = new Set([
  "client",
  "query_generate_video_result",
  "submit_run",
  "upload_file",
] as const)

type PippitUpstreamOperation = "client" | "query_generate_video_result" | "submit_run" | "upload_file"

export class PippitFacadeError extends Error {
  readonly code: PippitFacadeErrorCode
  readonly operation: PippitFacadeOperation
  readonly status?: number
  readonly upstreamCode?: string | number
  readonly upstreamLogId?: string
  readonly upstreamOperation?: PippitUpstreamOperation

  constructor(input: {
    readonly code: PippitFacadeErrorCode
    readonly message: string
    readonly operation: PippitFacadeOperation
    readonly status?: number
    readonly upstreamCode?: string | number
    readonly upstreamLogId?: string
    readonly upstreamOperation?: PippitUpstreamOperation
  }) {
    super(input.message)
    this.name = "PippitFacadeError"
    this.code = input.code
    this.operation = input.operation
    if (input.status !== undefined) this.status = input.status
    if (input.upstreamCode !== undefined) this.upstreamCode = input.upstreamCode
    if (input.upstreamLogId !== undefined) this.upstreamLogId = input.upstreamLogId
    if (input.upstreamOperation !== undefined) this.upstreamOperation = input.upstreamOperation
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function facadeUpstreamMetadata(value: unknown): {
  readonly upstreamCode?: string | number
  readonly upstreamLogId?: string
  readonly upstreamOperation?: PippitUpstreamOperation
} {
  if (!isRecord(value) || !isRecord(value.error) || !isRecord(value.error.metadata)) return {}
  const metadata = value.error.metadata
  const operation = metadata.operation
  const upstreamOperation = typeof operation === "string"
    && PIPPIT_UPSTREAM_OPERATIONS.has(operation as PippitUpstreamOperation)
    ? operation as PippitUpstreamOperation
    : undefined
  const code = metadata.upstream_code
  const upstreamCode = typeof code === "number" && Number.isSafeInteger(code)
    ? code
    : typeof code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/u.test(code)
      ? code
      : undefined
  const logId = metadata.upstream_log_id
  const upstreamLogId = typeof logId === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(logId)
    ? logId
    : undefined
  return {
    ...(upstreamCode === undefined ? {} : { upstreamCode }),
    ...(upstreamLogId === undefined ? {} : { upstreamLogId }),
    ...(upstreamOperation === undefined ? {} : { upstreamOperation }),
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

function hasAsciiControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export function invalidResponse(operation: PippitFacadeOperation): PippitFacadeError {
  return new PippitFacadeError({
    code: "INVALID_RESPONSE",
    message: `Pippit facade returned an invalid response for ${operation}.`,
    operation,
  })
}

function stringArrayOrNull(value: unknown): value is readonly string[] | null {
  return value === null || (Array.isArray(value) && value.every(isNonEmptyString))
}

function numberArrayOrNull(value: unknown): value is readonly number[] | null {
  return value === null || (Array.isArray(value) && value.every(item => typeof item === "number" && Number.isFinite(item)))
}

export function parseVideoModel(value: unknown, operation: PippitFacadeOperation): PippitVideoModel {
  if (!isRecord(value)) throw invalidResponse(operation)
  if (
    !Array.isArray(value.allowed_passthrough_parameters)
    || !value.allowed_passthrough_parameters.every(isNonEmptyString)
    || !isNonEmptyString(value.canonical_slug)
    || typeof value.created !== "number"
    || !Number.isFinite(value.created)
    || !isNonEmptyString(value.description)
    || (value.generate_audio !== null && typeof value.generate_audio !== "boolean")
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.name)
    || value.pricing_skus !== null
    || (value.seed !== null && typeof value.seed !== "boolean")
    || !stringArrayOrNull(value.supported_aspect_ratios)
    || !numberArrayOrNull(value.supported_durations)
    || !stringArrayOrNull(value.supported_frame_images)
    || (value.supported_frame_images !== null
      && !value.supported_frame_images.every(item => item === "first_frame" || item === "last_frame"))
    || !stringArrayOrNull(value.supported_resolutions)
    || !stringArrayOrNull(value.supported_sizes)
  ) throw invalidResponse(operation)
  return {
    allowed_passthrough_parameters: [...value.allowed_passthrough_parameters],
    canonical_slug: value.canonical_slug,
    created: value.created,
    description: value.description,
    generate_audio: value.generate_audio,
    id: value.id,
    name: value.name,
    pricing_skus: null,
    seed: value.seed,
    supported_aspect_ratios: value.supported_aspect_ratios === null ? null : [...value.supported_aspect_ratios],
    supported_durations: value.supported_durations === null ? null : [...value.supported_durations],
    supported_frame_images: value.supported_frame_images === null ? null : [...value.supported_frame_images],
    supported_resolutions: value.supported_resolutions === null ? null : [...value.supported_resolutions],
    supported_sizes: value.supported_sizes === null ? null : [...value.supported_sizes],
  }
}

export function parseImageModel(value: unknown, operation: PippitFacadeOperation): PippitImageModel {
  if (!isRecord(value) || !isRecord(value.architecture)) throw invalidResponse(operation)
  if (
    !Array.isArray(value.architecture.input_modalities)
    || !value.architecture.input_modalities.every(isNonEmptyString)
    || !Array.isArray(value.architecture.output_modalities)
    || !value.architecture.output_modalities.every(isNonEmptyString)
    || !isNonEmptyString(value.canonical_slug)
    || typeof value.created !== "number" || !Number.isFinite(value.created)
    || !isNonEmptyString(value.description)
    || !isNonEmptyString(value.endpoints)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.name)
    || !isRecord(value.supported_parameters)
    || !Object.values(value.supported_parameters).every(isRecord)
    || typeof value.supports_streaming !== "boolean"
  ) throw invalidResponse(operation)
  return {
    architecture: {
      input_modalities: [...value.architecture.input_modalities] as string[],
      output_modalities: [...value.architecture.output_modalities] as string[],
    },
    canonical_slug: value.canonical_slug,
    created: value.created,
    description: value.description,
    endpoints: value.endpoints,
    id: value.id,
    name: value.name,
    supported_parameters: value.supported_parameters as Readonly<Record<string, Readonly<Record<string, unknown>>>>,
    supports_streaming: value.supports_streaming,
  }
}

export function parseImageResponse(value: unknown, operation: PippitFacadeOperation): PippitImageGenerationResponse {
  if (
    !isRecord(value)
    || typeof value.created !== "number" || !Number.isSafeInteger(value.created) || value.created < 0
    || !isNonEmptyString(value.model)
    || !Array.isArray(value.data) || value.data.length < 1 || value.data.length > 10
    || !isRecord(value.usage)
  ) throw invalidResponse(operation)
  const data = value.data.map(item => {
    if (!isRecord(item) || !isNonEmptyString(item.b64_json) || !/^[A-Za-z0-9+/]+={0,2}$/u.test(item.b64_json)) {
      throw invalidResponse(operation)
    }
    if (item.media_type !== undefined && (!isNonEmptyString(item.media_type) || !item.media_type.startsWith("image/"))) {
      throw invalidResponse(operation)
    }
    return { b64_json: item.b64_json, ...(item.media_type === undefined ? {} : { media_type: item.media_type }) }
  })
  if (value.usage.cost !== null && (typeof value.usage.cost !== "number" || !Number.isFinite(value.usage.cost))) {
    throw invalidResponse(operation)
  }
  if (typeof value.usage.is_byok !== "boolean") throw invalidResponse(operation)
  return { created: value.created, data, model: value.model, usage: { cost: value.usage.cost, is_byok: value.usage.is_byok } }
}

function isStatus(value: unknown): value is PippitVideoGenerationStatus {
  return typeof value === "string" && (PIPPIT_VIDEO_GENERATION_STATUSES as readonly string[]).includes(value)
}

export function parseJob(value: unknown, operation: PippitFacadeOperation): PippitVideoGenerationJob {
  if (!isRecord(value)) throw invalidResponse(operation)
  if (
    !isNonEmptyString(value.id)
    || !isNonEmptyString(value.polling_url)
    || !isStatus(value.status)
    || (value.generation_id !== undefined && value.generation_id !== null && !isNonEmptyString(value.generation_id))
    || (value.model !== undefined && value.model !== null && !isNonEmptyString(value.model))
    || (value.error !== undefined && typeof value.error !== "string")
    || (value.unsigned_urls !== undefined
      && (!Array.isArray(value.unsigned_urls) || !value.unsigned_urls.every(isNonEmptyString)))
  ) throw invalidResponse(operation)
  let usage: PippitVideoGenerationJob["usage"]
  if (value.usage !== undefined) {
    if (!isRecord(value.usage)) throw invalidResponse(operation)
    if (value.usage.cost !== undefined && value.usage.cost !== null
      && (typeof value.usage.cost !== "number" || !Number.isFinite(value.usage.cost))) throw invalidResponse(operation)
    if (value.usage.is_byok !== undefined && typeof value.usage.is_byok !== "boolean") throw invalidResponse(operation)
    usage = {
      ...(value.usage.cost === undefined ? {} : { cost: value.usage.cost as number | null }),
      ...(value.usage.is_byok === undefined ? {} : { is_byok: value.usage.is_byok }),
    }
  }
  return {
    ...(value.error === undefined ? {} : { error: value.error }),
    ...(value.generation_id === undefined ? {} : { generation_id: value.generation_id }),
    id: value.id,
    ...(value.model === undefined ? {} : { model: value.model }),
    polling_url: value.polling_url,
    status: value.status,
    ...(value.unsigned_urls === undefined ? {} : { unsigned_urls: [...value.unsigned_urls] }),
    ...(usage === undefined ? {} : { usage }),
  }
}

export function normalizeBaseUrl(value: string, operation: PippitFacadeOperation = "list_video_models"): string {
  try {
    return normalizePippitFacadeBaseUrl(value)
  } catch {
    throw new PippitFacadeError({
      code: "INVALID_CONFIGURATION",
      message: "Pippit facade base URL must be an absolute HTTP(S) URL.",
      operation,
    })
  }
}

export function normalizeRange(value: string | undefined, operation: PippitFacadeOperation): string | undefined {
  if (value === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value)
  if (!match || (match[1] === "" && match[2] === "")) {
    throw new PippitFacadeError({ code: "INVALID_INPUT", message: "range must contain one HTTP byte range.", operation })
  }
  const start = match[1] === "" ? undefined : Number(match[1])
  const end = match[2] === "" ? undefined : Number(match[2])
  if ((start !== undefined && !Number.isSafeInteger(start))
    || (end !== undefined && !Number.isSafeInteger(end))
    || (start !== undefined && end !== undefined && start > end)) {
    throw new PippitFacadeError({ code: "INVALID_INPUT", message: "range must contain one valid HTTP byte range.", operation })
  }
  return value
}

export function normalizeApiKey(
  value: string,
  operation: PippitFacadeOperation = "list_video_models",
  label = "Pippit facade API key",
): string {
  const normalized = value.trim()
  if (normalized === "" || !/^[\x21-\x7e]+$/u.test(normalized)) {
    throw new PippitFacadeError({ code: "INVALID_CONFIGURATION", message: `${label} is missing or invalid.`, operation })
  }
  return normalized
}

export function normalizeTimeout(
  value: number | undefined,
  operation: PippitFacadeOperation = "list_video_models",
): number {
  const timeout = value ?? PIPPIT_DEFAULT_FACADE_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > PIPPIT_DEFAULT_FACADE_TIMEOUT_MS) {
    throw new PippitFacadeError({
      code: "INVALID_CONFIGURATION",
      message: "Pippit facade timeout must be an integer from 1 to 43200000.",
      operation,
    })
  }
  return timeout
}

export function normalizePrintableInput(
  value: string,
  name: string,
  maximum: number,
  operation: PippitFacadeOperation,
): string {
  const normalized = value.trim()
  if (normalized === "" || normalized.length > maximum || hasAsciiControlCharacters(normalized)) {
    throw new PippitFacadeError({ code: "INVALID_INPUT", message: `${name} must be a non-empty printable string.`, operation })
  }
  return normalized
}

export function normalizeJobId(value: string, operation: PippitFacadeOperation): string {
  return normalizePrintableInput(value, "job_id", 8_192, operation)
}

export async function readJson(
  response: Response,
  operation: PippitFacadeOperation,
  maxBytes = MAX_JSON_RESPONSE_BYTES,
): Promise<unknown> {
  const declaredHeader = response.headers.get("content-length")
  if (declaredHeader !== null && (!/^\d+$/u.test(declaredHeader) || Number(declaredHeader) > maxBytes)) {
    await response.body?.cancel().catch(() => undefined)
    throw invalidResponse(operation)
  }
  if (response.body === null) throw invalidResponse(operation)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw invalidResponse(operation)
      }
      chunks.push(chunk.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (error instanceof PippitFacadeError) throw error
    throw invalidResponse(operation)
  } finally {
    reader.releaseLock()
  }
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, totalBytes))
  } catch {
    throw invalidResponse(operation)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw invalidResponse(operation)
  }
}

export function serializeJson(value: unknown, operation: PippitFacadeOperation): string {
  try {
    return JSON.stringify(value)
  } catch {
    throw new PippitFacadeError({
      code: "INVALID_INPUT",
      message: `Pippit facade request is not JSON serializable for ${operation}.`,
      operation,
    })
  }
}

export function parseAccessKeyCredential(
  value: unknown,
  activeCredentialId?: string,
  operation: "add_access_key" | "list_access_keys" = "list_access_keys",
): PippitAccessKeyCredential {
  if (!isRecord(value) || !isNonEmptyString(value.id)
    || (value.name !== null && typeof value.name !== "string")
    || !isNonEmptyString(value.label) || typeof value.disabled !== "boolean") throw invalidResponse(operation)
  return {
    account_name: value.name === null ? null : value.name,
    active: value.id === activeCredentialId,
    credential_id: value.id,
    disabled: value.disabled,
    label: value.label,
  }
}

export function parseAccessKeySelection(
  value: unknown,
  expectedFacadeApiKeyHash: string,
  operation: "list_access_keys" | "switch_access_key",
): PippitAccessKeySelection | undefined {
  if (!isRecord(value) || !("data" in value)) throw invalidResponse(operation)
  if (value.data === null) return undefined
  if (!isRecord(value.data) || value.data.facade_api_key_hash !== expectedFacadeApiKeyHash
    || !isNonEmptyString(value.data.credential_id) || !isNonEmptyString(value.data.updated_at)) {
    throw invalidResponse(operation)
  }
  return { active: true, credential_id: value.data.credential_id, updated_at: value.data.updated_at }
}

export async function requestWithBearer(input: {
  readonly apiKey: string
  readonly baseUrl: string
  readonly fetchImpl: PippitFacadeFetch
  readonly init: RequestInit
  readonly operation: PippitFacadeOperation
  readonly path: string
  readonly signal: AbortSignal | undefined
  readonly timeoutMs: number
}): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs)
  const requestSignal = input.signal === undefined ? timeoutSignal : AbortSignal.any([input.signal, timeoutSignal])
  let response: Response
  try {
    const headers = new Headers(input.init.headers)
    if (!headers.has("accept")) headers.set("accept", "application/json")
    headers.set("authorization", `Bearer ${input.apiKey}`)
    headers.set(PIPPIT_RELEASE_EPOCH_HEADER, String(PIPPIT_RELEASE_EPOCH))
    response = await input.fetchImpl(`${input.baseUrl}${input.path}`, {
      ...input.init,
      headers,
      redirect: "error",
      signal: requestSignal,
    })
  } catch {
    const code: PippitFacadeErrorCode = timeoutSignal.aborted ? "TIMEOUT"
      : input.signal?.aborted ? "ABORTED" : "NETWORK_ERROR"
    const message = code === "TIMEOUT" ? `Pippit facade timed out during ${input.operation}.`
      : code === "ABORTED" ? `Pippit facade request was cancelled during ${input.operation}.`
        : `Pippit facade network request failed during ${input.operation}.`
    throw new PippitFacadeError({ code, message, operation: input.operation })
  }
  if (!response.ok) {
    let upstreamMetadata: ReturnType<typeof facadeUpstreamMetadata> = {}
    try {
      upstreamMetadata = facadeUpstreamMetadata(await readJson(response, input.operation))
    } catch {
      try { await response.body?.cancel() } catch { /* The generic HTTP error is still safe. */ }
    }
    throw new PippitFacadeError({
      code: "HTTP_ERROR",
      message: `Pippit facade rejected ${input.operation} with HTTP ${response.status}.`,
      operation: input.operation,
      status: response.status,
      ...upstreamMetadata,
    })
  }
  return response
}
