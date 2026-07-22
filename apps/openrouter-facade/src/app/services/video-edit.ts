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

export function compileVideoEditPrompt(request: VideoEditRequest): string {
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
      duration: Math.max(1, Math.ceil((request.segment.end_ms - request.segment.start_ms) / 1_000)),
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
