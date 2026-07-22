import { z } from "zod"

const HTTP_URL_PATTERN = /^https?:/iu

const httpUrl = z.url().refine((value) => HTTP_URL_PATTERN.test(value), "Only HTTP(S) URLs are supported")

export const chatGptFileSchema = z
  .object({
    download_url: httpUrl,
    file_id: z.string().trim().min(1),
    file_name: z.string().trim().min(1).optional(),
    mime_type: z.string().trim().min(1).optional(),
  })
  .strict()

export type ChatGptFile = z.infer<typeof chatGptFileSchema>

export const CHATGPT_GENERATE_INPUT_SHAPE = {
  aspect_ratio: z.string().trim().min(1).optional(),
  audio_urls: z.array(httpUrl).max(3).optional(),
  audios: z.array(chatGptFileSchema).max(3).optional(),
  byok_id: z.string().trim().min(1).optional(),
  duration: z.number().int().positive().max(3_600).optional(),
  first_frame: chatGptFileSchema.optional(),
  first_frame_url: httpUrl.optional(),
  idempotency_key: z.string().trim().min(1).max(200),
  image_urls: z.array(httpUrl).max(9).optional(),
  images: z.array(chatGptFileSchema).max(9).optional(),
  last_frame: chatGptFileSchema.optional(),
  last_frame_url: httpUrl.optional(),
  model: z.string().trim().min(1),
  prompt: z.string().trim().min(1).max(20_000),
  resolution: z.string().trim().min(1).optional(),
  seed: z.number().int().min(-1).max(4_294_967_295).optional(),
  thread_id: z.string().trim().min(1).optional(),
  video_urls: z.array(httpUrl).max(3).optional(),
  videos: z.array(chatGptFileSchema).max(3).optional(),
}

export const chatGptGenerateInputSchema = z
  .object(CHATGPT_GENERATE_INPUT_SHAPE)
  .strict()
  .superRefine((input, context) => {
    if (input.first_frame !== undefined && input.first_frame_url !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Provide first_frame or first_frame_url, not both.",
        path: ["first_frame"],
      })
    }
    if (input.last_frame !== undefined && input.last_frame_url !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Provide last_frame or last_frame_url, not both.",
        path: ["last_frame"],
      })
    }

    const frameCount = [
      input.first_frame,
      input.first_frame_url,
      input.last_frame,
      input.last_frame_url,
    ].filter((value) => value !== undefined).length
    const imageCount = (input.images?.length ?? 0) + (input.image_urls?.length ?? 0)
    const videoCount = (input.videos?.length ?? 0) + (input.video_urls?.length ?? 0)
    const audioCount = (input.audios?.length ?? 0) + (input.audio_urls?.length ?? 0)

    if (frameCount > 0 && imageCount + videoCount + audioCount > 0) {
      context.addIssue({
        code: "custom",
        message: "Frame inputs cannot be combined with general image, video, or audio references.",
        path: ["first_frame"],
      })
    }
    if (imageCount + videoCount > 9) {
      context.addIssue({
        code: "custom",
        message: "At most 9 combined image and video references are supported.",
        path: ["images"],
      })
    }
    if (videoCount > 3) {
      context.addIssue({ code: "custom", message: "At most 3 video references are supported.", path: ["videos"] })
    }
    if (audioCount > 3) {
      context.addIssue({ code: "custom", message: "At most 3 audio references are supported.", path: ["audios"] })
    }
  })

export type ChatGptGenerateInput = z.infer<typeof chatGptGenerateInputSchema>

export const CHATGPT_IMAGE_INPUT_SHAPE = {
  byok_id: z.string().trim().min(1).max(256).optional(),
  image_urls: z.array(httpUrl).max(9).optional(),
  images: z.array(chatGptFileSchema).max(9).optional(),
  model: z.enum(["pippit/seedream-5.0", "pippit/seedream-5.0-pro"]),
  n: z.number().int().min(1).max(10).optional(),
  prompt: z.string().trim().min(1).max(20_000),
  resolution: z.enum(["1K", "2K", "4K"]).optional(),
  thread_id: z.string().trim().min(1).max(8_192).optional(),
}

export const chatGptImageInputSchema = z
  .object(CHATGPT_IMAGE_INPUT_SHAPE)
  .strict()
  .superRefine((input, context) => {
    if (input.model === "pippit/seedream-5.0" && input.resolution !== undefined) {
      context.addIssue({
        code: "custom",
        message: "resolution must be omitted for pippit/seedream-5.0.",
        path: ["resolution"],
      })
    }
    if ((input.images?.length ?? 0) + (input.image_urls?.length ?? 0) > 9) {
      context.addIssue({ code: "custom", message: "At most 9 reference images are supported.", path: ["images"] })
    }
  })

export type ChatGptImageInput = z.infer<typeof chatGptImageInputSchema>

const editRegionSchema = z
  .object({
    height: z.number().positive().max(1),
    width: z.number().positive().max(1),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((region, context) => {
    if (region.x + region.width > 1) {
      context.addIssue({ code: "custom", message: "x + width must not exceed 1.", path: ["width"] })
    }
    if (region.y + region.height > 1) {
      context.addIssue({ code: "custom", message: "y + height must not exceed 1.", path: ["height"] })
    }
  })

const editAnnotationSchema = z
  .object({
    at_ms: z.number().int().nonnegative(),
    instruction: z.string().trim().min(1).max(2_000),
    region: editRegionSchema,
  })
  .strict()

const editSegmentSchema = z
  .object({
    end_ms: z.number().int().positive(),
    start_ms: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((segment, context) => {
    if (segment.end_ms <= segment.start_ms) {
      context.addIssue({ code: "custom", message: "end_ms must be greater than start_ms.", path: ["end_ms"] })
    } else if (segment.end_ms - segment.start_ms > 30_000) {
      context.addIssue({ code: "custom", message: "The selected segment must be at most 30 seconds.", path: ["end_ms"] })
    }
  })

export const CHATGPT_EDIT_INPUT_SHAPE = {
  annotations: z.array(editAnnotationSchema).max(20),
  byok_id: z.string().trim().min(1).max(256).optional(),
  idempotency_key: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(256),
  prompt: z.string().trim().min(1).max(20_000).optional(),
  resolution: z.string().trim().min(1).max(64).optional(),
  seed: z.number().int().min(-1).max(4_294_967_295).optional(),
  segment: editSegmentSchema,
  source_index: z.number().int().min(0).max(1_000).default(0),
  source_job_id: z.string().trim().min(1).max(8_192),
  thread_id: z.string().trim().min(1).max(8_192).optional(),
}

export const chatGptEditInputSchema = z
  .object(CHATGPT_EDIT_INPUT_SHAPE)
  .strict()
  .superRefine((input, context) => {
    if (input.prompt === undefined && input.annotations.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Provide an overall prompt or at least one region annotation.",
        path: ["prompt"],
      })
    }
    for (const [index, annotation] of input.annotations.entries()) {
      if (annotation.at_ms < input.segment.start_ms || annotation.at_ms > input.segment.end_ms) {
        context.addIssue({
          code: "custom",
          message: "Annotation time must fall inside the selected segment.",
          path: ["annotations", index, "at_ms"],
        })
      }
    }
  })

export type ChatGptEditInput = z.infer<typeof chatGptEditInputSchema>

const videoModelOutputSchema = z
  .object({
    allowed_passthrough_parameters: z.array(z.string()),
    canonical_slug: z.string(),
    created: z.number(),
    description: z.string(),
    generate_audio: z.boolean().nullable(),
    id: z.string(),
    name: z.string(),
    pricing_skus: z.null(),
    seed: z.boolean().nullable(),
    supported_aspect_ratios: z.array(z.string()).nullable(),
    supported_durations: z.array(z.number()).nullable(),
    supported_frame_images: z.array(z.enum(["first_frame", "last_frame"])).nullable(),
    supported_resolutions: z.array(z.string()).nullable(),
    supported_sizes: z.array(z.string()).nullable(),
  })
  .strict()

export const PIPPIT_MODEL_LIST_OUTPUT_SHAPE = {
  data: z.array(videoModelOutputSchema),
}

export const PIPPIT_IMAGE_MODEL_LIST_OUTPUT_SHAPE = {
  data: z.array(z.object({
    architecture: z.object({
      input_modalities: z.array(z.string()),
      output_modalities: z.array(z.string()),
    }).strict(),
    canonical_slug: z.string(),
    created: z.number(),
    description: z.string(),
    endpoints: z.string(),
    id: z.string(),
    name: z.string(),
    supported_parameters: z.record(z.string(), z.record(z.string(), z.unknown())),
    supports_streaming: z.boolean(),
  }).strict()),
}

export const PIPPIT_VIDEO_JOB_OUTPUT_SHAPE = {
  error: z.string().optional(),
  generation_id: z.string().nullable().optional(),
  id: z.string(),
  model: z.string().nullable().optional(),
  polling_url: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled", "expired"]),
  usage: z
    .object({
      cost: z.number().nullable().optional(),
      is_byok: z.boolean().optional(),
    })
    .strict()
    .optional(),
}

export const PIPPIT_IMAGE_OUTPUT_SHAPE = {
  created: z.number().int().nonnegative(),
  images: z.array(z.object({
    bytes: z.number().int().nonnegative().optional(),
    filename: z.string().optional(),
    media_type: z.string(),
    resource_uri: z.string().startsWith("pippit-image://artifact/").optional(),
  }).strict()).min(1),
  model: z.string(),
  usage: z.object({ cost: z.number().nullable(), is_byok: z.boolean() }).strict(),
}
