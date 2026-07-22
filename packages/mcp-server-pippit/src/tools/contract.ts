import type { IdempotencyStore } from "@pippit-bridge/core"
import type {
  PippitAccessKeyCredential,
  PippitAccessKeyList,
  PippitAccessKeySelection,
  PippitImageGenerateRequest,
  PippitImageGenerationResponse,
  PippitImageModelList,
  PippitVideoDownloadOptions,
  PippitVideoEditRequest,
  PippitVideoGenerateRequest,
  PippitVideoGenerationJob,
  PippitVideoModelList,
} from "../contracts.ts"
import type { PippitAccessKeyEnrollmentBackend } from "../enrollment.ts"

export const PIPPIT_RUNTIME_TOOL_NAMES = [
  "pippit_list_image_models",
  "pippit_generate_image",
  "pippit_list_video_models",
  "pippit_generate_video",
  "pippit_get_video",
  "pippit_download_video",
  "pippit_edit_video_segment",
] as const

export const PIPPIT_MANAGEMENT_TOOL_NAMES = [
  "pippit_list_access_keys",
  "pippit_add_access_key",
  "pippit_switch_access_key",
  "pippit_delete_access_key",
] as const

export const PIPPIT_TOOL_NAMES = [
  ...PIPPIT_RUNTIME_TOOL_NAMES,
  ...PIPPIT_MANAGEMENT_TOOL_NAMES,
] as const

export type PippitToolName = (typeof PIPPIT_TOOL_NAMES)[number]

export interface PippitToolAnnotations {
  readonly destructiveHint: boolean
  readonly idempotentHint: boolean
  readonly openWorldHint: boolean
  readonly readOnlyHint: boolean
  readonly title: string
}

export interface PippitToolDefinition {
  readonly _meta?: Readonly<Record<string, unknown>>
  readonly annotations: PippitToolAnnotations
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly name: PippitToolName
  readonly outputSchema: Readonly<Record<string, unknown>>
  readonly title: string
}

export interface PippitMcpCallToolResult {
  readonly _meta?: Readonly<Record<string, unknown>>
  readonly content: readonly (
    | { readonly data: string; readonly mimeType: string; readonly type: "image" }
    | { readonly text: string; readonly type: "text" }
  )[]
  readonly isError?: boolean
  readonly structuredContent?: Readonly<Record<string, unknown>>
}

export interface PippitFacadeBackend {
  generateImage(input: PippitImageGenerateRequest, signal?: AbortSignal): Promise<PippitImageGenerationResponse>
  listImageModels(signal?: AbortSignal): Promise<PippitImageModelList>
  downloadVideo(jobId: string, options?: PippitVideoDownloadOptions): Promise<Response>
  editVideo(input: PippitVideoEditRequest, signal?: AbortSignal): Promise<PippitVideoGenerationJob>
  generateVideo(input: PippitVideoGenerateRequest, signal?: AbortSignal): Promise<PippitVideoGenerationJob>
  getVideo(jobId: string, signal?: AbortSignal): Promise<PippitVideoGenerationJob>
  listVideoModels(signal?: AbortSignal): Promise<PippitVideoModelList>
}

export interface PippitFacadeManagementBackend {
  addAccessKey(
    input: { readonly accessKey: string; readonly accountName: string },
    signal?: AbortSignal,
  ): Promise<PippitAccessKeyCredential>
  deleteAccessKey(
    credentialId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly credential_id: string; readonly deleted: true }>
  listAccessKeys(signal?: AbortSignal): Promise<PippitAccessKeyList>
  switchAccessKey(credentialId: string, signal?: AbortSignal): Promise<PippitAccessKeySelection>
}

export interface PippitToolRuntimeOptions {
  readonly client: PippitFacadeBackend
  readonly dedupeLimit?: number
  readonly enrollmentPort?: number
  readonly enrollmentServer?: PippitAccessKeyEnrollmentBackend
  readonly enrollmentTtlMs?: number
  readonly idempotencyScope?: string
  readonly idempotencyStore?: IdempotencyStore
  readonly managementClient?: PippitFacadeManagementBackend
  readonly maxDownloadBytes?: number
  readonly outputRoot?: string
}

export interface PippitToolRuntime {
  callTool(name: string, argumentsValue: unknown): Promise<PippitMcpCallToolResult>
  close?(): Promise<void>
  listTools(): readonly PippitToolDefinition[]
}
