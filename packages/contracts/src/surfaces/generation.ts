import { z } from "zod"
import { runtimeContract } from "../contract.js"
import { frameImageSchema, inputReferenceSchema } from "../media/references.js"

export const providerOptionsSchema = z.record(z.string(), z.record(z.string(), z.unknown()))

export const PIPPIT_VIDEO_MODEL_IDS = [
  "pippit/seedance-2.5",
  "pippit/seedance-2.0-vision",
  "pippit/seedance-2.0-mini",
  "pippit/seedance-2.0-mini-lite",
] as const
export const PIPPIT_DEFAULT_VIDEO_MODEL_ID = "pippit/seedance-2.5"
export const PIPPIT_PARTIAL_EDIT_VIDEO_MODEL_IDS = PIPPIT_VIDEO_MODEL_IDS
export const PIPPIT_DEFAULT_PARTIAL_EDIT_VIDEO_MODEL_ID = "pippit/seedance-2.0-vision"
export const PIPPIT_PARTIAL_EDIT_MIN_DURATION_US = 4_000_000
export const PIPPIT_PARTIAL_EDIT_2_0_MAX_DURATION_US = 15_000_000
export const PIPPIT_PARTIAL_EDIT_2_5_MAX_DURATION_US = 30_200_000

export const videoModelIdSchema = z.enum(PIPPIT_VIDEO_MODEL_IDS)
export const partialEditVideoModelIdSchema = z.enum(PIPPIT_PARTIAL_EDIT_VIDEO_MODEL_IDS)

export function partialEditDurationError(
  model: (typeof PIPPIT_PARTIAL_EDIT_VIDEO_MODEL_IDS)[number],
  timeRange: { readonly end_time_us: number; readonly start_time_us: number },
): string | undefined {
  const durationUs = timeRange.end_time_us - timeRange.start_time_us
  const maximumUs = model === "pippit/seedance-2.5"
    ? PIPPIT_PARTIAL_EDIT_2_5_MAX_DURATION_US
    : PIPPIT_PARTIAL_EDIT_2_0_MAX_DURATION_US
  if (durationUs < PIPPIT_PARTIAL_EDIT_MIN_DURATION_US || durationUs > maximumUs) {
    const maximumSeconds = maximumUs / 1_000_000
    return `Partial edit duration must be between 4 and ${maximumSeconds} seconds for ${model}`
  }
  return undefined
}

const imageReferenceUrl = z.string().refine(value => {
  if (/^data:image\/(?:avif|bmp|gif|jpeg|png|webp);base64,/iu.test(value)) return true
  try { return /^https?:$/u.test(new URL(value).protocol) } catch { return false }
}, "Image references must use HTTP(S) or a supported base64 image data URL")

export const imageGenerationReferenceSchema = z.object({
  image_url: z.object({ url: imageReferenceUrl }).strict(),
  type: z.literal("image_url"),
}).strict()

export const imageGenerationRequestSchema = z.object({
  input_references: z.array(imageGenerationReferenceSchema).max(9).optional(),
  model: z.enum(["pippit/seedream-5.0", "pippit/seedream-5.0-pro"]).default("pippit/seedream-5.0"),
  n: z.number().int().min(1).max(10).default(1),
  prompt: z.string().trim().min(1).max(20_000),
  provider: z.object({ options: providerOptionsSchema.optional() }).strict().optional(),
  resolution: z.enum(["1K", "2K", "4K"]).optional(),
}).strict()

const normalizedCoordinateSchema = z.number().min(0).max(1)
const normalizedExtentSchema = z.number().positive().max(1)
export const videoEditRegionSchema = z.object({
  height: normalizedExtentSchema,
  width: normalizedExtentSchema,
  x: normalizedCoordinateSchema,
  y: normalizedCoordinateSchema,
}).strict().superRefine((region, context) => {
  if (region.x + region.width > 1) {
    context.addIssue({ code: "custom", message: "x + width must be at most 1", path: ["width"] })
  }
  if (region.y + region.height > 1) {
    context.addIssue({ code: "custom", message: "y + height must be at most 1", path: ["height"] })
  }
})
export const videoEditGuidanceAnnotationSchema = z.object({
  at_time_us: z.number().int().nonnegative(),
  instruction: z.string().trim().min(1).max(2_000),
  region: videoEditRegionSchema,
}).strict()
export const videoEditTimeRangeSchema = z.object({
  end_time_us: z.number().int().positive(),
  start_time_us: z.number().int().nonnegative(),
}).strict().superRefine((timeRange, context) => {
  if (timeRange.end_time_us <= timeRange.start_time_us) {
    context.addIssue({
      code: "custom",
      message: "end_time_us must be greater than start_time_us",
      path: ["end_time_us"],
    })
  }
})

export const videoEditRequestSchema = z.object({
  guidance_annotations: z.array(videoEditGuidanceAnnotationSchema).max(20).default([]),
  model: partialEditVideoModelIdSchema.default(PIPPIT_DEFAULT_PARTIAL_EDIT_VIDEO_MODEL_ID),
  prompt: z.string().trim().min(1).max(20_000).optional(),
  provider: z.object({ options: providerOptionsSchema.optional() }).strict().optional(),
  resolution: z.string().trim().min(1).max(64).optional(),
  seed: z.number().int().min(-1).max(4_294_967_295).optional(),
  source_index: z.number().int().min(0).max(1_000).default(0),
  source_job_id: z.string().trim().min(1).max(16_384),
  time_range: videoEditTimeRangeSchema,
}).strict().superRefine((request, context) => {
  if (request.prompt === undefined && request.guidance_annotations.length === 0) {
    context.addIssue({
      code: "custom",
      message: "Provide prompt or at least one guidance annotation",
      path: ["guidance_annotations"],
    })
  }
  for (const [index, annotation] of request.guidance_annotations.entries()) {
    if (
      annotation.at_time_us < request.time_range.start_time_us
      || annotation.at_time_us > request.time_range.end_time_us
    ) {
      context.addIssue({
        code: "custom",
        message: "Guidance annotation at_time_us must fall inside time_range",
        path: ["guidance_annotations", index, "at_time_us"],
      })
    }
  }
  const durationError = partialEditDurationError(request.model, request.time_range)
  if (durationError !== undefined) {
    context.addIssue({
      code: "custom",
      message: durationError,
      path: ["time_range"],
    })
  }
})

export const videoGenerationRequestSchema = z.object({
  aspect_ratio: z.string().trim().min(1).optional(),
  callback_url: z.url().optional(),
  duration: z.number().int().positive().max(3600).optional(),
  frame_images: z.array(frameImageSchema).max(2).optional(),
  generate_audio: z.boolean().optional(),
  input_references: z.array(inputReferenceSchema).max(15).optional(),
  model: videoModelIdSchema.default(PIPPIT_DEFAULT_VIDEO_MODEL_ID),
  prompt: z.string().trim().min(1).max(20_000),
  provider: z.object({ options: providerOptionsSchema.optional() }).strict().optional(),
  resolution: z.string().trim().min(1).optional(),
  seed: z.number().int().min(-1).max(4_294_967_295).optional(),
  size: z.string().regex(/^[1-9]\d{1,4}x[1-9]\d{1,4}$/i, "size must use WIDTHxHEIGHT format").optional(),
}).strict().superRefine((request, context) => {
  const frameTypes = request.frame_images?.map(frame => frame.frame_type) ?? []
  if (new Set(frameTypes).size !== frameTypes.length) {
    context.addIssue({
      code: "custom",
      message: "frame_images may contain at most one first_frame and one last_frame",
      path: ["frame_images"],
    })
  }
  if (!request.frame_images?.length) {
    const references = request.input_references ?? []
    const imageCount = references.filter(reference => reference.type === "image_url").length
    const videoCount = references.filter(reference => reference.type === "video_url").length
    const audioCount = references.filter(reference => reference.type === "audio_url").length
    if (imageCount + videoCount > 9) {
      context.addIssue({
        code: "custom",
        message: "input_references supports at most 9 combined image/video references",
        path: ["input_references"],
      })
    }
    if (videoCount > 3) {
      context.addIssue({ code: "custom", message: "input_references supports at most 3 video references", path: ["input_references"] })
    }
    if (audioCount > 3) {
      context.addIssue({ code: "custom", message: "input_references supports at most 3 audio references", path: ["input_references"] })
    }
  }
})

export const imageGenerationRequestContract = runtimeContract(imageGenerationRequestSchema)
export const videoEditRequestContract = runtimeContract(videoEditRequestSchema)
export const videoGenerationRequestContract = runtimeContract(videoGenerationRequestSchema)

export type ImageGenerationReference = z.infer<typeof imageGenerationReferenceSchema>
export type ImageGenerationRequest = z.infer<typeof imageGenerationRequestSchema>
export type VideoEditRequest = z.infer<typeof videoEditRequestSchema>
export type VideoGenerationRequest = z.infer<typeof videoGenerationRequestSchema>
