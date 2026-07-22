import {
  PIPPIT_WIDGET_IMAGE_JOB_ID_PATTERN,
  PIPPIT_WIDGET_MAX_VIDEO_CHUNK_BYTES,
  widgetGetImageInputContract,
  widgetReadImageInputContract,
  widgetReadVideoChunkInputContract,
  widgetResolveLatestVideoInputContract,
  widgetRevealImageInputContract,
  type RuntimeContract,
} from "@pippit-bridge/contracts"
import {
  PIPPIT_RUNTIME_TOOL_DEFINITIONS,
  type PippitToolDefinition,
} from "../tools.ts"
import { PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_NAME } from "../widget-lineage.ts"
import { pippitImageWidgetOutputSchema } from "../widget-protocol.ts"

export const PIPPIT_READ_VIDEO_CHUNK_TOOL_NAME = "pippit_read_video_chunk"
export const PIPPIT_READ_IMAGE_TOOL_NAME = "pippit_read_image"
export const PIPPIT_GET_IMAGE_TOOL_NAME = "pippit_get_image"
export const PIPPIT_REVEAL_IMAGE_TOOL_NAME = "pippit_reveal_image"
export { PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_NAME } from "../widget-lineage.ts"

export const MAX_VIDEO_CHUNK_BYTES = PIPPIT_WIDGET_MAX_VIDEO_CHUNK_BYTES
export const IMAGE_JOB_ID_PATTERN = PIPPIT_WIDGET_IMAGE_JOB_ID_PATTERN
const IMAGE_COMPLETED_OUTPUT_SCHEMA = PIPPIT_RUNTIME_TOOL_DEFINITIONS.find(
  definition => definition.name === "pippit_generate_image",
)?.outputSchema ?? { type: "object" }

function projectedSchema(contract: RuntimeContract<unknown>): Readonly<Record<string, unknown>> {
  const { $schema: _schemaDialect, ...schema } = contract.toJsonSchema()
  return schema
}

export const PIPPIT_GET_IMAGE_TOOL_DEFINITION: PippitToolDefinition = {
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
    title: "Get Pippit image result",
  },
  description: "Poll an image generation started by pippit_generate_image until the local result is ready.",
  inputSchema: projectedSchema(widgetGetImageInputContract),
  name: PIPPIT_GET_IMAGE_TOOL_NAME as PippitToolDefinition["name"],
  outputSchema: pippitImageWidgetOutputSchema(IMAGE_COMPLETED_OUTPUT_SCHEMA),
  title: "Get Pippit image result",
}

export const PIPPIT_REVEAL_IMAGE_TOOL_DEFINITION: PippitToolDefinition = {
  _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
    title: "Show saved image in file manager",
  },
  description: "Reveal one persistent local Pippit image in Finder or the system file manager.",
  inputSchema: projectedSchema(widgetRevealImageInputContract),
  name: PIPPIT_REVEAL_IMAGE_TOOL_NAME as PippitToolDefinition["name"],
  outputSchema: {
    additionalProperties: false,
    properties: { revealed: { const: true, type: "boolean" } },
    required: ["revealed"],
    type: "object",
  },
  title: "Show saved image in file manager",
}

export const PIPPIT_READ_IMAGE_TOOL_DEFINITION: PippitToolDefinition = {
  _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
    title: "Read saved image",
  },
  description: "Read one persistent local Pippit image for the Pippit image widget.",
  inputSchema: projectedSchema(widgetReadImageInputContract),
  name: PIPPIT_READ_IMAGE_TOOL_NAME as PippitToolDefinition["name"],
  outputSchema: {
    additionalProperties: false,
    properties: {
      blob: { contentEncoding: "base64", type: "string" },
      bytes: { minimum: 1, type: "integer" },
      filename: { type: "string" },
      mime_type: { enum: ["image/jpeg", "image/png", "image/webp"], type: "string" },
      resource_uri: { type: "string" },
    },
    required: ["resource_uri", "filename", "bytes", "mime_type", "blob"],
    type: "object",
  },
  title: "Read saved image",
}

export const PIPPIT_READ_VIDEO_CHUNK_TOOL_DEFINITION: PippitToolDefinition = {
  _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
    title: "Read saved video chunk",
  },
  description: "Read one bounded chunk from a persistent local Pippit MP4 for the Pippit video widget.",
  inputSchema: projectedSchema(widgetReadVideoChunkInputContract),
  name: PIPPIT_READ_VIDEO_CHUNK_TOOL_NAME as PippitToolDefinition["name"],
  outputSchema: {
    additionalProperties: false,
    properties: {
      blob: { contentEncoding: "base64", type: "string" },
      bytes: { minimum: 1, type: "integer" },
      complete: { type: "boolean" },
      mime_type: { const: "video/mp4", type: "string" },
      offset: { minimum: 0, type: "integer" },
      resource_uri: { type: "string" },
      total_bytes: { minimum: 1, type: "integer" },
    },
    required: ["resource_uri", "offset", "bytes", "total_bytes", "complete", "mime_type", "blob"],
    type: "object",
  },
  title: "Read saved video chunk",
}

export const PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_DEFINITION: PippitToolDefinition = {
  _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
    title: "Resolve latest regenerated video",
  },
  description: "Resolve the newest regenerated descendant of a Pippit video job without starting a generation.",
  inputSchema: projectedSchema(widgetResolveLatestVideoInputContract),
  name: PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_NAME as PippitToolDefinition["name"],
  outputSchema: PIPPIT_RUNTIME_TOOL_DEFINITIONS.find(definition => definition.name === "pippit_get_video")
    ?.outputSchema ?? { type: "object" },
  title: "Resolve latest regenerated video",
}
