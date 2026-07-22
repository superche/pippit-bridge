import { z } from "zod"
import { runtimeContract } from "../contract.js"
import { frameImageSchema, inputReferenceSchema } from "../media/references.js"

export const providerOptionsSchema = z.record(z.string(), z.record(z.string(), z.unknown()))

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
export const videoEditAnnotationSchema = z.object({
  at_ms: z.number().int().nonnegative(),
  instruction: z.string().trim().min(1).max(2_000),
  region: videoEditRegionSchema,
}).strict()
export const videoEditSegmentSchema = z.object({
  end_ms: z.number().int().positive(),
  start_ms: z.number().int().nonnegative(),
}).strict().superRefine((segment, context) => {
  if (segment.end_ms <= segment.start_ms) {
    context.addIssue({ code: "custom", message: "end_ms must be greater than start_ms", path: ["end_ms"] })
  }
  if (segment.end_ms - segment.start_ms > 30_000) {
    context.addIssue({ code: "custom", message: "The editable segment may be at most 30000 ms", path: ["end_ms"] })
  }
})

export const videoEditRequestSchema = z.object({
  annotations: z.array(videoEditAnnotationSchema).max(20).default([]),
  model: z.enum([
    "pippit/seedance-2.0-mini",
    "pippit/seedance-2.0",
    "pippit/seedance-2.0-mini-lite",
    "pippit/seedance-2.0-vision",
  ]).default("pippit/seedance-2.0-mini"),
  prompt: z.string().trim().min(1).max(20_000).optional(),
  provider: z.object({ options: providerOptionsSchema.optional() }).strict().optional(),
  resolution: z.string().trim().min(1).max(64).optional(),
  seed: z.number().int().min(-1).max(4_294_967_295).optional(),
  segment: videoEditSegmentSchema,
  source_index: z.number().int().min(0).max(1_000).default(0),
  source_job_id: z.string().trim().min(1).max(16_384),
}).strict().superRefine((request, context) => {
  if (request.prompt === undefined && request.annotations.length === 0) {
    context.addIssue({ code: "custom", message: "Provide prompt or at least one annotation", path: ["annotations"] })
  }
  for (const [index, annotation] of request.annotations.entries()) {
    if (annotation.at_ms < request.segment.start_ms || annotation.at_ms > request.segment.end_ms) {
      context.addIssue({
        code: "custom",
        message: "Annotation at_ms must fall inside segment",
        path: ["annotations", index, "at_ms"],
      })
    }
  }
})

export const videoGenerationRequestSchema = z.object({
  aspect_ratio: z.string().trim().min(1).optional(),
  callback_url: z.url().optional(),
  duration: z.number().int().positive().max(3600).optional(),
  frame_images: z.array(frameImageSchema).max(2).optional(),
  generate_audio: z.boolean().optional(),
  input_references: z.array(inputReferenceSchema).max(15).optional(),
  model: z.enum([
    "pippit/seedance-2.0-mini",
    "pippit/seedance-2.0",
    "pippit/seedance-2.0-mini-lite",
    "pippit/seedance-2.0-vision",
  ]).default("pippit/seedance-2.0-mini"),
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
