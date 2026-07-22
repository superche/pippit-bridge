import type { PippitFailReason, PippitVideoResult } from "@pippit-bridge/sdk"
import type { AppConfig } from "../../config.js"
import { ApiError } from "../../errors.js"
import type { JobTokenPayload } from "../../jobs/job-token.js"
import type { VideoGenerationJob, VideoGenerationStatus } from "../../openrouter/contracts.js"
import { pippitStateToOpenRouterStatus } from "../../openrouter/video-mapping.js"

export function routeUrl(config: Pick<AppConfig, "PUBLIC_BASE_URL">, path: string): string {
  return config.PUBLIC_BASE_URL ? new URL(path, config.PUBLIC_BASE_URL).toString() : path
}

export function sanitizeAccessKey(message: string, accessKey: string): string {
  return message.split(accessKey).join("[REDACTED]")
}

export function failureMessage(
  reason: PippitFailReason | undefined,
  status: VideoGenerationStatus,
): string | undefined {
  if (status !== "failed" && status !== "cancelled" && status !== "expired") return undefined
  if (typeof reason === "string" && reason) return reason
  if (typeof reason === "object" && reason) {
    return reason.message || reason.fallback_message || reason.detail || `Pippit video generation ${status}.`
  }
  return `Pippit video generation ${status}.`
}

export function presentVideoJob(input: {
  readonly accessKey: string
  readonly config: Pick<AppConfig, "PUBLIC_BASE_URL">
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
    ...(error === undefined ? {} : { error: sanitizeAccessKey(error, input.accessKey) }),
    generation_id: input.payload.run_id,
    id: input.jobId,
    model: input.payload.model,
    polling_url: routeUrl(input.config, `/api/v1/videos/${encodeURIComponent(input.jobId)}`),
    status,
    ...(status === "completed" ? { unsigned_urls: contentUrls, usage: { is_byok: true } } : {}),
  }
}
