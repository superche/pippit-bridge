import {
  addAccessKeyToolInputContract,
  deleteAccessKeyToolInputContract,
  downloadVideoToolInputContract,
  editVideoToolInputContract,
  emptyToolInputContract,
  generateImageToolInputContract,
  generateVideoToolInputContract,
  getVideoToolInputContract,
  switchAccessKeyToolInputContract,
  type RuntimeContract,
} from "@pippit-bridge/contracts"
import {
  PIPPIT_MANAGEMENT_TOOL_NAMES,
  PIPPIT_RUNTIME_TOOL_NAMES,
  type PippitToolDefinition,
  type PippitToolName,
} from "./contract.ts"

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

function projectedSchema(contract: RuntimeContract<unknown>): Readonly<Record<string, unknown>> {
  const { $schema: _schemaDialect, ...schema } = contract.toJsonSchema()
  return schema
}

const EMPTY = projectedSchema(emptyToolInputContract)
const GENERATE_IMAGE = projectedSchema(generateImageToolInputContract)
const GENERATE_VIDEO = projectedSchema(generateVideoToolInputContract)
const GET_VIDEO = projectedSchema(getVideoToolInputContract)
const DOWNLOAD_VIDEO = projectedSchema(downloadVideoToolInputContract)
const EDIT_VIDEO = projectedSchema(editVideoToolInputContract)
const ADD_ACCESS_KEY = projectedSchema(addAccessKeyToolInputContract)
const SWITCH_ACCESS_KEY = projectedSchema(switchAccessKeyToolInputContract)
const DELETE_ACCESS_KEY = projectedSchema(deleteAccessKeyToolInputContract)

export const PIPPIT_TOOL_DEFINITIONS: readonly PippitToolDefinition[] = [
  {
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true, title: "List Pippit image models" },
    description: "List Seedream image generation models and their model-specific settings.",
    inputSchema: EMPTY,
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
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true, readOnlyHint: false, title: "Generate Pippit images" },
    description: "Generate images with Seedream 5.0 or Seedream 5.0 Pro. This may incur Pippit charges. Optional reference images are fetched and uploaded by the facade; the completed images are returned directly to the host.",
    inputSchema: GENERATE_IMAGE,
    name: "pippit_generate_image",
    outputSchema: {
      additionalProperties: false,
      properties: {
        created: { minimum: 0, type: "integer" },
        images: {
          items: {
            additionalProperties: false,
            properties: {
              bytes: { minimum: 0, type: "integer" },
              filename: { type: "string" },
              media_type: { type: "string" },
              resource_uri: { pattern: "^pippit-image://artifact/", type: "string" },
            },
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
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true, title: "List Pippit video models" },
    description: "List video generation models and supported settings exposed by the configured Pippit facade.",
    inputSchema: EMPTY,
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
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true, readOnlyHint: false, title: "Generate a Pippit video" },
    description: "Submit one asynchronous Pippit video generation job. This may incur Pippit charges, and supplied reference URLs are fetched, uploaded, and processed by the facade/Pippit. Returns immediately; use pippit_get_video to poll it.",
    inputSchema: GENERATE_VIDEO,
    name: "pippit_generate_video",
    outputSchema: jobOutputSchema,
    title: "Generate a Pippit video",
  },
  {
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true, title: "Get a Pippit video job" },
    description: "Read the current state of one Pippit video generation job. Completed outputs are delivered to the host through a private preview widget.",
    inputSchema: GET_VIDEO,
    name: "pippit_get_video",
    outputSchema: jobOutputSchema,
    title: "Get a Pippit video job",
  },
  {
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: false, title: "Create another local video copy" },
    description: "Create an additional named copy of one completed video under the configured output root. Normal completed widget results are already saved locally first. Never overwrites files.",
    inputSchema: DOWNLOAD_VIDEO,
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
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true, readOnlyHint: false, title: "Regenerate a Pippit video from a result" },
    description: "Submit an asynchronous regeneration with one completed Pippit video output as the reference. The selected range, overall prompt, and normalized frame annotations become generation guidance. This may incur Pippit charges.",
    inputSchema: EDIT_VIDEO,
    name: "pippit_edit_video_segment",
    outputSchema: jobOutputSchema,
    title: "Regenerate a Pippit video from a result",
  },
  {
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true, title: "List Pippit Access Keys" },
    description: "List facade-managed Pippit accounts for this caller. Returns only masked metadata and the active selection, never raw keys or fingerprints.",
    inputSchema: EMPTY,
    name: "pippit_list_access_keys",
    outputSchema: {
      additionalProperties: false,
      properties: { data: { items: accessKeyCredentialOutputSchema, type: "array" }, total_count: { minimum: 0, type: "integer" } },
      required: ["data", "total_count"],
      type: "object",
    },
    title: "List Pippit Access Keys",
  },
  {
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false, readOnlyHint: false, title: "Add a Pippit Access Key" },
    description: "Create a five-minute, single-use loopback enrollment form for a Pippit account. The Access Key must be entered only in that password form and never in tool arguments or chat.",
    inputSchema: ADD_ACCESS_KEY,
    name: "pippit_add_access_key",
    outputSchema: {
      additionalProperties: false,
      properties: { account_name: { type: "string" }, enrollment_url: { format: "uri", type: "string" }, expires_at: { type: "string" } },
      required: ["account_name", "enrollment_url", "expires_at"],
      type: "object",
    },
    title: "Add a Pippit Access Key",
  },
  {
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false, title: "Switch active Pippit Access Key" },
    description: "Select one facade-managed credential for new Pippit jobs from this caller.",
    inputSchema: SWITCH_ACCESS_KEY,
    name: "pippit_switch_access_key",
    outputSchema: accessKeySelectionOutputSchema,
    title: "Switch active Pippit Access Key",
  },
  {
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false, title: "Delete a Pippit Access Key" },
    description: "Permanently delete one facade-managed Pippit credential. This does not revoke the key at Pippit. Explicit confirmation is required.",
    inputSchema: DELETE_ACCESS_KEY,
    name: "pippit_delete_access_key",
    outputSchema: {
      additionalProperties: false,
      properties: { credential_id: { type: "string" }, deleted: { const: true, type: "boolean" } },
      required: ["credential_id", "deleted"],
      type: "object",
    },
    title: "Delete a Pippit Access Key",
  },
]

export const PIPPIT_TOOL_DEFINITIONS_BY_NAME = Object.freeze(
  Object.fromEntries(PIPPIT_TOOL_DEFINITIONS.map(definition => [definition.name, definition])),
) as Readonly<Record<PippitToolName, PippitToolDefinition>>

export function getPippitToolDefinition(name: PippitToolName): PippitToolDefinition {
  return PIPPIT_TOOL_DEFINITIONS_BY_NAME[name]
}

export function selectPippitToolDefinitions(names: readonly PippitToolName[]): readonly PippitToolDefinition[] {
  return names.map(name => getPippitToolDefinition(name))
}

export const PIPPIT_RUNTIME_TOOL_DEFINITIONS = selectPippitToolDefinitions(PIPPIT_RUNTIME_TOOL_NAMES)
export const PIPPIT_MANAGEMENT_TOOL_DEFINITIONS = selectPippitToolDefinitions(PIPPIT_MANAGEMENT_TOOL_NAMES)
