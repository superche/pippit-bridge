import type { AuthenticatedApiKey } from "../../auth.js"
import { ApiError } from "../../errors.js"
import {
  type VideoEditRequest,
  type VideoGenerationJob,
  type VideoGenerationRequest,
  videoGenerationRequestSchema,
} from "../../openrouter/contracts.js"
import { pippitStateToOpenRouterStatus } from "../../openrouter/video-mapping.js"
import type { QueriedJob } from "./job-query.js"

const MAX_COMPILED_EDIT_PROMPT_LENGTH = 20_000

function videoEditDurationSeconds(request: VideoEditRequest): number {
  const durationMs = request.segment.end_ms - request.segment.start_ms
  return Math.max(1, Math.round(durationMs / 1_000))
}

export function compileVideoEditPrompt(request: VideoEditRequest): string {
  const annotationGuidance = request.annotations.flatMap((annotation, index) => {
    const region = annotation.region
    const target = region.x === 0 && region.y === 0 && region.width === 1 && region.height === 1
      ? "the full intrinsic video frame"
      : `the normalized intrinsic-frame rectangle x=${region.x}, y=${region.y}, width=${region.width}, height=${region.height}`
    return [
      `Annotation ${index + 1} at ${annotation.at_ms} ms targets ${target}.`,
      `Required visible change: ${annotation.instruction}`,
    ]
  })
  const prompt = [
    "Pippit reference-guided video regeneration instruction v2.",
    "The complete source video is attached as the only video reference.",
    `Apply the requested change decisively during ${request.segment.start_ms}-${request.segment.end_ms} ms; do not return a visually unchanged copy when a visible change is requested.`,
    ...annotationGuidance,
    ...(request.prompt === undefined ? [] : [`Overall guidance: ${request.prompt}`]),
    "Treat the time segment and normalized intrinsic-frame rectangles as generation guidance, not hard masks; preserve unrelated content outside the guided area as much as possible.",
    "Structured Bridge edit contract:",
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

export function editSourceVideoUrl(result: QueriedJob["result"], index: number): string {
  const status = pippitStateToOpenRouterStatus(result.runState)
  if (status !== "completed") {
    throw new ApiError(`The source video is not available while its job is ${status}.`, {
      code: "source_video_not_ready", param: "source_job_id", statusCode: 400, type: "invalid_request_error",
    })
  }
  const videoUrl = result.videoUrls[index]
  if (videoUrl === undefined) {
    throw new ApiError(`Source video output index ${index} does not exist.`, {
      code: "source_video_output_not_found", param: "source_index", statusCode: 404, type: "not_found_error",
    })
  }
  let parsed: URL
  try {
    parsed = new URL(videoUrl)
  } catch {
    throw new ApiError("Pippit returned an invalid source video URL.", {
      code: "invalid_upstream_response", statusCode: 502, type: "upstream_error",
    })
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw new ApiError("Pippit returned an unsupported source video URL.", {
      code: "invalid_upstream_response", statusCode: 502, type: "upstream_error",
    })
  }
  return parsed.toString()
}

export function createVideoEditService(input: {
  readonly queryJob: (caller: AuthenticatedApiKey, jobId: string, signal: AbortSignal) => Promise<QueriedJob>
  readonly submitVideo: (
    caller: AuthenticatedApiKey,
    request: VideoGenerationRequest,
    signal: AbortSignal,
  ) => Promise<VideoGenerationJob>
}): (
  caller: AuthenticatedApiKey,
  request: VideoEditRequest,
  signal: AbortSignal,
) => Promise<VideoGenerationJob> {
  return async (caller, request, signal) => {
    const source = await input.queryJob(caller, request.source_job_id, signal)
    const sourceUrl = editSourceVideoUrl(source.result, request.source_index)
    const body = videoGenerationRequestSchema.parse({
      duration: videoEditDurationSeconds(request),
      input_references: [{ type: "video_url", video_url: { url: sourceUrl } }],
      model: request.model,
      prompt: compileVideoEditPrompt(request),
      ...(request.provider === undefined ? {} : { provider: request.provider }),
      ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
    })
    return input.submitVideo(caller, body, signal)
  }
}
