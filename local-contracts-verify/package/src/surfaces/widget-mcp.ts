import { z } from "zod"
import { runtimeContract } from "../contract.js"

export const PIPPIT_WIDGET_IMAGE_JOB_ID_PATTERN = /^pimg_[a-f0-9]{32}$/u
export const PIPPIT_WIDGET_IMAGE_RESOURCE_URI_PATTERN = /^pippit-image:\/\/artifact\/[a-f0-9]{64}\.(?:jpg|png|webp)$/u
export const PIPPIT_WIDGET_VIDEO_RESOURCE_URI_PATTERN = /^pippit-video:\/\/artifact\/[a-f0-9]{64}$/u
export const PIPPIT_WIDGET_MAX_VIDEO_CHUNK_BYTES = 1024 * 1024
const utf8 = new TextEncoder()

export const widgetGetImageInputSchema = z.object({
  image_job_id: z.string().regex(PIPPIT_WIDGET_IMAGE_JOB_ID_PATTERN),
}).strict()

export const widgetImageResourceInputSchema = z.object({
  resource_uri: z.string().regex(PIPPIT_WIDGET_IMAGE_RESOURCE_URI_PATTERN),
}).strict()

export const widgetReadVideoChunkInputSchema = z.object({
  length: z.number().int().min(1).max(PIPPIT_WIDGET_MAX_VIDEO_CHUNK_BYTES),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  resource_uri: z.string().regex(PIPPIT_WIDGET_VIDEO_RESOURCE_URI_PATTERN),
}).strict()

export const widgetResolveLatestVideoInputSchema = z.object({
  anchor_job_id: z.string().min(1).max(16_384).refine(
    value => value.trim() !== "" && utf8.encode(value).byteLength <= 16_384,
    "anchor_job_id must contain a bounded non-blank job id",
  ),
}).strict()

export const widgetGetImageInputContract = runtimeContract(widgetGetImageInputSchema)
export const widgetReadImageInputContract = runtimeContract(widgetImageResourceInputSchema)
export const widgetRevealImageInputContract = runtimeContract(widgetImageResourceInputSchema)
export const widgetReadVideoChunkInputContract = runtimeContract(widgetReadVideoChunkInputSchema)
export const widgetResolveLatestVideoInputContract = runtimeContract(widgetResolveLatestVideoInputSchema)

export const WIDGET_MCP_INPUT_CONTRACTS = {
  pippit_get_image: widgetGetImageInputContract,
  pippit_read_image: widgetReadImageInputContract,
  pippit_read_video_chunk: widgetReadVideoChunkInputContract,
  pippit_resolve_latest_video: widgetResolveLatestVideoInputContract,
  pippit_reveal_image: widgetRevealImageInputContract,
} as const

export type WidgetGetImageInput = z.infer<typeof widgetGetImageInputSchema>
export type WidgetImageResourceInput = z.infer<typeof widgetImageResourceInputSchema>
export type WidgetReadVideoChunkInput = z.infer<typeof widgetReadVideoChunkInputSchema>
export type WidgetResolveLatestVideoInput = z.infer<typeof widgetResolveLatestVideoInputSchema>
