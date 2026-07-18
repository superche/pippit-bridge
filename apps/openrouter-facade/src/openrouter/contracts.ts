import { z } from "zod"

const urlReferenceValue = z.object({ url: z.url().refine((value) => /^https?:/iu.test(value), "Only HTTP(S) reference URLs are supported") }).strict()

export const imageUrlReferenceSchema = z
  .object({
    image_url: urlReferenceValue,
    type: z.literal("image_url"),
  })
  .strict()

export const audioUrlReferenceSchema = z
  .object({
    audio_url: urlReferenceValue,
    type: z.literal("audio_url"),
  })
  .strict()

export const videoUrlReferenceSchema = z
  .object({
    type: z.literal("video_url"),
    video_url: urlReferenceValue,
  })
  .strict()

export const inputReferenceSchema = z.discriminatedUnion("type", [
  imageUrlReferenceSchema,
  audioUrlReferenceSchema,
  videoUrlReferenceSchema,
])

export const frameImageSchema = imageUrlReferenceSchema.extend({
  frame_type: z.enum(["first_frame", "last_frame"]),
})

const providerOptionsSchema = z.record(z.string(), z.record(z.string(), z.unknown()))

export const videoGenerationRequestSchema = z
  .object({
    aspect_ratio: z.string().trim().min(1).optional(),
    callback_url: z.url().optional(),
    duration: z.number().int().positive().max(3600).optional(),
    frame_images: z.array(frameImageSchema).max(2).optional(),
    generate_audio: z.boolean().optional(),
    input_references: z.array(inputReferenceSchema).max(15).optional(),
    model: z.string().trim().min(1),
    prompt: z.string().trim().min(1).max(20_000),
    provider: z
      .object({
        options: providerOptionsSchema.optional(),
      })
      .strict()
      .optional(),
    resolution: z.string().trim().min(1).optional(),
    seed: z.number().int().min(-1).max(4_294_967_295).optional(),
    size: z
      .string()
      .regex(/^[1-9]\d{1,4}x[1-9]\d{1,4}$/i, "size must use WIDTHxHEIGHT format")
      .optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const frameTypes = request.frame_images?.map((frame) => frame.frame_type) ?? []
    if (new Set(frameTypes).size !== frameTypes.length) {
      context.addIssue({
        code: "custom",
        message: "frame_images may contain at most one first_frame and one last_frame",
        path: ["frame_images"],
      })
    }


    if (!request.frame_images?.length) {
      const references = request.input_references ?? []
      const imageCount = references.filter((reference) => reference.type === "image_url").length
      const videoCount = references.filter((reference) => reference.type === "video_url").length
      const audioCount = references.filter((reference) => reference.type === "audio_url").length
      if (imageCount + videoCount > 9) {
        context.addIssue({
          code: "custom",
          message: "input_references supports at most 9 combined image/video references",
          path: ["input_references"],
        })
      }
      if (videoCount > 3) {
        context.addIssue({
          code: "custom",
          message: "input_references supports at most 3 video references",
          path: ["input_references"],
        })
      }
      if (audioCount > 3) {
        context.addIssue({
          code: "custom",
          message: "input_references supports at most 3 audio references",
          path: ["input_references"],
        })
      }
    }
  })

export type AudioUrlReference = z.infer<typeof audioUrlReferenceSchema>
export type FrameImage = z.infer<typeof frameImageSchema>
export type ImageUrlReference = z.infer<typeof imageUrlReferenceSchema>
export type InputReference = z.infer<typeof inputReferenceSchema>
export type VideoGenerationRequest = z.infer<typeof videoGenerationRequestSchema>
export type VideoUrlReference = z.infer<typeof videoUrlReferenceSchema>

export type VideoGenerationStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "expired"

export interface VideoGenerationJob {
  readonly error?: string
  readonly generation_id?: string | null
  readonly id: string
  readonly model?: string | null
  readonly polling_url: string
  readonly status: VideoGenerationStatus
  readonly unsigned_urls?: readonly string[]
  readonly usage?: {
    readonly cost?: number | null
    readonly is_byok?: boolean
  }
}
