import type { AuthenticatedApiKey } from "../../auth.js"
import { ApiError } from "../../errors.js"
import {
  type VideoEditRequest,
  type VideoGenerationJob,
} from "../../openrouter/contracts.js"
import { pippitStateToOpenRouterStatus } from "../../openrouter/video-mapping.js"
import type { QueriedJob } from "./job-query.js"
import type { VideoSubmissionRequest } from "./video-generation.js"

const MAX_COMPILED_EDIT_PROMPT_LENGTH = 20_000
const NATIVE_PARTIAL_EDIT_MODEL = "pippit/seedance-2.5"

type VideoEditSubmissionMode = "native-partial" | "reference-guided"

function formatVideoEditSeconds(timeUs: number): string {
  const fixed = (timeUs / 1_000_000).toFixed(2)
  if (fixed.endsWith("00")) return `${fixed.slice(0, -3)}.0`
  return fixed.replace(/0$/u, "")
}

function videoEditDurationSeconds(request: VideoEditRequest): number {
  const durationUs = request.time_range.end_time_us - request.time_range.start_time_us
  return Math.max(4, Math.round(durationUs / 1_000_000))
}

export function compileVideoEditPrompt(
  request: VideoEditRequest,
  mode: VideoEditSubmissionMode = request.model === NATIVE_PARTIAL_EDIT_MODEL
    ? "native-partial"
    : "reference-guided",
): string {
  const annotationGuidance = request.guidance_annotations.flatMap((annotation, index) => {
    const region = annotation.region
    const target = region.x === 0 && region.y === 0 && region.width === 1 && region.height === 1
      ? "the full intrinsic video frame"
      : `the normalized intrinsic-frame rectangle x=${region.x}, y=${region.y}, width=${region.width}, height=${region.height}`
    return [
      `Guidance annotation ${index + 1} at ${annotation.at_time_us} us targets ${target}.`,
      `Required visible change: ${annotation.instruction}`,
    ]
  })
  const startSeconds = formatVideoEditSeconds(request.time_range.start_time_us)
  const endSeconds = formatVideoEditSeconds(request.time_range.end_time_us)
  const prompt = [
    `对【@视频1】进行局部修改, 修改区间:\n${startSeconds}s - ${endSeconds}s, 修改内容：`,
    ...(mode === "reference-guided"
      ? [
          "The complete source video is attached as the ordinary video reference.",
          "Apply the requested visible change during the selected time range and preserve unrelated content as much as possible.",
        ]
      : []),
    ...(request.prompt === undefined ? [] : [request.prompt]),
    ...annotationGuidance,
    mode === "native-partial"
      ? "The provider time_range is authoritative for partial regeneration."
      : "The selected time range is generation guidance for reference-guided regeneration.",
    "Treat normalized intrinsic-frame rectangles as prompt guidance, not hard masks; preserve unrelated content outside the guided area as much as possible.",
    "Structured Bridge partial-edit contract:",
    JSON.stringify({
      guidance_annotations: request.guidance_annotations,
      instruction: request.prompt ?? null,
      time_range: request.time_range,
    }),
  ].join("\n")
  if (prompt.length > MAX_COMPILED_EDIT_PROMPT_LENGTH) {
    throw new ApiError("The compiled video edit instructions exceed the supported prompt length.", {
      code: "edit_instruction_too_long",
      param: "guidance_annotations",
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
    request: VideoSubmissionRequest,
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
    const provider = {
      options: {
        ...(request.provider?.options ?? {}),
        pippit: {
          ...(request.provider?.options?.pippit ?? {}),
          byok_id: source.payload.credential_id,
        },
      },
    }
    const mode: VideoEditSubmissionMode = request.model === NATIVE_PARTIAL_EDIT_MODEL
      ? "native-partial"
      : "reference-guided"
    const body: VideoSubmissionRequest = {
      // /skill/submit_run accepts edit references only when their Pippit asset
      // records can hydrate an EverPhoto source. A generated artifact may have
      // both IDs in get_thread while still not being upload-backed, so
      // re-enter the ordinary reference upload path and use the fresh linked
      // cloud asset_id + pippit_asset_id returned by upload_file.
      input_references: [{ type: "video_url" as const, video_url: { url: sourceUrl } }],
      ...(mode === "reference-guided" ? { duration: videoEditDurationSeconds(request) } : {}),
      model: request.model,
      ...(mode === "native-partial" ? { partialEdit: { timeRange: request.time_range } } : {}),
      prompt: compileVideoEditPrompt(request, mode),
      provider,
      ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
    }
    return input.submitVideo(caller, body, signal)
  }
}
