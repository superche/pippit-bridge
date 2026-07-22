import type { PippitApi } from "@pippit-bridge/sdk"
import type { AuthenticatedApiKey } from "../../auth.js"
import type { ByokStore } from "../../byok/index.js"
import type { AppConfig } from "../../config.js"
import { invalidRequest } from "../../errors.js"
import { createJobId } from "../../jobs/job-token.js"
import {
  prepareReferences,
  readPippitProviderOptions,
  type ReferenceWorkGate,
} from "../../media/prepare-references.js"
import type { VideoGenerationJob, VideoGenerationRequest } from "../../openrouter/contracts.js"
import { pippitStateToOpenRouterStatus, resolveOutputGeometry } from "../../openrouter/video-mapping.js"
import type { ReferenceLoader } from "@pippit-bridge/core"
import { routeUrl } from "../presenters/jobs.js"
import { canTryNextByokCredential, noEligibleByokCredential } from "./generation-shared.js"
import { resolveFacadeVideoModel } from "./models.js"

function rejectUnsupportedParameters(request: Pick<VideoGenerationRequest, "callback_url" | "generate_audio">): void {
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

export function createVideoGenerationService(input: {
  readonly byokStore: ByokStore
  readonly config: AppConfig
  readonly pippit: PippitApi
  readonly referenceGate: ReferenceWorkGate
  readonly referenceLoader: ReferenceLoader
}): (
  caller: AuthenticatedApiKey,
  request: VideoGenerationRequest,
  signal: AbortSignal,
) => Promise<VideoGenerationJob> {
  return async (caller, request, signal) => {
    const model = resolveFacadeVideoModel(request.model)
    rejectUnsupportedParameters(request)
    const geometry = resolveOutputGeometry(request, model)
    const providerOptions = readPippitProviderOptions(request)
    const workspaceId = await input.byokStore.getWorkspaceId()
    const candidates = await input.byokStore.resolveCandidates({
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

    for (const [index, candidate] of candidates.entries()) {
      try {
        const references = await prepareReferences({
          accessKey: candidate.accessKey,
          concurrency: input.config.REFERENCE_UPLOAD_CONCURRENCY,
          gate: input.referenceGate,
          loader: input.referenceLoader,
          maxTotalBytes: input.config.REFERENCE_MAX_TOTAL_BYTES,
          maxTotalBytesByKind: { audio: input.config.REFERENCE_MAX_AUDIO_BYTES },
          pippit: input.pippit,
          request,
          signal,
        })
        const submitted = await input.pippit.submitRun({
          accessKey: candidate.accessKey,
          request: {
            asset_ids: [...references.assetIds],
            message: request.prompt,
            ...(providerOptions.thread_id === undefined ? {} : { thread_id: providerOptions.thread_id }),
            video_part_tool_param: {
              ...(references.audios.length === 0 ? {} : { audios: [...references.audios] }),
              duration_sec: request.duration ?? 5,
              ...(references.generateType === undefined ? {} : { generate_type: references.generateType }),
              ...(references.images.length === 0 ? {} : { images: [...references.images] }),
              model: model.upstreamModel,
              prompt: request.prompt,
              ...(geometry.aspectRatio === undefined ? {} : { ratio: geometry.aspectRatio }),
              ...(geometry.resolution === undefined ? {} : { resolution: geometry.resolution }),
              ...(request.seed === undefined ? {} : { seed: request.seed }),
              ...(references.videos.length === 0 ? {} : { videos: [...references.videos] }),
            },
          },
          signal,
        })
        const jobId = createJobId({
          created_at: Date.now(),
          credential_id: candidate.credential.id,
          credential_version_id: candidate.keyVersion.id,
          model: model.id,
          run_id: submitted.run.runId,
          thread_id: submitted.run.threadId,
          workspace_id: workspaceId,
        }, caller.apiKey, input.config.JOB_SIGNING_KEY_HEX)
        return {
          generation_id: submitted.run.runId,
          id: jobId,
          model: model.id,
          polling_url: routeUrl(input.config, `/api/v1/videos/${encodeURIComponent(jobId)}`),
          status: pippitStateToOpenRouterStatus(submitted.run.state),
          usage: { is_byok: true },
        }
      } catch (error) {
        const hasNextCandidate = index + 1 < candidates.length
        if (!hasNextCandidate || !canTryNextByokCredential(error)) throw error
      }
    }
    throw noEligibleByokCredential()
  }
}
