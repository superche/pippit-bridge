import type { z } from "zod"
import {
  audioUrlReferenceSchema,
  frameImageSchema,
  imageGenerationReferenceSchema,
  imageGenerationRequestSchema,
  imageUrlReferenceSchema,
  inputReferenceSchema,
  videoEditRequestSchema,
  videoGenerationRequestSchema,
  videoUrlReferenceSchema,
} from "@pippit-bridge/contracts"

export {
  audioUrlReferenceSchema,
  frameImageSchema,
  imageGenerationReferenceSchema,
  imageGenerationRequestSchema,
  imageUrlReferenceSchema,
  inputReferenceSchema,
  videoEditRequestSchema,
  videoGenerationRequestSchema,
  videoUrlReferenceSchema,
}

export type AudioUrlReference = z.infer<typeof audioUrlReferenceSchema>
export type FrameImage = z.infer<typeof frameImageSchema>
export type ImageUrlReference = z.infer<typeof imageUrlReferenceSchema>
export type ImageGenerationReference = z.infer<typeof imageGenerationReferenceSchema>
export type ImageGenerationRequest = z.infer<typeof imageGenerationRequestSchema>
export type InputReference = z.infer<typeof inputReferenceSchema>
export type VideoEditRequest = z.infer<typeof videoEditRequestSchema>
export type VideoGenerationRequest = z.infer<typeof videoGenerationRequestSchema>
export type VideoUrlReference = z.infer<typeof videoUrlReferenceSchema>

export interface ImageGenerationData {
  readonly b64_json: string
  readonly media_type?: string
}

export interface ImageGenerationResponse {
  readonly created: number
  readonly data: readonly ImageGenerationData[]
  readonly model: string
  readonly usage: {
    readonly cost: number | null
    readonly is_byok: true
  }
}

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
