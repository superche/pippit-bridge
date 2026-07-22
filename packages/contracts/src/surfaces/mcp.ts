import { z } from "zod"
import { runtimeContract } from "../contract.js"

const printableString = (maximum: number) => z.string().trim().min(1).max(maximum).refine(
  value => [...value].every(character => {
    const code = character.codePointAt(0) ?? 0
    return code > 0x1f && code !== 0x7f
  }),
  "Must not contain ASCII control characters",
)
const safeHttpUrlSchema = z.url().transform(value => {
  const parsed = new URL(value)
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Only HTTP(S) URLs without embedded credentials are supported")
  }
  return parsed.toString()
})
const urlValueSchema = z.object({ url: safeHttpUrlSchema }).strict()
const imageUrlReferenceSchema = z.object({ image_url: urlValueSchema, type: z.literal("image_url") }).strict()
const videoUrlReferenceSchema = z.object({ type: z.literal("video_url"), video_url: urlValueSchema }).strict()
const audioUrlReferenceSchema = z.object({ audio_url: urlValueSchema, type: z.literal("audio_url") }).strict()
const inputReferenceSchema = z.discriminatedUnion("type", [
  imageUrlReferenceSchema,
  videoUrlReferenceSchema,
  audioUrlReferenceSchema,
])
const frameImageSchema = imageUrlReferenceSchema.extend({ frame_type: z.enum(["first_frame", "last_frame"]) })
const idempotencyKeySchema = printableString(200)
const byokIdSchema = printableString(256)
const threadIdSchema = printableString(8_192)

export const emptyToolInputSchema = z.object({}).strict()
export const generateVideoToolInputSchema = z.object({
  aspect_ratio: printableString(64).optional(),
  byok_id: byokIdSchema.optional(),
  duration: z.number().int().min(1).max(3_600).optional(),
  frame_images: z.array(frameImageSchema).max(2).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
  input_references: z.array(inputReferenceSchema).max(15).optional(),
  model: z.enum([
    "pippit/seedance-2.0-mini",
    "pippit/seedance-2.0",
    "pippit/seedance-2.0-mini-lite",
    "pippit/seedance-2.0-vision",
  ]).default("pippit/seedance-2.0-mini"),
  prompt: printableString(20_000),
  resolution: printableString(64).optional(),
  seed: z.number().int().min(-1).max(4_294_967_295).optional(),
  thread_id: threadIdSchema.optional(),
}).strict().superRefine((input, context) => {
  const frameTypes = input.frame_images?.map(frame => frame.frame_type) ?? []
  if (new Set(frameTypes).size !== frameTypes.length) {
    context.addIssue({ code: "custom", message: "frame_images contains a duplicate frame type", path: ["frame_images"] })
  }
  if ((input.frame_images?.length ?? 0) > 0 && (input.input_references?.length ?? 0) > 0) {
    context.addIssue({ code: "custom", message: "frame_images cannot be combined with input_references", path: ["frame_images"] })
  }
  const references = input.input_references ?? []
  const videoCount = references.filter(item => item.type === "video_url").length
  const audioCount = references.filter(item => item.type === "audio_url").length
  if (references.length - audioCount > 9) {
    context.addIssue({ code: "custom", message: "At most 9 visual references are supported", path: ["input_references"] })
  }
  if (videoCount > 3) context.addIssue({ code: "custom", message: "At most 3 video references are supported", path: ["input_references"] })
  if (audioCount > 3) context.addIssue({ code: "custom", message: "At most 3 audio references are supported", path: ["input_references"] })
})

export const generateImageToolInputSchema = z.object({
  byok_id: byokIdSchema.optional(),
  images: z.array(imageUrlReferenceSchema).max(9).optional(),
  model: z.enum(["pippit/seedream-5.0", "pippit/seedream-5.0-pro"]).default("pippit/seedream-5.0"),
  n: z.number().int().min(1).max(10).default(1),
  prompt: printableString(20_000),
  resolution: z.enum(["1K", "2K", "4K"]).optional(),
  thread_id: threadIdSchema.optional(),
}).strict().superRefine((input, context) => {
  if (input.model === "pippit/seedream-5.0" && input.resolution !== undefined) {
    context.addIssue({ code: "custom", message: "resolution must be omitted for pippit/seedream-5.0", path: ["resolution"] })
  }
})

const normalizedRegionSchema = z.object({
  height: z.number().positive().max(1),
  width: z.number().positive().max(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
}).strict().superRefine((region, context) => {
  if (region.x + region.width > 1 || region.y + region.height > 1) {
    context.addIssue({ code: "custom", message: "Region must stay within the normalized frame" })
  }
})
const editSegmentSchema = z.object({
  end_ms: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  start_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict().superRefine((segment, context) => {
  if (segment.end_ms <= segment.start_ms || segment.end_ms - segment.start_ms > 30_000) {
    context.addIssue({ code: "custom", message: "Segment must be positive and at most 30000 milliseconds" })
  }
})
export const editVideoToolInputSchema = z.object({
  annotations: z.array(z.object({
    at_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    instruction: printableString(2_000),
    region: normalizedRegionSchema,
  }).strict()).max(20),
  byok_id: byokIdSchema.optional(),
  idempotency_key: idempotencyKeySchema.optional(),
  model: z.enum([
    "pippit/seedance-2.0-mini",
    "pippit/seedance-2.0",
    "pippit/seedance-2.0-mini-lite",
    "pippit/seedance-2.0-vision",
  ]).default("pippit/seedance-2.0-mini"),
  prompt: printableString(20_000).optional(),
  resolution: printableString(64).optional(),
  seed: z.number().int().min(-1).max(4_294_967_295).optional(),
  segment: editSegmentSchema,
  source_index: z.number().int().min(0).max(1_000).default(0),
  source_job_id: printableString(8_192),
  thread_id: threadIdSchema.optional(),
}).strict().superRefine((input, context) => {
  if (input.prompt === undefined && input.annotations.length === 0) {
    context.addIssue({ code: "custom", message: "Provide prompt or at least one annotation", path: ["annotations"] })
  }
  for (const [index, annotation] of input.annotations.entries()) {
    if (annotation.at_ms < input.segment.start_ms || annotation.at_ms > input.segment.end_ms) {
      context.addIssue({ code: "custom", message: "Annotation must fall within segment", path: ["annotations", index, "at_ms"] })
    }
  }
})

const safeRelativePathSchema = z.string().min(1).max(4_096).refine(value => {
  if (value.includes("\0") || /^(?:[A-Za-z]:[\\/]|[\\/])/u.test(value)) return false
  return !value.split(/[\\/]+/u).some(segment => segment === "" || segment === "." || segment === "..")
}, "output_path must be a safe relative path").transform(value => value.split(/[\\/]+/u).join("/"))

export const getVideoToolInputSchema = z.object({ job_id: printableString(8_192) }).strict()
export const downloadVideoToolInputSchema = z.object({
  index: z.number().int().min(0).max(1_000).default(0),
  job_id: printableString(8_192),
  output_path: safeRelativePathSchema,
}).strict()
export const addAccessKeyToolInputSchema = z.object({ account_name: printableString(128) }).strict()
export const switchAccessKeyToolInputSchema = z.object({ credential_id: printableString(8_192) }).strict()
export const deleteAccessKeyToolInputSchema = z.object({
  confirm: z.literal(true),
  credential_id: printableString(8_192),
}).strict()

export const emptyToolInputContract = runtimeContract(emptyToolInputSchema)
export const generateVideoToolInputContract = runtimeContract(generateVideoToolInputSchema)
export const generateImageToolInputContract = runtimeContract(generateImageToolInputSchema)
export const editVideoToolInputContract = runtimeContract(editVideoToolInputSchema)
export const getVideoToolInputContract = runtimeContract(getVideoToolInputSchema)
export const downloadVideoToolInputContract = runtimeContract(downloadVideoToolInputSchema)
export const addAccessKeyToolInputContract = runtimeContract(addAccessKeyToolInputSchema)
export const switchAccessKeyToolInputContract = runtimeContract(switchAccessKeyToolInputSchema)
export const deleteAccessKeyToolInputContract = runtimeContract(deleteAccessKeyToolInputSchema)

export type GenerateVideoToolInput = z.infer<typeof generateVideoToolInputSchema>
export type GenerateImageToolInput = z.infer<typeof generateImageToolInputSchema>
export type EditVideoToolInput = z.infer<typeof editVideoToolInputSchema>
