export const PIPPIT_VIDEO_GENERATION_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const

export type PippitVideoGenerationStatus = (typeof PIPPIT_VIDEO_GENERATION_STATUSES)[number]

export interface PippitUrlValue {
  readonly url: string
}

export interface PippitImageUrlReference {
  readonly image_url: PippitUrlValue
  readonly type: "image_url"
}

export interface PippitAudioUrlReference {
  readonly audio_url: PippitUrlValue
  readonly type: "audio_url"
}

export interface PippitVideoUrlReference {
  readonly type: "video_url"
  readonly video_url: PippitUrlValue
}

export type PippitInputReference =
  | PippitImageUrlReference
  | PippitAudioUrlReference
  | PippitVideoUrlReference

export interface PippitFrameImage extends PippitImageUrlReference {
  readonly frame_type: "first_frame" | "last_frame"
}

export interface PippitProviderOptions {
  readonly byok_id?: string
  readonly thread_id?: string
}

export interface PippitImageGenerateRequest {
  readonly input_references?: readonly PippitImageUrlReference[]
  readonly model: string
  readonly n?: number
  readonly prompt: string
  readonly provider?: {
    readonly options?: {
      readonly pippit?: PippitProviderOptions
    }
  }
  readonly resolution?: "1K" | "2K" | "4K"
}

export interface PippitImageGenerationData {
  readonly b64_json: string
  readonly media_type?: string
}

export interface PippitImageGenerationResponse {
  readonly created: number
  readonly data: readonly PippitImageGenerationData[]
  readonly model: string
  readonly usage: {
    readonly cost: number | null
    readonly is_byok: boolean
  }
}

export interface PippitImageModel {
  readonly architecture: {
    readonly input_modalities: readonly string[]
    readonly output_modalities: readonly string[]
  }
  readonly canonical_slug: string
  readonly created: number
  readonly description: string
  readonly endpoints: string
  readonly id: string
  readonly name: string
  readonly supported_parameters: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly supports_streaming: boolean
}

export interface PippitImageModelList {
  readonly data: readonly PippitImageModel[]
}

export interface PippitVideoGenerateRequest {
  readonly aspect_ratio?: string
  readonly duration?: number
  readonly frame_images?: readonly PippitFrameImage[]
  readonly input_references?: readonly PippitInputReference[]
  readonly model: string
  readonly prompt: string
  readonly provider?: {
    readonly options?: {
      readonly pippit?: PippitProviderOptions
    }
  }
  readonly resolution?: string
  readonly seed?: number
  readonly size?: string
}

export interface PippitVideoEditSegment {
  readonly end_ms: number
  readonly start_ms: number
}

export interface PippitVideoEditRegion {
  readonly height: number
  readonly width: number
  readonly x: number
  readonly y: number
}

export interface PippitVideoEditAnnotation {
  readonly at_ms: number
  readonly instruction: string
  readonly region: PippitVideoEditRegion
}

export interface PippitVideoEditRequest {
  readonly annotations: readonly PippitVideoEditAnnotation[]
  readonly model: string
  readonly prompt?: string
  readonly provider?: {
    readonly options?: {
      readonly pippit?: PippitProviderOptions
    }
  }
  readonly resolution?: string
  readonly seed?: number
  readonly segment: PippitVideoEditSegment
  readonly source_index: number
  readonly source_job_id: string
}

export interface PippitVideoModel {
  readonly allowed_passthrough_parameters: readonly string[]
  readonly canonical_slug: string
  readonly created: number
  readonly description: string
  readonly generate_audio: boolean | null
  readonly id: string
  readonly name: string
  readonly pricing_skus: null
  readonly seed: boolean | null
  readonly supported_aspect_ratios: readonly string[] | null
  readonly supported_durations: readonly number[] | null
  readonly supported_frame_images: readonly ("first_frame" | "last_frame")[] | null
  readonly supported_resolutions: readonly string[] | null
  readonly supported_sizes: readonly string[] | null
}

export interface PippitVideoModelList {
  readonly data: readonly PippitVideoModel[]
}

export interface PippitVideoGenerationJob {
  readonly error?: string
  readonly generation_id?: string | null
  readonly id: string
  readonly model?: string | null
  readonly polling_url: string
  readonly status: PippitVideoGenerationStatus
  readonly unsigned_urls?: readonly string[]
  readonly usage?: {
    readonly cost?: number | null
    readonly is_byok?: boolean
  }
}

export type PippitFacadeFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface PippitFacadeClientOptions {
  readonly apiKey: string
  readonly baseUrl: string
  readonly fetchImpl?: PippitFacadeFetch
  readonly timeoutMs?: number
}

export interface PippitFacadeManagementClientOptions {
  readonly baseUrl: string
  readonly facadeApiKeyHash: string
  readonly fetchImpl?: PippitFacadeFetch
  readonly managementApiKey: string
  readonly timeoutMs?: number
}

export interface PippitAccessKeyCredential {
  readonly account_name: string | null
  readonly active: boolean
  readonly credential_id: string
  readonly disabled: boolean
  readonly label: string
}

export interface PippitAccessKeyList {
  readonly data: readonly PippitAccessKeyCredential[]
  readonly total_count: number
}

export interface PippitAccessKeySelection {
  readonly active: true
  readonly credential_id: string
  readonly updated_at: string
}

export interface PippitAccessKeyEnrollment {
  readonly account_name: string
  readonly enrollment_url: string
  readonly expires_at: string
}

export interface PippitVideoDownloadOptions {
  readonly index?: number
  readonly range?: string
  readonly signal?: AbortSignal
}

export type PippitFacadeOperation =
  | "list_image_models"
  | "generate_image"
  | "list_video_models"
  | "generate_video"
  | "edit_video_segment"
  | "get_video"
  | "download_video"
  | "list_access_keys"
  | "add_access_key"
  | "switch_access_key"
  | "delete_access_key"

export type PippitFacadeErrorCode =
  | "ABORTED"
  | "HTTP_ERROR"
  | "INVALID_CONFIGURATION"
  | "INVALID_INPUT"
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR"
  | "TIMEOUT"

export interface PippitGenerateVideoToolInput {
  readonly aspect_ratio?: string
  readonly byok_id?: string
  readonly duration?: number
  readonly frame_images?: readonly PippitFrameImage[]
  readonly idempotency_key?: string
  readonly input_references?: readonly PippitInputReference[]
  readonly model: string
  readonly prompt: string
  readonly resolution?: string
  readonly seed?: number
  readonly thread_id?: string
}

export interface PippitGenerateImageToolInput {
  readonly byok_id?: string
  readonly images?: readonly PippitImageUrlReference[]
  readonly model: string
  readonly n?: number
  readonly prompt: string
  readonly resolution?: "1K" | "2K" | "4K"
  readonly thread_id?: string
}

export interface PippitGetVideoToolInput {
  readonly job_id: string
}

export interface PippitEditVideoSegmentToolInput {
  readonly annotations: readonly PippitVideoEditAnnotation[]
  readonly byok_id?: string
  readonly idempotency_key?: string
  readonly model: string
  readonly prompt?: string
  readonly resolution?: string
  readonly seed?: number
  readonly segment: PippitVideoEditSegment
  readonly source_index: number
  readonly source_job_id: string
  readonly thread_id?: string
}

export interface PippitAddAccessKeyToolInput {
  readonly account_name: string
}

export interface PippitSwitchAccessKeyToolInput {
  readonly credential_id: string
}

export interface PippitDeleteAccessKeyToolInput {
  readonly confirm: true
  readonly credential_id: string
}

export interface PippitDownloadVideoToolInput {
  readonly index?: number
  readonly job_id: string
  readonly output_path: string
}

export interface PippitDownloadedVideo {
  readonly bytes: number
  readonly index: number
  readonly job_id: string
  readonly media_type: string
  readonly path: string
}
