import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep, win32 } from "node:path"
import type {
  PippitAccessKeyCredential,
  PippitAccessKeyList,
  PippitAccessKeySelection,
  PippitAddAccessKeyToolInput,
  PippitDeleteAccessKeyToolInput,
  PippitDownloadVideoToolInput,
  PippitDownloadedVideo,
  PippitEditVideoSegmentToolInput,
  PippitGenerateImageToolInput,
  PippitGenerateVideoToolInput,
  PippitGetVideoToolInput,
  PippitImageGenerateRequest,
  PippitImageGenerationResponse,
  PippitImageModelList,
  PippitSwitchAccessKeyToolInput,
  PippitVideoDownloadOptions,
  PippitVideoEditRequest,
  PippitVideoGenerateRequest,
  PippitVideoGenerationJob,
  PippitVideoModelList,
} from "./contracts.ts"
import { PippitFacadeError } from "./client.ts"
import type { IdempotencyStore } from "@pippit-bridge/core"
import {
  createPippitAccessKeyEnrollmentServer,
  type PippitAccessKeyEnrollmentBackend,
} from "./enrollment.ts"
import { PIPPIT_DEFAULT_OUTPUT_DIRECTORY } from "./options.ts"

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

const urlValueSchema = {
  additionalProperties: false,
  properties: { url: { description: "HTTP(S) URL resolved by the facade.", format: "uri", type: "string" } },
  required: ["url"],
  type: "object",
} as const

const inputReferenceSchemas = [
  {
    additionalProperties: false,
    properties: { image_url: urlValueSchema, type: { const: "image_url", type: "string" } },
    required: ["type", "image_url"],
    type: "object",
  },
  {
    additionalProperties: false,
    properties: { video_url: urlValueSchema, type: { const: "video_url", type: "string" } },
    required: ["type", "video_url"],
    type: "object",
  },
  {
    additionalProperties: false,
    properties: { audio_url: urlValueSchema, type: { const: "audio_url", type: "string" } },
    required: ["type", "audio_url"],
    type: "object",
  },
] as const

const jobOutputSchema = {
  additionalProperties: false,
  properties: {
    error: { type: "string" },
    generation_id: { type: ["string", "null"] },
    id: { type: "string" },
    model: { type: ["string", "null"] },
    polling_url: { type: "string" },
    status: { enum: ["pending", "in_progress", "completed", "failed", "cancelled", "expired"], type: "string" },
    unsigned_urls: { items: { type: "string" }, type: "array" },
    usage: {
      additionalProperties: false,
      properties: { cost: { type: ["number", "null"] }, is_byok: { type: "boolean" } },
      type: "object",
    },
  },
  required: ["id", "polling_url", "status"],
  type: "object",
} as const

const accessKeyCredentialOutputSchema = {
  additionalProperties: false,
  properties: {
    account_name: { type: ["string", "null"] },
    active: { type: "boolean" },
    credential_id: { type: "string" },
    disabled: { type: "boolean" },
    label: { description: "Masked display label. Never a raw key or fingerprint.", type: "string" },
  },
  required: ["account_name", "active", "credential_id", "disabled", "label"],
  type: "object",
} as const

const accessKeySelectionOutputSchema = {
  additionalProperties: false,
  properties: {
    active: { const: true, type: "boolean" },
    credential_id: { type: "string" },
    updated_at: { type: "string" },
  },
  required: ["active", "credential_id", "updated_at"],
  type: "object",
} as const

export const PIPPIT_TOOL_DEFINITIONS: readonly PippitToolDefinition[] = [
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
      title: "List Pippit image models",
    },
    description: "List Seedream image generation models and their model-specific settings.",
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
    name: "pippit_list_image_models",
    outputSchema: {
      additionalProperties: false,
      properties: { data: { items: { type: "object" }, type: "array" } },
      required: ["data"],
      type: "object",
    },
    title: "List Pippit image models",
  },
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
      title: "Generate Pippit images",
    },
    description: "Generate images with Seedream 5.0 or Seedream 5.0 Pro. This may incur Pippit charges. Optional reference images are fetched and uploaded by the facade; the completed images are returned directly to the host.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        byok_id: { description: "Optional facade-managed BYOK credential identifier. Never pass a raw access key.", type: "string" },
        images: {
          description: "Optional reference images, up to 9.",
          items: {
            additionalProperties: false,
            properties: {
              image_url: urlValueSchema,
              type: { const: "image_url", type: "string" },
            },
            required: ["type", "image_url"],
            type: "object",
          },
          maxItems: 9,
          type: "array",
        },
        model: { enum: ["pippit/seedream-5.0", "pippit/seedream-5.0-pro"], type: "string" },
        n: { default: 1, maximum: 10, minimum: 1, type: "integer" },
        prompt: { maxLength: 20000, minLength: 1, type: "string" },
        resolution: { description: "Seedream 5.0 Pro only.", enum: ["1K", "2K", "4K"], type: "string" },
        thread_id: { description: "Optional Pippit thread to continue through the facade.", type: "string" },
      },
      required: ["model", "prompt"],
      type: "object",
    },
    name: "pippit_generate_image",
    outputSchema: {
      additionalProperties: false,
      properties: {
        created: { minimum: 0, type: "integer" },
        images: {
          items: {
            additionalProperties: false,
            properties: { media_type: { type: "string" } },
            required: ["media_type"],
            type: "object",
          },
          minItems: 1,
          type: "array",
        },
        model: { type: "string" },
        usage: { type: "object" },
      },
      required: ["created", "images", "model", "usage"],
      type: "object",
    },
    title: "Generate Pippit images",
  },
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
      title: "List Pippit video models",
    },
    description: "List video generation models and supported settings exposed by the configured Pippit facade.",
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
    name: "pippit_list_video_models",
    outputSchema: {
      additionalProperties: false,
      properties: { data: { items: { type: "object" }, type: "array" } },
      required: ["data"],
      type: "object",
    },
    title: "List Pippit video models",
  },
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
      title: "Generate a Pippit video",
    },
    description: "Submit one asynchronous Pippit video generation job. This may incur Pippit charges, and supplied reference URLs are fetched, uploaded, and processed by the facade/Pippit. Returns immediately; use pippit_get_video to poll it.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        aspect_ratio: { description: "Requested aspect ratio, for example 16:9.", type: "string" },
        byok_id: { description: "Optional facade-managed BYOK credential identifier. Never pass a raw access key.", type: "string" },
        duration: { maximum: 3600, minimum: 1, type: "integer" },
        frame_images: {
          description: "First/last frame URLs. Cannot be combined with input_references.",
          items: {
            additionalProperties: false,
            properties: {
              frame_type: { enum: ["first_frame", "last_frame"], type: "string" },
              image_url: urlValueSchema,
              type: { const: "image_url", type: "string" },
            },
            required: ["type", "image_url", "frame_type"],
            type: "object",
          },
          maxItems: 2,
          type: "array",
        },
        idempotency_key: {
          description: "Optional recovery key. Reuse it only when retrying the exact same submission after an abnormal interruption.",
          maxLength: 200,
          minLength: 1,
          type: "string",
        },
        input_references: {
          description: "Image, video, or audio input URLs. Cannot be combined with frame_images.",
          items: { oneOf: inputReferenceSchemas },
          maxItems: 15,
          type: "array",
        },
        model: { minLength: 1, type: "string" },
        prompt: { maxLength: 20000, minLength: 1, type: "string" },
        resolution: { type: "string" },
        seed: { maximum: 4294967295, minimum: -1, type: "integer" },
        thread_id: { description: "Optional Pippit thread to continue through the facade.", type: "string" },
      },
      required: ["model", "prompt"],
      type: "object",
    },
    name: "pippit_generate_video",
    outputSchema: jobOutputSchema,
    title: "Generate a Pippit video",
  },
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
      title: "Get a Pippit video job",
    },
    description: "Read the current state of one Pippit video generation job. Completed outputs are delivered to the host through a private preview widget.",
    inputSchema: {
      additionalProperties: false,
      properties: { job_id: { minLength: 1, type: "string" } },
      required: ["job_id"],
      type: "object",
    },
    name: "pippit_get_video",
    outputSchema: jobOutputSchema,
    title: "Get a Pippit video job",
  },
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
      title: "Create another local video copy",
    },
    description: "Create an additional named copy of one completed video under the configured output root. Normal completed widget results are already saved locally first. Never overwrites files.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        index: { default: 0, maximum: 1000, minimum: 0, type: "integer" },
        job_id: { minLength: 1, type: "string" },
        output_path: { description: "Relative destination beneath PIPPIT_MCP_OUTPUT_ROOT.", minLength: 1, type: "string" },
      },
      required: ["job_id", "output_path"],
      type: "object",
    },
    name: "pippit_download_video",
    outputSchema: {
      additionalProperties: false,
      properties: {
        bytes: { minimum: 0, type: "integer" },
        index: { minimum: 0, type: "integer" },
        job_id: { type: "string" },
        media_type: { type: "string" },
        path: { type: "string" },
      },
      required: ["bytes", "index", "job_id", "media_type", "path"],
      type: "object",
    },
    title: "Download a Pippit video",
  },
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
      title: "Regenerate a Pippit video from a result",
    },
    description: "Submit an asynchronous regeneration with one completed Pippit video output as the reference. The selected range, overall prompt, and normalized frame annotations become generation guidance. This may incur Pippit charges.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        annotations: {
          items: {
            additionalProperties: false,
            properties: {
              at_ms: { minimum: 0, type: "integer" },
              instruction: { maxLength: 2000, minLength: 1, type: "string" },
              region: {
                additionalProperties: false,
                properties: {
                  height: { exclusiveMinimum: 0, maximum: 1, type: "number" },
                  width: { exclusiveMinimum: 0, maximum: 1, type: "number" },
                  x: { minimum: 0, maximum: 1, type: "number" },
                  y: { minimum: 0, maximum: 1, type: "number" },
                },
                required: ["x", "y", "width", "height"],
                type: "object",
              },
            },
            required: ["at_ms", "region", "instruction"],
            type: "object",
          },
          maxItems: 20,
          type: "array",
        },
        byok_id: { description: "Optional facade-managed BYOK credential identifier.", type: "string" },
        idempotency_key: {
          description: "Optional recovery key. Reuse it only after an abnormal interruption of this exact regeneration.",
          maxLength: 200,
          minLength: 1,
          type: "string",
        },
        model: { minLength: 1, type: "string" },
        prompt: { description: "Optional overall instruction for the regenerated video.", maxLength: 20000, minLength: 1, type: "string" },
        resolution: { type: "string" },
        seed: { maximum: 4294967295, minimum: -1, type: "integer" },
        segment: {
          additionalProperties: false,
          properties: {
            end_ms: { minimum: 1, type: "integer" },
            start_ms: { minimum: 0, type: "integer" },
          },
          required: ["start_ms", "end_ms"],
          type: "object",
        },
        source_index: { default: 0, maximum: 1000, minimum: 0, type: "integer" },
        source_job_id: { minLength: 1, type: "string" },
        thread_id: { type: "string" },
      },
      required: ["annotations", "model", "segment", "source_job_id"],
      type: "object",
    },
    name: "pippit_edit_video_segment",
    outputSchema: jobOutputSchema,
    title: "Regenerate a Pippit video from a result",
  },
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
      title: "List Pippit Access Keys",
    },
    description: "List facade-managed Pippit accounts for this caller. Returns only masked metadata and the active selection, never raw keys or fingerprints.",
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
    name: "pippit_list_access_keys",
    outputSchema: {
      additionalProperties: false,
      properties: {
        data: { items: accessKeyCredentialOutputSchema, type: "array" },
        total_count: { minimum: 0, type: "integer" },
      },
      required: ["data", "total_count"],
      type: "object",
    },
    title: "List Pippit Access Keys",
  },
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
      readOnlyHint: false,
      title: "Add a Pippit Access Key",
    },
    description: "Create a five-minute, single-use loopback enrollment form for a Pippit account. The Access Key must be entered only in that password form and never in tool arguments or chat.",
    inputSchema: {
      additionalProperties: false,
      properties: { account_name: { maxLength: 128, minLength: 1, type: "string" } },
      required: ["account_name"],
      type: "object",
    },
    name: "pippit_add_access_key",
    outputSchema: {
      additionalProperties: false,
      properties: {
        account_name: { type: "string" },
        enrollment_url: { format: "uri", type: "string" },
        expires_at: { type: "string" },
      },
      required: ["account_name", "enrollment_url", "expires_at"],
      type: "object",
    },
    title: "Add a Pippit Access Key",
  },
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
      title: "Switch active Pippit Access Key",
    },
    description: "Select one facade-managed credential for new Pippit jobs from this caller.",
    inputSchema: {
      additionalProperties: false,
      properties: { credential_id: { minLength: 1, type: "string" } },
      required: ["credential_id"],
      type: "object",
    },
    name: "pippit_switch_access_key",
    outputSchema: accessKeySelectionOutputSchema,
    title: "Switch active Pippit Access Key",
  },
  {
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
      title: "Delete a Pippit Access Key",
    },
    description: "Permanently delete one facade-managed Pippit credential. This does not revoke the key at Pippit. Explicit confirmation is required.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        confirm: { const: true, type: "boolean" },
        credential_id: { minLength: 1, type: "string" },
      },
      required: ["credential_id", "confirm"],
      type: "object",
    },
    name: "pippit_delete_access_key",
    outputSchema: {
      additionalProperties: false,
      properties: {
        credential_id: { type: "string" },
        deleted: { const: true, type: "boolean" },
      },
      required: ["credential_id", "deleted"],
      type: "object",
    },
    title: "Delete a Pippit Access Key",
  },
]

export const PIPPIT_TOOL_DEFINITIONS_BY_NAME = Object.freeze(
  Object.fromEntries(PIPPIT_TOOL_DEFINITIONS.map((definition) => [definition.name, definition])),
) as Readonly<Record<PippitToolName, PippitToolDefinition>>

export function getPippitToolDefinition(name: PippitToolName): PippitToolDefinition {
  return PIPPIT_TOOL_DEFINITIONS_BY_NAME[name]
}

export function selectPippitToolDefinitions(
  names: readonly PippitToolName[],
): readonly PippitToolDefinition[] {
  return names.map((name) => getPippitToolDefinition(name))
}

export const PIPPIT_RUNTIME_TOOL_DEFINITIONS = selectPippitToolDefinitions(PIPPIT_RUNTIME_TOOL_NAMES)
export const PIPPIT_MANAGEMENT_TOOL_DEFINITIONS = selectPippitToolDefinitions(PIPPIT_MANAGEMENT_TOOL_NAMES)

class ToolInputError extends Error {}

interface DedupeEntry {
  readonly fingerprint: string
  readonly promise: Promise<object>
  settled: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key))
  if (unknown !== undefined) throw new ToolInputError(`${name} contains unsupported field ${unknown}.`)
}

function hasAsciiControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function nonEmptyString(value: unknown, name: string, maximum = 8_192): string {
  if (typeof value !== "string") throw new ToolInputError(`${name} must be a string.`)
  const normalized = value.trim()
  if (normalized === "" || normalized.length > maximum || hasAsciiControlCharacters(normalized)) {
    throw new ToolInputError(`${name} must be a non-empty printable string of at most ${maximum} characters.`)
  }
  return normalized
}

function idempotencyKey(value: unknown): string {
  return nonEmptyString(value, "idempotency_key", 200)
}

function optionalInteger(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ToolInputError(`${name} must be an integer from ${minimum} to ${maximum}.`)
  }
  return Number(value)
}

function httpUrl(value: unknown, name: string): string {
  if (typeof value !== "string") throw new ToolInputError(`${name} must be an HTTP(S) URL.`)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ToolInputError(`${name} must be an HTTP(S) URL.`)
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new ToolInputError(`${name} must be an HTTP(S) URL without embedded credentials.`)
  }
  return parsed.toString()
}

function urlValue(value: unknown, name: string): { readonly url: string } {
  if (!isRecord(value)) throw new ToolInputError(`${name} must be an object.`)
  assertExactKeys(value, ["url"], name)
  return { url: httpUrl(value.url, `${name}.url`) }
}

function parseInputReferences(value: unknown): PippitGenerateVideoToolInput["input_references"] {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 15) {
    throw new ToolInputError("input_references must contain at most 15 entries.")
  }
  const parsed: NonNullable<PippitGenerateVideoToolInput["input_references"]>[number][] = []
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) throw new ToolInputError(`input_references[${index}] must be an object.`)
    if (item.type === "image_url") {
      assertExactKeys(item, ["type", "image_url"], `input_references[${index}]`)
      parsed.push({ image_url: urlValue(item.image_url, `input_references[${index}].image_url`), type: "image_url" })
    } else if (item.type === "video_url") {
      assertExactKeys(item, ["type", "video_url"], `input_references[${index}]`)
      parsed.push({ type: "video_url", video_url: urlValue(item.video_url, `input_references[${index}].video_url`) })
    } else if (item.type === "audio_url") {
      assertExactKeys(item, ["type", "audio_url"], `input_references[${index}]`)
      parsed.push({ audio_url: urlValue(item.audio_url, `input_references[${index}].audio_url`), type: "audio_url" })
    } else {
      throw new ToolInputError(`input_references[${index}].type is unsupported.`)
    }
  }
  const videos = parsed.filter((item) => item.type === "video_url").length
  const audios = parsed.filter((item) => item.type === "audio_url").length
  const visuals = parsed.length - audios
  if (visuals > 9) throw new ToolInputError("input_references supports at most 9 combined image/video references.")
  if (videos > 3) throw new ToolInputError("input_references supports at most 3 video references.")
  if (audios > 3) throw new ToolInputError("input_references supports at most 3 audio references.")
  return parsed
}

function parseFrameImages(value: unknown): PippitGenerateVideoToolInput["frame_images"] {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 2) {
    throw new ToolInputError("frame_images must contain at most 2 entries.")
  }
  const parsed: NonNullable<PippitGenerateVideoToolInput["frame_images"]>[number][] = []
  const frameTypes = new Set<string>()
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) throw new ToolInputError(`frame_images[${index}] must be an object.`)
    assertExactKeys(item, ["type", "image_url", "frame_type"], `frame_images[${index}]`)
    if (item.type !== "image_url" || (item.frame_type !== "first_frame" && item.frame_type !== "last_frame")) {
      throw new ToolInputError(`frame_images[${index}] must be a first_frame or last_frame image_url.`)
    }
    if (frameTypes.has(item.frame_type)) throw new ToolInputError(`frame_images contains duplicate ${item.frame_type}.`)
    frameTypes.add(item.frame_type)
    parsed.push({
      frame_type: item.frame_type,
      image_url: urlValue(item.image_url, `frame_images[${index}].image_url`),
      type: "image_url",
    })
  }
  return parsed
}

function parseGenerateInput(value: unknown): PippitGenerateVideoToolInput {
  if (!isRecord(value)) throw new ToolInputError("Tool arguments must be an object.")
  assertExactKeys(
    value,
    ["aspect_ratio", "byok_id", "duration", "frame_images", "idempotency_key", "input_references", "model", "prompt", "resolution", "seed", "thread_id"],
    "arguments",
  )
  const prompt = nonEmptyString(value.prompt, "prompt", 20_000)
  const frameImages = parseFrameImages(value.frame_images)
  const inputReferences = parseInputReferences(value.input_references)
  if ((frameImages?.length ?? 0) > 0 && (inputReferences?.length ?? 0) > 0) {
    throw new ToolInputError("frame_images cannot be combined with input_references.")
  }
  return {
    ...(value.aspect_ratio === undefined ? {} : { aspect_ratio: nonEmptyString(value.aspect_ratio, "aspect_ratio", 64) }),
    ...(value.byok_id === undefined ? {} : { byok_id: nonEmptyString(value.byok_id, "byok_id", 256) }),
    ...(value.duration === undefined ? {} : { duration: optionalInteger(value.duration, "duration", 1, 3_600) as number }),
    ...(frameImages === undefined ? {} : { frame_images: frameImages }),
    ...(value.idempotency_key === undefined ? {} : { idempotency_key: idempotencyKey(value.idempotency_key) }),
    ...(inputReferences === undefined ? {} : { input_references: inputReferences }),
    model: nonEmptyString(value.model, "model", 256),
    prompt,
    ...(value.resolution === undefined ? {} : { resolution: nonEmptyString(value.resolution, "resolution", 64) }),
    ...(value.seed === undefined ? {} : { seed: optionalInteger(value.seed, "seed", -1, 4_294_967_295) as number }),
    ...(value.thread_id === undefined ? {} : { thread_id: nonEmptyString(value.thread_id, "thread_id", 8_192) }),
  }
}

function parseGenerateImageInput(value: unknown): PippitGenerateImageToolInput {
  if (!isRecord(value)) throw new ToolInputError("Tool arguments must be an object.")
  assertExactKeys(
    value,
    ["byok_id", "images", "model", "n", "prompt", "resolution", "thread_id"],
    "arguments",
  )
  const model = nonEmptyString(value.model, "model", 256)
  if (model !== "pippit/seedream-5.0" && model !== "pippit/seedream-5.0-pro") {
    throw new ToolInputError("model must be pippit/seedream-5.0 or pippit/seedream-5.0-pro.")
  }
  const references = parseInputReferences(value.images)
  if (references !== undefined && (references.length > 9 || references.some((item) => item.type !== "image_url"))) {
    throw new ToolInputError("images must contain at most 9 image_url references.")
  }
  const resolution = value.resolution === undefined
    ? undefined
    : nonEmptyString(value.resolution, "resolution", 2)
  if (resolution !== undefined && resolution !== "1K" && resolution !== "2K" && resolution !== "4K") {
    throw new ToolInputError("resolution must be 1K, 2K, or 4K.")
  }
  if (model === "pippit/seedream-5.0" && resolution !== undefined) {
    throw new ToolInputError("resolution must be omitted for pippit/seedream-5.0.")
  }
  return {
    ...(value.byok_id === undefined ? {} : { byok_id: nonEmptyString(value.byok_id, "byok_id", 256) }),
    ...(references === undefined
      ? {}
      : { images: references as readonly NonNullable<PippitGenerateImageToolInput["images"]>[number][] }),
    model,
    ...(value.n === undefined ? {} : { n: optionalInteger(value.n, "n", 1, 10) as number }),
    prompt: nonEmptyString(value.prompt, "prompt", 20_000),
    ...(resolution === undefined ? {} : { resolution }),
    ...(value.thread_id === undefined ? {} : { thread_id: nonEmptyString(value.thread_id, "thread_id", 8_192) }),
  }
}

function finiteNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ToolInputError(`${name} must be a finite number from ${minimum} to ${maximum}.`)
  }
  return value
}

function parseEditInput(value: unknown): PippitEditVideoSegmentToolInput {
  if (!isRecord(value)) throw new ToolInputError("Tool arguments must be an object.")
  assertExactKeys(
    value,
    ["annotations", "byok_id", "idempotency_key", "model", "prompt", "resolution", "seed", "segment", "source_index", "source_job_id", "thread_id"],
    "arguments",
  )
  if (!isRecord(value.segment)) throw new ToolInputError("segment must be an object.")
  assertExactKeys(value.segment, ["start_ms", "end_ms"], "segment")
  const startMs = optionalInteger(value.segment.start_ms, "segment.start_ms", 0, Number.MAX_SAFE_INTEGER)
  const endMs = optionalInteger(value.segment.end_ms, "segment.end_ms", 1, Number.MAX_SAFE_INTEGER)
  if (startMs === undefined || endMs === undefined || endMs <= startMs) {
    throw new ToolInputError("segment.end_ms must be greater than segment.start_ms.")
  }
  if (endMs - startMs > 30_000) {
    throw new ToolInputError("segment must be at most 30000 milliseconds.")
  }
  if (!Array.isArray(value.annotations) || value.annotations.length > 20) {
    throw new ToolInputError("annotations must contain at most 20 entries.")
  }
  const annotations: PippitEditVideoSegmentToolInput["annotations"][number][] = []
  for (const [index, annotationValue] of value.annotations.entries()) {
    const name = `annotations[${index}]`
    if (!isRecord(annotationValue)) throw new ToolInputError(`${name} must be an object.`)
    assertExactKeys(annotationValue, ["at_ms", "region", "instruction"], name)
    const atMs = optionalInteger(annotationValue.at_ms, `${name}.at_ms`, 0, Number.MAX_SAFE_INTEGER)
    if (atMs === undefined || atMs < startMs || atMs > endMs) {
      throw new ToolInputError(`${name}.at_ms must fall within segment.`)
    }
    if (!isRecord(annotationValue.region)) throw new ToolInputError(`${name}.region must be an object.`)
    assertExactKeys(annotationValue.region, ["x", "y", "width", "height"], `${name}.region`)
    const x = finiteNumber(annotationValue.region.x, `${name}.region.x`, 0, 1)
    const y = finiteNumber(annotationValue.region.y, `${name}.region.y`, 0, 1)
    const width = finiteNumber(annotationValue.region.width, `${name}.region.width`, 0, 1)
    const height = finiteNumber(annotationValue.region.height, `${name}.region.height`, 0, 1)
    if (width === 0 || height === 0 || x + width > 1 || y + height > 1) {
      throw new ToolInputError(`${name}.region must be a non-empty normalized rectangle within the video.`)
    }
    annotations.push({
      at_ms: atMs,
      instruction: nonEmptyString(annotationValue.instruction, `${name}.instruction`, 2_000),
      region: { height, width, x, y },
    })
  }
  const prompt = value.prompt === undefined ? undefined : nonEmptyString(value.prompt, "prompt", 20_000)
  if (prompt === undefined && annotations.length === 0) {
    throw new ToolInputError("Provide prompt or at least one annotation.")
  }
  return {
    annotations,
    ...(value.byok_id === undefined ? {} : { byok_id: nonEmptyString(value.byok_id, "byok_id", 256) }),
    ...(value.idempotency_key === undefined ? {} : { idempotency_key: idempotencyKey(value.idempotency_key) }),
    model: nonEmptyString(value.model, "model", 256),
    ...(prompt === undefined ? {} : { prompt }),
    ...(value.resolution === undefined ? {} : { resolution: nonEmptyString(value.resolution, "resolution", 64) }),
    ...(value.seed === undefined ? {} : { seed: optionalInteger(value.seed, "seed", -1, 4_294_967_295) as number }),
    segment: { end_ms: endMs, start_ms: startMs },
    source_index: optionalInteger(value.source_index, "source_index", 0, 1_000) ?? 0,
    source_job_id: nonEmptyString(value.source_job_id, "source_job_id"),
    ...(value.thread_id === undefined ? {} : { thread_id: nonEmptyString(value.thread_id, "thread_id", 8_192) }),
  }
}

function parseAddAccessKeyInput(value: unknown): PippitAddAccessKeyToolInput {
  if (!isRecord(value)) throw new ToolInputError("Tool arguments must be an object.")
  assertExactKeys(value, ["account_name"], "arguments")
  return { account_name: nonEmptyString(value.account_name, "account_name", 128) }
}

function parseSwitchAccessKeyInput(value: unknown): PippitSwitchAccessKeyToolInput {
  if (!isRecord(value)) throw new ToolInputError("Tool arguments must be an object.")
  assertExactKeys(value, ["credential_id"], "arguments")
  return { credential_id: nonEmptyString(value.credential_id, "credential_id") }
}

function parseDeleteAccessKeyInput(value: unknown): PippitDeleteAccessKeyToolInput {
  if (!isRecord(value)) throw new ToolInputError("Tool arguments must be an object.")
  assertExactKeys(value, ["credential_id", "confirm"], "arguments")
  if (value.confirm !== true) throw new ToolInputError("confirm must be true to delete an Access Key.")
  return { confirm: true, credential_id: nonEmptyString(value.credential_id, "credential_id") }
}

function parseGetInput(value: unknown): PippitGetVideoToolInput {
  if (!isRecord(value)) throw new ToolInputError("Tool arguments must be an object.")
  assertExactKeys(value, ["job_id"], "arguments")
  return { job_id: nonEmptyString(value.job_id, "job_id") }
}

function safeRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0") || value.length > 4_096) {
    throw new ToolInputError("output_path must be a non-empty relative path.")
  }
  if (isAbsolute(value) || win32.isAbsolute(value)) {
    throw new ToolInputError("output_path must stay beneath PIPPIT_MCP_OUTPUT_ROOT.")
  }
  const segments = value.split(/[\\/]+/u)
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ToolInputError("output_path must not contain empty, current-directory, or parent-directory segments.")
  }
  return segments.join("/")
}

function parseDownloadInput(value: unknown): PippitDownloadVideoToolInput {
  if (!isRecord(value)) throw new ToolInputError("Tool arguments must be an object.")
  assertExactKeys(value, ["index", "job_id", "output_path"], "arguments")
  return {
    ...(value.index === undefined ? {} : { index: optionalInteger(value.index, "index", 0, 1_000) as number }),
    job_id: nonEmptyString(value.job_id, "job_id"),
    output_path: safeRelativePath(value.output_path),
  }
}

function facadeRequest(input: PippitGenerateVideoToolInput): PippitVideoGenerateRequest {
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

function facadeImageRequest(input: PippitGenerateImageToolInput): PippitImageGenerateRequest {
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

function facadeEditRequest(input: PippitEditVideoSegmentToolInput): PippitVideoEditRequest {
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

function structuredResult(value: object): PippitMcpCallToolResult {
  const structuredContent = value as Readonly<Record<string, unknown>>
  return {
    content: [{ text: JSON.stringify(value), type: "text" }],
    structuredContent,
  }
}

function imageResult(value: PippitImageGenerationResponse): PippitMcpCallToolResult {
  const images = value.data.map((image) => ({ media_type: image.media_type ?? "image/png" }))
  return {
    content: [
      {
        text: `Generated ${images.length} image${images.length === 1 ? "" : "s"} with ${value.model}. The inline result card displays the images and provides Download original; do not regenerate when the user asks for the same file.`,
        type: "text",
      },
      ...value.data.map((image) => ({
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

function safeError(error: unknown): PippitMcpCallToolResult {
  const message =
    error instanceof ToolInputError || error instanceof PippitFacadeError
      ? error.message
      : isRecord(error) && error.code === "EEXIST"
        ? "Output file already exists; choose a new output_path."
        : "Pippit tool could not complete the operation."
  return { content: [{ text: message.slice(0, 2_000), type: "text" }], isError: true }
}

function inside(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined
}

async function ensureSafeOutputParent(root: string, segments: readonly string[]): Promise<string> {
  let current = root
  for (const segment of segments) {
    const next = resolve(current, segment)
    if (!inside(root, next)) throw new ToolInputError("output_path escapes PIPPIT_MCP_OUTPUT_ROOT.")
    try {
      await mkdir(next, { mode: 0o700 })
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
    const stats = await lstat(next)
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new ToolInputError("output_path contains a symbolic link or non-directory parent.")
    }
    current = await realpath(next)
    if (!inside(root, current)) {
      throw new ToolInputError("output_path escapes PIPPIT_MCP_OUTPUT_ROOT through a symbolic link.")
    }
  }
  return current
}

async function writeDownload(input: {
  readonly maxBytes: number
  readonly outputRoot: string
  readonly relativePath: string
  readonly response: Response
}): Promise<{ readonly bytes: number; readonly mediaType: string }> {
  const declared = input.response.headers.get("content-length")
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > input.maxBytes)) {
    throw new ToolInputError("The video output exceeds the configured download byte limit.")
  }
  if (input.response.body === null) throw new ToolInputError("Pippit facade returned an empty video body.")
  await mkdir(input.outputRoot, { recursive: true })
  const root = await realpath(input.outputRoot)
  const relativeSegments = input.relativePath.split("/")
  const lexicalTarget = resolve(root, ...relativeSegments)
  if (!inside(root, lexicalTarget)) throw new ToolInputError("output_path escapes PIPPIT_MCP_OUTPUT_ROOT.")
  const parent = await ensureSafeOutputParent(root, relativeSegments.slice(0, -1))
  const target = resolve(parent, relativeSegments.at(-1) as string)
  const handle = await open(target, "wx", 0o600)
  let bytes = 0
  let succeeded = false
  try {
    const reader = input.response.body.getReader()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > input.maxBytes) {
          await reader.cancel()
          throw new ToolInputError("The video output exceeds the configured download byte limit.")
        }
        let offset = 0
        while (offset < chunk.value.byteLength) {
          const written = await handle.write(chunk.value, offset, chunk.value.byteLength - offset)
          offset += written.bytesWritten
        }
      }
    } finally {
      reader.releaseLock()
    }
    await handle.sync()
    succeeded = true
  } finally {
    await handle.close()
    if (!succeeded) {
      try {
        await unlink(target)
      } catch {
        // Cleanup failure is intentionally hidden from the tool result.
      }
    }
  }
  const mediaType = input.response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  return { bytes, mediaType: mediaType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType) ? mediaType : "video/mp4" }
}

export function createPippitToolRuntime(options: PippitToolRuntimeOptions): PippitToolRuntime {
  const dedupeLimit = options.dedupeLimit ?? 256
  const maxDownloadBytes = options.maxDownloadBytes ?? 2 * 1024 * 1024 * 1024
  if (!Number.isSafeInteger(dedupeLimit) || dedupeLimit < 1 || dedupeLimit > 10_000) {
    throw new Error("dedupeLimit must be an integer from 1 to 10000.")
  }
  if (!Number.isSafeInteger(maxDownloadBytes) || maxDownloadBytes < 1) {
    throw new Error("maxDownloadBytes must be a positive safe integer.")
  }
  if (options.managementClient === undefined && options.enrollmentServer !== undefined) {
    throw new Error("enrollmentServer requires managementClient.")
  }
  if (options.idempotencyStore !== undefined && !options.idempotencyScope?.trim()) {
    throw new Error("idempotencyScope is required when idempotencyStore is configured.")
  }
  const outputRoot = resolve(options.outputRoot ?? PIPPIT_DEFAULT_OUTPUT_DIRECTORY)
  const dedupe = new Map<string, DedupeEntry>()
  const enrollmentServer = options.managementClient === undefined
    ? undefined
    : options.enrollmentServer ?? createPippitAccessKeyEnrollmentServer({
        managementClient: options.managementClient,
        ...(options.enrollmentPort === undefined ? {} : { port: options.enrollmentPort }),
        ...(options.enrollmentTtlMs === undefined ? {} : { ttlMs: options.enrollmentTtlMs }),
      })

  const submit = (
    idempotencyKey: string | undefined,
    operation: "edit" | "generate",
    request: PippitVideoEditRequest | PippitVideoGenerateRequest,
    create: () => Promise<object>,
  ): Promise<object> => {
    if (idempotencyKey === undefined) return create()
    const fingerprint = JSON.stringify({ operation, request })
    const existing = dedupe.get(idempotencyKey)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new ToolInputError("idempotency_key was already used for a different request in this MCP process.")
      }
      return existing.promise
    }
    if (dedupe.size >= dedupeLimit) {
      const settledKey = [...dedupe].find(([, entry]) => entry.settled)?.[0]
      if (settledKey === undefined) {
        throw new ToolInputError("The process-local idempotency cache is busy; retry after an in-flight submission settles.")
      }
      dedupe.delete(settledKey)
    }
    const durableSubmission = async (): Promise<object> => {
      if (options.idempotencyStore === undefined) return create()
      const begun = await options.idempotencyStore.begin({
        key: idempotencyKey,
        operation: operation === "generate" ? "mcp_generate_video" : "mcp_edit_video",
        request,
        scope: options.idempotencyScope as string,
      })
      if (begun.kind === "replay") return begun.response as object
      if (begun.kind === "conflict") {
        throw new ToolInputError("idempotency_key was already used for a different recovery request.")
      }
      if (begun.kind === "in_progress") {
        throw new ToolInputError(`The recovery request for this idempotency_key is still ${begun.phase}.`)
      }
      if (begun.kind === "indeterminate") {
        throw new ToolInputError("The previous submission may have reached Pippit. Do not retry automatically; inspect the original task first.")
      }
      if (begun.kind === "failed") {
        throw new ToolInputError(`The previous recovery request failed (${begun.errorCode}).`)
      }
      await options.idempotencyStore.markSubmitting(begun.recordId)
      let response: object
      try {
        response = await create()
      } catch (error) {
        const ambiguous = !(error instanceof PippitFacadeError) ||
          ["ABORTED", "INVALID_RESPONSE", "NETWORK_ERROR", "TIMEOUT"].includes(error.code)
        if (ambiguous) await options.idempotencyStore.markIndeterminate(begun.recordId)
        else await options.idempotencyStore.markFailed(begun.recordId, error.code.toLowerCase())
        throw error
      }
      try {
        await options.idempotencyStore.markSubmitted(begun.recordId, response)
      } catch {
        throw new ToolInputError("Pippit accepted the task, but its recovery record could not be saved. Do not retry automatically.")
      }
      return response
    }
    const entry: DedupeEntry = {
      fingerprint,
      promise: durableSubmission(),
      settled: false,
    }
    dedupe.set(idempotencyKey, entry)
    void entry.promise.then(
      () => { entry.settled = true },
      () => { entry.settled = true },
    )
    return entry.promise
  }

  return {
    async callTool(name, argumentsValue) {
      try {
        if (name === "pippit_list_image_models") {
          if (argumentsValue !== undefined) {
            if (!isRecord(argumentsValue)) throw new ToolInputError("Tool arguments must be an object.")
            assertExactKeys(argumentsValue, [], "arguments")
          }
          return structuredResult(await options.client.listImageModels())
        }
        if (name === "pippit_generate_image") {
          const input = parseGenerateImageInput(argumentsValue)
          const request = facadeImageRequest(input)
          return imageResult(await options.client.generateImage(request))
        }
        if (name === "pippit_list_video_models") {
          if (argumentsValue !== undefined) {
            if (!isRecord(argumentsValue)) throw new ToolInputError("Tool arguments must be an object.")
            assertExactKeys(argumentsValue, [], "arguments")
          }
          return structuredResult(await options.client.listVideoModels())
        }
        if (name === "pippit_generate_video") {
          const input = parseGenerateInput(argumentsValue)
          const request = facadeRequest(input)
          return structuredResult(await submit(
            input.idempotency_key,
            "generate",
            request,
            async () => options.client.generateVideo(request),
          ))
        }
        if (name === "pippit_get_video") {
          const input = parseGetInput(argumentsValue)
          return structuredResult(await options.client.getVideo(input.job_id))
        }
        if (name === "pippit_download_video") {
          const input = parseDownloadInput(argumentsValue)
          const index = input.index ?? 0
          const response = await options.client.downloadVideo(input.job_id, { index })
          const written = await writeDownload({
            maxBytes: maxDownloadBytes,
            outputRoot,
            relativePath: input.output_path,
            response,
          })
          const result: PippitDownloadedVideo = {
            bytes: written.bytes,
            index,
            job_id: input.job_id,
            media_type: written.mediaType,
            path: input.output_path,
          }
          return structuredResult(result)
        }
        if (name === "pippit_edit_video_segment") {
          const input = parseEditInput(argumentsValue)
          const request = facadeEditRequest(input)
          return structuredResult(await submit(
            input.idempotency_key,
            "edit",
            request,
            async () => options.client.editVideo(request),
          ))
        }
        if (options.managementClient !== undefined && enrollmentServer !== undefined) {
          if (name === "pippit_list_access_keys") {
            if (argumentsValue !== undefined) {
              if (!isRecord(argumentsValue)) throw new ToolInputError("Tool arguments must be an object.")
              assertExactKeys(argumentsValue, [], "arguments")
            }
            return structuredResult(await options.managementClient.listAccessKeys())
          }
          if (name === "pippit_add_access_key") {
            const input = parseAddAccessKeyInput(argumentsValue)
            return structuredResult(await enrollmentServer.createEnrollment(input.account_name))
          }
          if (name === "pippit_switch_access_key") {
            const input = parseSwitchAccessKeyInput(argumentsValue)
            return structuredResult(await options.managementClient.switchAccessKey(input.credential_id))
          }
          if (name === "pippit_delete_access_key") {
            const input = parseDeleteAccessKeyInput(argumentsValue)
            return structuredResult(await options.managementClient.deleteAccessKey(input.credential_id))
          }
        }
        throw new ToolInputError(`Unknown Pippit tool ${name}.`)
      } catch (error) {
        return safeError(error)
      }
    },
    async close() {
      await Promise.all([enrollmentServer?.close(), options.idempotencyStore?.close()])
    },
    listTools() {
      return options.managementClient === undefined
        ? PIPPIT_RUNTIME_TOOL_DEFINITIONS
        : [...PIPPIT_RUNTIME_TOOL_DEFINITIONS, ...PIPPIT_MANAGEMENT_TOOL_DEFINITIONS]
    },
  }
}
