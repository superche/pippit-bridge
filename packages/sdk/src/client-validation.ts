import { PippitApiError, type PippitOperation } from "./errors.js"
import {
  PIPPIT_RUN_STATES,
  type PippitClientConfig,
  type PippitFailReason,
  type PippitFailReasonObject,
  type PippitFetch,
  type PippitRunState,
  type PippitSubmitRunRequest,
} from "./types.js"

export const PIPPIT_DEFAULT_BASE_URL = "https://xyq.jianying.com"
export const PIPPIT_DEFAULT_TIMEOUT_MS = 12 * 60 * 60 * 1_000

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export function isRunState(value: unknown): value is PippitRunState {
  return typeof value === "number"
    && Number.isInteger(value)
    && (PIPPIT_RUN_STATES as readonly number[]).includes(value)
}

export function invalidResponse(operation: PippitOperation): PippitApiError {
  return new PippitApiError({ code: "INVALID_RESPONSE", operation })
}

function sanitizeUpstreamCode(value: string | number, accessKey: string): string | number | undefined {
  if (typeof value === "number") return String(value).includes(accessKey) ? undefined : value
  const sanitized = value.split(accessKey).join("<redacted>")
  return sanitized.includes(accessKey) ? undefined : sanitized
}

export function readEnvelopeData(
  value: unknown,
  operation: PippitOperation,
  accessKey: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse(operation)
  const ret = value.ret
  if (typeof ret !== "string" && typeof ret !== "number") throw invalidResponse(operation)
  if (ret !== 0 && ret !== "0") {
    const upstreamCode = sanitizeUpstreamCode(ret, accessKey)
    throw new PippitApiError({
      code: "UPSTREAM_ERROR",
      operation,
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
    })
  }
  if (!isRecord(value.data)) throw invalidResponse(operation)
  return value.data
}

export function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  operation: PippitOperation,
): string | undefined {
  const value = record[key]
  if (value === undefined || value === null || value === "") return undefined
  if (!isNonEmptyString(value)) throw invalidResponse(operation)
  return value
}

export function readStringArray(
  record: Record<string, unknown>,
  key: string,
  operation: PippitOperation,
): string[] {
  const value = record[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) throw invalidResponse(operation)
  return [...value]
}

function readOptionalStringField(
  record: Record<string, unknown>,
  key: string,
  operation: PippitOperation,
): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw invalidResponse(operation)
  return value
}

function parseStringMap(value: unknown, operation: PippitOperation): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value) || !Object.values(value).every(item => typeof item === "string")) {
    throw invalidResponse(operation)
  }
  return { ...value } as Record<string, string>
}

export function parseFailReason(value: unknown, operation: PippitOperation): PippitFailReason | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  if (!isRecord(value)) throw invalidResponse(operation)

  const result: PippitFailReasonObject = {}
  if (value.code !== undefined && value.code !== null) {
    if (typeof value.code !== "number" || !Number.isFinite(value.code)) throw invalidResponse(operation)
    result.code = value.code
  }
  if (value.is_not_retryable !== undefined && value.is_not_retryable !== null) {
    if (typeof value.is_not_retryable !== "boolean") throw invalidResponse(operation)
    result.is_not_retryable = value.is_not_retryable
  }
  const extra = parseStringMap(value.extra, operation)
  if (extra !== undefined) result.extra = extra
  for (const key of ["message", "starling_key", "payload", "fallback_message", "detail"] as const) {
    const field = readOptionalStringField(value, key, operation)
    if (field !== undefined) result[key] = field
  }
  return result
}

export function normalizeAccessKey(accessKey: string, operation: PippitOperation): string {
  if (!isNonEmptyString(accessKey)) throw new PippitApiError({ code: "INVALID_INPUT", operation })
  const normalized = accessKey.trim()
  if (!/^[\x21-\x7e]+$/.test(normalized)) throw new PippitApiError({ code: "INVALID_INPUT", operation })
  return normalized
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value)
}

function isMediaReference(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.pippit_asset_id)) return false
  if (!isOptionalNonEmptyString(value.asset_id) || !isOptionalNonEmptyString(value.url)) return false
  return value.security_check_scene === undefined
    || (Array.isArray(value.security_check_scene) && value.security_check_scene.every(isNonEmptyString))
}

export function validateSubmitRequest(value: PippitSubmitRunRequest, operation: PippitOperation): void {
  if (!isRecord(value) || !isNonEmptyString(value.message) || !isOptionalNonEmptyString(value.thread_id)) {
    throw new PippitApiError({ code: "INVALID_INPUT", operation })
  }
  if ("general_agent_settings" in value) {
    const assetIds = value.asset_ids
    const settings = value.general_agent_settings
    const imageCount = isRecord(settings) ? settings.generate_image_count : undefined
    if (
      (assetIds !== undefined && (!Array.isArray(assetIds) || assetIds.length > 9 || !assetIds.every(isNonEmptyString)))
      || !isRecord(settings)
      || (settings.image_model !== "seedream_5.0" && settings.image_model !== "seedream_5.0_pro")
      || (imageCount !== undefined && (typeof imageCount !== "number" || !Number.isSafeInteger(imageCount) || imageCount <= 0))
    ) throw new PippitApiError({ code: "INVALID_INPUT", operation })
    if (settings.image_model === "seedream_5.0" && settings.resolution !== undefined) {
      throw new PippitApiError({ code: "INVALID_INPUT", operation })
    }
    if (
      settings.image_model === "seedream_5.0_pro"
      && settings.resolution !== undefined
      && !["1K", "2K", "4K"].includes(String(settings.resolution))
    ) throw new PippitApiError({ code: "INVALID_INPUT", operation })
    return
  }

  if (
    !("video_part_tool_param" in value)
    || !Array.isArray(value.asset_ids)
    || !value.asset_ids.every(isNonEmptyString)
    || !isRecord(value.video_part_tool_param)
  ) throw new PippitApiError({ code: "INVALID_INPUT", operation })

  const params = value.video_part_tool_param
  if (
    !isNonEmptyString(params.model)
    || !isNonEmptyString(params.prompt)
    || typeof params.duration_sec !== "number"
    || !Number.isFinite(params.duration_sec)
    || params.duration_sec <= 0
    || !isOptionalNonEmptyString(params.ratio)
    || !isOptionalNonEmptyString(params.resolution)
    || (params.generate_type !== undefined && params.generate_type !== 0 && params.generate_type !== 1)
    || (params.seed !== undefined && !Number.isSafeInteger(params.seed))
  ) throw new PippitApiError({ code: "INVALID_INPUT", operation })

  for (const key of ["images", "videos", "audios"] as const) {
    const references = params[key]
    if (references !== undefined && (!Array.isArray(references) || !references.every(isMediaReference))) {
      throw new PippitApiError({ code: "INVALID_INPUT", operation })
    }
  }
}

export function stringifyJson(value: unknown, operation: PippitOperation): string {
  try {
    const result = JSON.stringify(value)
    if (typeof result === "string") return result
  } catch {
    // The fixed typed error below intentionally discards the serialization cause.
  }
  throw new PippitApiError({ code: "INVALID_INPUT", operation })
}

export function validateConfig(config: PippitClientConfig): {
  baseUrl: string
  fetchImpl: PippitFetch
  timeoutMs: number
} {
  const operation = "client"
  const timeoutMs = config.timeoutMs ?? PIPPIT_DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new PippitApiError({ code: "INVALID_INPUT", operation })
  }
  let url: URL
  try {
    url = new URL(config.baseUrl ?? PIPPIT_DEFAULT_BASE_URL)
  } catch {
    throw new PippitApiError({ code: "INVALID_INPUT", operation })
  }
  const localDevelopmentHttp = url.protocol === "http:"
    && new Set(["127.0.0.1", "::1", "localhost"]).has(url.hostname)
  if ((url.protocol !== "https:" && !localDevelopmentHttp) || url.username || url.password) {
    throw new PippitApiError({ code: "INVALID_INPUT", operation })
  }
  url.search = ""
  url.hash = ""
  const fetchImpl = config.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== "function") throw new PippitApiError({ code: "INVALID_INPUT", operation })
  return { baseUrl: url.toString().replace(/\/+$/, ""), fetchImpl, timeoutMs }
}
