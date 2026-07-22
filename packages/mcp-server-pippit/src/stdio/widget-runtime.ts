import { randomUUID } from "node:crypto"
import {
  widgetGetImageInputContract,
  widgetReadImageInputContract,
  widgetReadVideoChunkInputContract,
  widgetResolveLatestVideoInputContract,
  widgetRevealImageInputContract,
  type RuntimeContract,
} from "@pippit-bridge/contracts"
import type { PippitMcpCallToolResult, PippitToolRuntime } from "../tools.ts"
import type { PippitWidgetMediaServer } from "../widget-media.ts"
import type { PippitWidgetLineageStore } from "../widget-lineage.ts"
import {
  extractPippitWidgetJob,
  projectPippitWidgetResult,
  withPippitWidgetTools,
} from "../widget-protocol.ts"
import {
  PIPPIT_GET_IMAGE_TOOL_DEFINITION,
  PIPPIT_GET_IMAGE_TOOL_NAME,
  PIPPIT_READ_IMAGE_TOOL_DEFINITION,
  PIPPIT_READ_IMAGE_TOOL_NAME,
  PIPPIT_READ_VIDEO_CHUNK_TOOL_DEFINITION,
  PIPPIT_READ_VIDEO_CHUNK_TOOL_NAME,
  PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_DEFINITION,
  PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_NAME,
  PIPPIT_REVEAL_IMAGE_TOOL_DEFINITION,
  PIPPIT_REVEAL_IMAGE_TOOL_NAME,
} from "./widget-tools.ts"

function parseWidgetInput<T>(contract: RuntimeContract<T>, value: unknown): T | undefined {
  try {
    return contract.parse(value)
  } catch {
    return undefined
  }
}

function toolFailure(code: string, message: string): PippitMcpCallToolResult {
  return {
    content: [{ text: message, type: "text" }],
    isError: true,
    structuredContent: { error: { code, message } },
  }
}

function localMediaUnavailable(): PippitMcpCallToolResult {
  return toolFailure(
    "local_media_unavailable",
    "The video completed upstream but could not be saved as a local MP4. Retry pippit_get_video; no remote media URL was returned to the player.",
  )
}

function localImageUnavailable(): PippitMcpCallToolResult {
  return toolFailure(
    "local_image_unavailable",
    "The image completed upstream but could not be saved as a local file. Retry only if the user explicitly approves another potentially billable generation.",
  )
}

export function withWidgetRuntime(
  runtime: PippitToolRuntime,
  widgetMedia: PippitWidgetMediaServer,
  widgetLineage: PippitWidgetLineageStore,
): PippitToolRuntime {
  interface ImageJobState {
    readonly model: string
    readonly result?: PippitMcpCallToolResult
  }
  const imageJobs = new Map<string, ImageJobState>()
  const pendingImageResult = (imageJobId: string, model: string): PippitMcpCallToolResult => ({
    content: [{
      text: `Image generation ${imageJobId} is in progress. Poll ${PIPPIT_GET_IMAGE_TOOL_NAME} with this image_job_id until the saved local result is ready.`,
      type: "text",
    }],
    structuredContent: { image_job_id: imageJobId, model, status: "in_progress" },
  })
  const projectImageResult = async (result: PippitMcpCallToolResult): Promise<PippitMcpCallToolResult> =>
    projectPippitWidgetResult(
      result,
      undefined,
      widgetMedia.prepareImage === undefined
        ? undefined
        : (data, mimeType) => widgetMedia.prepareImage!(data, mimeType),
    )

  return {
    async callTool(name, argumentsValue) {
      if (name === PIPPIT_READ_IMAGE_TOOL_NAME) {
        const input = parseWidgetInput(widgetReadImageInputContract, argumentsValue)
        if (input === undefined) return toolFailure("invalid_arguments", "Invalid saved image request.")
        try {
          const image = await widgetMedia.readImage?.(input.resource_uri)
          if (image === undefined) return toolFailure("local_image_unavailable", "The saved local image is unavailable.")
          return {
            content: [],
            structuredContent: {
              blob: image.blob,
              bytes: image.bytes,
              filename: image.filename,
              mime_type: image.mimeType,
              resource_uri: image.resourceUri,
            },
          }
        } catch {
          return toolFailure("local_image_unavailable", "The saved local image is unavailable.")
        }
      }
      if (name === PIPPIT_REVEAL_IMAGE_TOOL_NAME) {
        const input = parseWidgetInput(widgetRevealImageInputContract, argumentsValue)
        if (input === undefined) return toolFailure("invalid_arguments", "Invalid saved image request.")
        try {
          const revealed = await widgetMedia.revealImage?.(input.resource_uri)
          if (revealed !== true) return toolFailure("local_image_unavailable", "The saved local image is unavailable.")
          return { content: [], structuredContent: { revealed: true } }
        } catch {
          return toolFailure("local_image_reveal_failed", "The saved local image could not be shown in the system file manager.")
        }
      }
      if (name === PIPPIT_GET_IMAGE_TOOL_NAME) {
        const input = parseWidgetInput(widgetGetImageInputContract, argumentsValue)
        if (input === undefined) return toolFailure("invalid_arguments", "Invalid Pippit image job request.")
        const imageJob = imageJobs.get(input.image_job_id)
        if (imageJob === undefined) {
          return toolFailure("image_job_unavailable", "The Pippit image job is unavailable in this plugin session.")
        }
        return imageJob.result ?? pendingImageResult(input.image_job_id, imageJob.model)
      }
      if (name === "pippit_generate_image") {
        const modelValue = typeof argumentsValue === "object" && argumentsValue !== null && !Array.isArray(argumentsValue)
          ? (argumentsValue as Record<string, unknown>).model
          : undefined
        const model = typeof modelValue === "string" ? modelValue : "Pippit Seedream"
        const imageJobId = `pimg_${randomUUID().replaceAll("-", "")}`
        imageJobs.set(imageJobId, { model })
        void runtime.callTool(name, argumentsValue)
          .then(projectImageResult)
          .then(result => { imageJobs.set(imageJobId, { model, result }) })
          .catch(() => {
            imageJobs.set(imageJobId, {
              model,
              result: toolFailure("image_generation_failed", "Pippit image generation failed."),
            })
          })
        return pendingImageResult(imageJobId, model)
      }
      if (name === PIPPIT_READ_VIDEO_CHUNK_TOOL_NAME) {
        const input = parseWidgetInput(widgetReadVideoChunkInputContract, argumentsValue)
        if (input === undefined) return toolFailure("invalid_arguments", "Invalid saved video chunk request.")
        try {
          const chunk = await widgetMedia.readChunk(input.resource_uri, input.offset, input.length)
          if (chunk === undefined) {
            return toolFailure("local_media_chunk_unavailable", "The saved local video chunk is unavailable.")
          }
          return {
            content: [],
            structuredContent: {
              blob: chunk.blob,
              bytes: chunk.bytes,
              complete: chunk.complete,
              mime_type: chunk.mimeType,
              offset: chunk.offset,
              resource_uri: chunk.resourceUri,
              total_bytes: chunk.totalBytes,
            },
          }
        } catch {
          return toolFailure("local_media_chunk_unavailable", "The saved local video chunk is unavailable.")
        }
      }
      if (name === PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_NAME) {
        const input = parseWidgetInput(widgetResolveLatestVideoInputContract, argumentsValue)
        if (input === undefined) return toolFailure("invalid_arguments", "Invalid latest video request.")
        let latestJobId: string
        try {
          latestJobId = await widgetLineage.resolve(input.anchor_job_id)
        } catch {
          return toolFailure("latest_video_state_unavailable", "The latest regenerated video state is temporarily unavailable.")
        }
        const latestResult = await runtime.callTool("pippit_get_video", { job_id: latestJobId })
        try {
          return await projectPippitWidgetResult(latestResult, (jobId, index) => widgetMedia.preparePreview(jobId, index))
        } catch {
          return localMediaUnavailable()
        }
      }

      const toolCall = runtime.callTool(name, argumentsValue)
      const sourceJobId = name === "pippit_edit_video_segment" &&
        typeof argumentsValue === "object" && argumentsValue !== null && !Array.isArray(argumentsValue) &&
        typeof (argumentsValue as Record<string, unknown>).source_job_id === "string"
        ? (argumentsValue as Record<string, string>).source_job_id
        : undefined
      const lineageCompletion = sourceJobId === undefined
        ? undefined
        : toolCall.then(async result => {
            const regeneratedJob = result.isError === true ? undefined : extractPippitWidgetJob(result.structuredContent)
            if (regeneratedJob !== undefined && regeneratedJob.id !== sourceJobId) {
              await widgetLineage.record(sourceJobId, regeneratedJob.id)
            }
          })
      if (sourceJobId !== undefined && lineageCompletion !== undefined) widgetLineage.track(sourceJobId, lineageCompletion)
      const result = await toolCall
      await lineageCompletion?.catch(() => undefined)
      try {
        return await projectPippitWidgetResult(
          result,
          (jobId, index) => widgetMedia.preparePreview(jobId, index),
          widgetMedia.prepareImage === undefined
            ? undefined
            : (data, mimeType) => widgetMedia.prepareImage!(data, mimeType),
        )
      } catch {
        return name === "pippit_generate_image" ? localImageUnavailable() : localMediaUnavailable()
      }
    },
    async close() {
      try { await widgetMedia.close() } finally { await runtime.close?.() }
    },
    listTools() {
      return [
        ...withPippitWidgetTools([...runtime.listTools(), PIPPIT_GET_IMAGE_TOOL_DEFINITION]),
        PIPPIT_READ_IMAGE_TOOL_DEFINITION,
        PIPPIT_REVEAL_IMAGE_TOOL_DEFINITION,
        PIPPIT_READ_VIDEO_CHUNK_TOOL_DEFINITION,
        PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_DEFINITION,
      ]
    },
  }
}
