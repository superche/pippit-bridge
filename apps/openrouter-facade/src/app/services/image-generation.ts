import { ReferenceLoadError, type ReferenceLoader } from "@pippit-bridge/core"
import type { PippitApi, PippitVideoResult } from "@pippit-bridge/sdk"
import type { AuthenticatedApiKey } from "../../auth.js"
import type { ByokStore } from "../../byok/index.js"
import type { AppConfig } from "../../config.js"
import { ApiError, invalidRequest } from "../../errors.js"
import {
  prepareImageReferences,
  readPippitProviderOptions,
  type ReferenceWorkGate,
} from "../../media/prepare-references.js"
import type { ImageGenerationRequest, ImageGenerationResponse } from "../../openrouter/contracts.js"
import { pippitStateToOpenRouterStatus } from "../../openrouter/video-mapping.js"
import { failureMessage, sanitizeAccessKey } from "../presenters/jobs.js"
import { canTryNextByokCredential, noEligibleByokCredential } from "./generation-shared.js"
import { resolveFacadeImageModel } from "./models.js"

function waitForPollDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new ApiError("The request was cancelled.", {
      code: "request_cancelled", statusCode: 408, type: "api_error",
    }))
  }
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolveDelay()
    }, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      rejectDelay(new ApiError("The request was cancelled.", {
        code: "request_cancelled", statusCode: 408, type: "api_error",
      }))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export function createImageGenerationService(input: {
  readonly byokStore: ByokStore
  readonly config: AppConfig
  readonly pippit: PippitApi
  readonly referenceGate: ReferenceWorkGate
  readonly referenceLoader: ReferenceLoader
}): (
  caller: AuthenticatedApiKey,
  request: ImageGenerationRequest,
  signal: AbortSignal,
) => Promise<ImageGenerationResponse> {
  return async (caller, request, signal) => {
    const model = resolveFacadeImageModel(request.model)
    if (model.upstreamModel === "seedream_5.0" && request.resolution !== undefined) {
      throw invalidRequest(
        "resolution is not supported by pippit/seedream-5.0; omit the field entirely.",
        "resolution",
        "unsupported_parameter",
      )
    }

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

    let selectedAccessKey: string | undefined
    let submitted: Awaited<ReturnType<PippitApi["submitRun"]>> | undefined
    for (const [index, candidate] of candidates.entries()) {
      try {
        const assetIds = await prepareImageReferences({
          accessKey: candidate.accessKey,
          concurrency: input.config.REFERENCE_UPLOAD_CONCURRENCY,
          gate: input.referenceGate,
          loader: input.referenceLoader,
          maxTotalBytes: input.config.REFERENCE_MAX_TOTAL_BYTES,
          pippit: input.pippit,
          request,
          signal,
        })
        submitted = await input.pippit.submitRun({
          accessKey: candidate.accessKey,
          request: {
            ...(assetIds.length === 0 ? {} : { asset_ids: [...assetIds] }),
            general_agent_settings: {
              generate_image_count: request.n,
              image_model: model.upstreamModel,
              ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
            },
            message: request.prompt,
            ...(providerOptions.thread_id === undefined ? {} : { thread_id: providerOptions.thread_id }),
          },
          signal,
        })
        selectedAccessKey = candidate.accessKey
        break
      } catch (error) {
        const hasNextCandidate = index + 1 < candidates.length
        if (!hasNextCandidate || !canTryNextByokCredential(error)) throw error
      }
    }
    if (selectedAccessKey === undefined || submitted === undefined) throw noEligibleByokCredential()

    const deadline = Date.now() + input.config.IMAGE_GENERATION_TIMEOUT_MS
    let result: PippitVideoResult
    while (true) {
      result = await input.pippit.queryVideoResult({
        accessKey: selectedAccessKey,
        runId: submitted.run.runId,
        signal,
        threadId: submitted.run.threadId,
      })
      const status = pippitStateToOpenRouterStatus(result.runState)
      if (status === "completed") break
      if (status === "failed" || status === "cancelled" || status === "expired") {
        const detail = failureMessage(result.failReason, status) ?? `Pippit image generation ${status}.`
        throw new ApiError(sanitizeAccessKey(detail, selectedAccessKey), {
          code: "image_generation_failed", statusCode: 502, type: "upstream_error",
        })
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new ApiError("Pippit image generation timed out.", {
          code: "upstream_timeout", statusCode: 504, type: "upstream_error",
        })
      }
      await waitForPollDelay(Math.min(input.config.IMAGE_GENERATION_POLL_INTERVAL_MS, remaining), signal)
    }

    if (result.imageUrls.length === 0) {
      throw new ApiError("Pippit marked the run completed without returning an image URL.", {
        code: "invalid_upstream_response", statusCode: 502, type: "upstream_error",
      })
    }

    const data: Array<{ b64_json: string; media_type?: string }> = []
    let totalBytes = 0
    for (const imageUrl of result.imageUrls) {
      const image = await input.referenceLoader.load(imageUrl, "image", signal)
      totalBytes += image.bytes.byteLength
      if (totalBytes > input.config.REFERENCE_MAX_TOTAL_BYTES) throw new ReferenceLoadError("TOTAL_TOO_LARGE")
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
  }
}
