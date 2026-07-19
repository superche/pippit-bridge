import type {
  PippitMcpCallToolResult,
  PippitToolDefinition,
} from "./tools.ts"
import {
  PIPPIT_WIDGET_HTML,
  PIPPIT_WIDGET_URI,
} from "./widget.ts"

export const PIPPIT_WIDGET_MIME_TYPE = "text/html;profile=mcp-app"

const WIDGET_TOOL_NAMES = new Set([
  "pippit_generate_video",
  "pippit_get_video",
  "pippit_edit_video_segment",
])

const LEGACY_PIPPIT_WIDGET_URIS = new Set([
  "ui://widget/pippit-video-job-v5.html",
  "ui://widget/pippit-video-job-v6.html",
  "ui://widget/pippit-video-job-v7.html",
])

const INVOCATION_STATUS: Readonly<Record<string, readonly [string, string]>> = {
  pippit_edit_video_segment: ["Submitting Pippit edit…", "Pippit edit submitted"],
  pippit_generate_video: ["Starting Pippit generation…", "Pippit generation started"],
  pippit_get_video: ["Refreshing Pippit video…", "Pippit video refreshed"],
}

interface JobLike {
  readonly id: string
  readonly status: string
  readonly unsigned_urls?: readonly string[]
}

export interface PippitWidgetMediaPreview {
  readonly bytes?: number
  readonly filename?: string
  readonly index: number
  readonly kind: "video"
  readonly local_path?: string
  readonly resource_uri?: string
  readonly url?: string
}

interface PippitWidgetPreparedPreviewBase {
  readonly bytes: number
  readonly filename: string
  readonly localPath: string
}

export type PippitWidgetPreparedPreview = PippitWidgetPreparedPreviewBase & (
  | { readonly resourceUri: string; readonly url?: never }
  | { readonly resourceUri?: never; readonly url: string }
)

export type PippitWidgetPreviewUrlFactory = (
  jobId: string,
  index: number,
) => Promise<PippitWidgetPreparedPreview | string> | PippitWidgetPreparedPreview | string

export interface PippitWidgetResourceMetadataOptions {
  readonly domain?: string
  readonly origin?: string
}

function extractJob(value: unknown, depth = 0): JobLike | undefined {
  if (depth > 6 || value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const object = value as Record<string, unknown>
  const id = typeof object.id === "string" ? object.id : object.job_id
  if (typeof id === "string" && typeof object.status === "string") {
    return {
      id,
      status: object.status,
      ...(Array.isArray(object.unsigned_urls)
        ? { unsigned_urls: object.unsigned_urls.filter((url): url is string => typeof url === "string") }
        : {}),
    }
  }
  for (const nested of Object.values(object)) {
    const job = extractJob(nested, depth + 1)
    if (job !== undefined) return job
  }
  return undefined
}

export function sanitizePippitWidgetValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePippitWidgetValue)
  if (typeof value === "string") {
    return value.replace(
      /(?:https?:\/\/[^\s<>"']+)?\/api\/v1\/videos\/[^\s<>"']+\/content(?:\?[^\s<>"']*)?/giu,
      "[media URL hidden]",
    )
  }
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => {
        const normalized = key.toLowerCase().replaceAll(/[_-]/gu, "")
        return normalized !== "authorization" &&
          normalized !== "unsignedurls" &&
          !normalized.endsWith("accesskey") &&
          !normalized.endsWith("apikey")
      })
      .map(([key, nested]) => [key, sanitizePippitWidgetValue(nested)]),
  )
}

function sanitizeContent(
  content: PippitMcpCallToolResult["content"],
): PippitMcpCallToolResult["content"] {
  return content.map((block) => {
    let text: string
    try {
      text = JSON.stringify(sanitizePippitWidgetValue(JSON.parse(block.text) as unknown))
    } catch {
      text = block.text
        .replace(/https?:\/\/[^\s<>"']+/giu, "[media URL hidden]")
        .replace(/\/api\/v1\/videos\/[^\s<>"']+\/content(?:\?[^\s<>"']*)?/giu, "[media URL hidden]")
    }
    return { text, type: "text" as const }
  })
}

export async function projectPippitWidgetResult(
  result: PippitMcpCallToolResult,
  previewUrl?: PippitWidgetPreviewUrlFactory,
): Promise<PippitMcpCallToolResult> {
  const rawJob = extractJob(result.structuredContent)
  const previews: PippitWidgetMediaPreview[] = []
  if (previewUrl !== undefined && result.isError !== true && rawJob?.status === "completed") {
    for (let index = 0; index < (rawJob.unsigned_urls?.length ?? 0); index += 1) {
      const prepared = await previewUrl(rawJob.id, index)
      previews.push(typeof prepared === "string"
        ? { index, kind: "video", url: prepared }
        : {
            bytes: prepared.bytes,
            filename: prepared.filename,
            index,
            kind: "video",
            local_path: prepared.localPath,
            ...(prepared.resourceUri === undefined
              ? { url: prepared.url }
              : { resource_uri: prepared.resourceUri }),
          })
    }
  }
  const sanitizedMetaValue = sanitizePippitWidgetValue(result._meta ?? {}) as Readonly<Record<string, unknown>>
  const sanitizedMeta = Object.fromEntries(
    Object.entries(sanitizedMetaValue).filter(([key]) => key !== "pippit/media"),
  )
  return {
    content: sanitizeContent(result.content),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(result.structuredContent === undefined
      ? {}
      : {
          structuredContent: sanitizePippitWidgetValue(result.structuredContent) as Readonly<Record<string, unknown>>,
        }),
    ...(
      Object.keys(sanitizedMeta).length === 0 && previews.length === 0
        ? {}
        : {
            _meta: {
              ...sanitizedMeta,
              ...(previews.length === 0 ? {} : { "pippit/media": previews }),
            },
          }
    ),
  }
}

export function withPippitWidgetTools(
  definitions: readonly PippitToolDefinition[],
): readonly PippitToolDefinition[] {
  return definitions.map((definition) => {
    if (!WIDGET_TOOL_NAMES.has(definition.name)) return definition
    const [invoking, invoked] = INVOCATION_STATUS[definition.name] ?? ["Working…", "Done"]
    const outputProperties = definition.outputSchema.properties
    const publicOutputSchema = outputProperties !== null && typeof outputProperties === "object" && !Array.isArray(outputProperties)
      ? {
          ...definition.outputSchema,
          properties: Object.fromEntries(
            Object.entries(outputProperties as Readonly<Record<string, unknown>>)
              .filter(([key]) => key !== "unsigned_urls"),
          ),
        }
      : definition.outputSchema
    return {
      ...definition,
      _meta: {
        ...definition._meta,
        ui: { resourceUri: PIPPIT_WIDGET_URI, visibility: ["model", "app"] },
        "ui/resourceUri": PIPPIT_WIDGET_URI,
        "openai/outputTemplate": PIPPIT_WIDGET_URI,
        "openai/toolInvocation/invoked": invoked,
        "openai/toolInvocation/invoking": invoking,
        "openai/widgetAccessible": true,
      },
      outputSchema: publicOutputSchema,
    }
  })
}

export function pippitWidgetResourceMetadata(
  options: PippitWidgetResourceMetadataOptions = {},
): Readonly<Record<string, unknown>> {
  const origins = options.origin === undefined ? [] : [options.origin]
  const resourceOrigins = [...origins, "blob:"]
  return {
    ui: {
      csp: { connectDomains: origins, resourceDomains: resourceOrigins },
      ...(options.domain === undefined ? {} : { domain: options.domain }),
      prefersBorder: true,
    },
    "openai/widgetCSP": { connect_domains: origins, resource_domains: resourceOrigins },
    "openai/widgetDescription":
      "Shows Pippit video job status, private local previews, and structured segment and region editing controls.",
    "openai/widgetPrefersBorder": true,
  }
}

export function pippitWidgetListResources(): Readonly<Record<string, unknown>> {
  return {
    resources: [
      {
        description: "Inline status, private preview, and structured segment and region editor for Pippit video jobs.",
        mimeType: PIPPIT_WIDGET_MIME_TYPE,
        name: "Pippit video job widget",
        uri: PIPPIT_WIDGET_URI,
      },
    ],
  }
}

export function pippitWidgetReadResource(
  uri: string,
  options: PippitWidgetResourceMetadataOptions = {},
): Readonly<Record<string, unknown>> | undefined {
  if (uri !== PIPPIT_WIDGET_URI && !LEGACY_PIPPIT_WIDGET_URIS.has(uri)) return undefined
  return {
    contents: [
      {
        _meta: pippitWidgetResourceMetadata(options),
        mimeType: PIPPIT_WIDGET_MIME_TYPE,
        text: PIPPIT_WIDGET_HTML,
        uri,
      },
    ],
  }
}
