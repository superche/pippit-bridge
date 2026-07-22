import type {
  PippitEditVideoSegmentToolInput,
  PippitGenerateImageToolInput,
  PippitGenerateVideoToolInput,
  PippitImageGenerateRequest,
  PippitImageGenerationResponse,
  PippitVideoEditRequest,
  PippitVideoGenerateRequest,
} from "../contracts.ts"
import { PippitFacadeError } from "../client.ts"
import type { PippitMcpCallToolResult } from "./contract.ts"
import { isRecord, ToolInputError } from "./inputs.ts"

export function facadeRequest(input: PippitGenerateVideoToolInput): PippitVideoGenerateRequest {
  return {
    ...(input.aspect_ratio === undefined ? {} : { aspect_ratio: input.aspect_ratio }),
    ...(input.duration === undefined ? {} : { duration: input.duration }),
    ...(input.frame_images === undefined ? {} : { frame_images: input.frame_images }),
    ...(input.input_references === undefined ? {} : { input_references: input.input_references }),
    model: input.model,
    prompt: input.prompt,
    ...(input.byok_id === undefined && input.thread_id === undefined
      ? {}
      : {
          provider: {
            options: {
              pippit: {
                ...(input.byok_id === undefined ? {} : { byok_id: input.byok_id }),
                ...(input.thread_id === undefined ? {} : { thread_id: input.thread_id }),
              },
            },
          },
        }),
    ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
    ...(input.seed === undefined ? {} : { seed: input.seed }),
  }
}

export function facadeImageRequest(input: PippitGenerateImageToolInput): PippitImageGenerateRequest {
  return {
    ...(input.images === undefined ? {} : { input_references: input.images }),
    model: input.model,
    ...(input.n === undefined ? {} : { n: input.n }),
    prompt: input.prompt,
    ...(input.byok_id === undefined && input.thread_id === undefined
      ? {}
      : {
          provider: {
            options: {
              pippit: {
                ...(input.byok_id === undefined ? {} : { byok_id: input.byok_id }),
                ...(input.thread_id === undefined ? {} : { thread_id: input.thread_id }),
              },
            },
          },
        }),
    ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
  }
}

export function facadeEditRequest(input: PippitEditVideoSegmentToolInput): PippitVideoEditRequest {
  return {
    annotations: input.annotations,
    model: input.model,
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.byok_id === undefined && input.thread_id === undefined
      ? {}
      : {
          provider: {
            options: {
              pippit: {
                ...(input.byok_id === undefined ? {} : { byok_id: input.byok_id }),
                ...(input.thread_id === undefined ? {} : { thread_id: input.thread_id }),
              },
            },
          },
        }),
    ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    segment: input.segment,
    source_index: input.source_index,
    source_job_id: input.source_job_id,
  }
}

export function structuredResult(value: object): PippitMcpCallToolResult {
  return {
    content: [{ text: JSON.stringify(value), type: "text" }],
    structuredContent: value as Readonly<Record<string, unknown>>,
  }
}

export function imageResult(value: PippitImageGenerationResponse): PippitMcpCallToolResult {
  const images = value.data.map(image => ({ media_type: image.media_type ?? "image/png" }))
  return {
    content: [
      {
        text: `Generated ${images.length} image${images.length === 1 ? "" : "s"} with ${value.model}. The inline result card displays the images and can reveal each persistent local file in Finder or the system file manager; do not regenerate when the user asks for the same file.`,
        type: "text",
      },
      ...value.data.map(image => ({
        data: image.b64_json,
        mimeType: image.media_type ?? "image/png",
        type: "image" as const,
      })),
    ],
    structuredContent: {
      created: value.created,
      images,
      model: value.model,
      usage: value.usage,
    },
  }
}

export function safeError(error: unknown): PippitMcpCallToolResult {
  const message = error instanceof ToolInputError || error instanceof PippitFacadeError
    ? error.message
    : isRecord(error) && error.code === "EEXIST"
      ? "Output file already exists; choose a new output_path."
      : "Pippit tool could not complete the operation."
  return { content: [{ text: message.slice(0, 2_000), type: "text" }], isError: true }
}
