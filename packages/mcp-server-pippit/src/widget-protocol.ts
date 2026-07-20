import type {
  PippitMcpCallToolResult,
  PippitToolDefinition,
} from "./tools.ts"
import {
  PIPPIT_WIDGET_HTML,
  PIPPIT_WIDGET_URI,
} from "./widget.ts"
import {
  PIPPIT_IMAGE_WIDGET_HTML,
  PIPPIT_IMAGE_WIDGET_URI,
} from "./image-widget.ts"

export const PIPPIT_WIDGET_MIME_TYPE = "text/html;profile=mcp-app"

const WIDGET_TOOL_NAMES = new Set([
  "pippit_generate_video",
  "pippit_get_video",
  "pippit_edit_video_segment",
])

const IMAGE_WIDGET_TOOL_NAME = "pippit_generate_image"

const LEGACY_PIPPIT_WIDGET_URIS = new Set([
  "ui://widget/pippit-video-job-v5.html",
  "ui://widget/pippit-video-job-v6.html",
  "ui://widget/pippit-video-job-v7.html",
  "ui://widget/pippit-video-job-v8.html",
  "ui://widget/pippit-video-job-v9.html",
  "ui://widget/pippit-video-job-v10.html",
  "ui://widget/pippit-video-job-v11.html",
  "ui://widget/pippit-video-job-v12.html",
])

const INVOCATION_STATUS: Readonly<Record<string, readonly [string, string]>> = {
  pippit_edit_video_segment: ["Preparing reference video…", "New Pippit generation submitted"],
  pippit_generate_image: ["Generating Pippit images…", "Pippit images generated"],
  pippit_generate_video: ["Starting Pippit generation…", "Pippit generation started"],
  pippit_get_video: ["Refreshing Pippit video…", "Pippit video refreshed"],
}

export interface PippitWidgetJobLike {
  readonly id: string
  readonly status: string
  readonly unsigned_urls?: readonly string[]
}

export interface PippitWidgetMediaPreview {
  readonly bytes?: number
  readonly filename?: string
  readonly index: number
  readonly kind: "video"
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

export function extractPippitWidgetJob(value: unknown, depth = 0): PippitWidgetJobLike | undefined {
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
    const job = extractPippitWidgetJob(nested, depth + 1)
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
          normalized !== "localpath" &&
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
    if (block.type === "image") return block
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

function imageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg"
  if (mimeType === "image/webp") return "webp"
  return "png"
}

function widgetImages(result: PippitMcpCallToolResult): readonly Readonly<Record<string, unknown>>[] {
  if (result.isError === true) return []
  const created = typeof result.structuredContent?.created === "number" &&
    Number.isSafeInteger(result.structuredContent.created)
    ? result.structuredContent.created
    : 0
  return result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: "image" }> => block.type === "image")
    .map((block, index) => ({
      data: block.data,
      filename: `pippit-image-${created}-${index + 1}.${imageExtension(block.mimeType)}`,
      index,
      kind: "image",
      mime_type: block.mimeType,
    }))
}

export async function projectPippitWidgetResult(
  result: PippitMcpCallToolResult,
  previewUrl?: PippitWidgetPreviewUrlFactory,
): Promise<PippitMcpCallToolResult> {
  const rawJob = extractPippitWidgetJob(result.structuredContent)
  const previews: PippitWidgetMediaPreview[] = []
  const images = widgetImages(result)
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
      Object.keys(sanitizedMeta).length === 0 && previews.length === 0 && images.length === 0
        ? {}
        : {
            _meta: {
              ...sanitizedMeta,
              ...(images.length === 0 ? {} : { "pippit/images": images }),
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
    if (definition.name === IMAGE_WIDGET_TOOL_NAME) {
      const [invoking, invoked] = INVOCATION_STATUS[definition.name] ?? ["Working…", "Done"]
      return {
        ...definition,
        _meta: {
          ...definition._meta,
          ui: { resourceUri: PIPPIT_IMAGE_WIDGET_URI, visibility: ["model", "app"] },
          "ui/resourceUri": PIPPIT_IMAGE_WIDGET_URI,
          "openai/outputTemplate": PIPPIT_IMAGE_WIDGET_URI,
          "openai/toolInvocation/invoked": invoked,
          "openai/toolInvocation/invoking": invoking,
        },
      }
    }
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
      "Shows Pippit video job status, private previews, and reference-guided regeneration controls.",
    "openai/widgetPrefersBorder": true,
  }
}

export function pippitImageWidgetResourceMetadata(
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
    "openai/widgetDescription": "Shows generated Pippit images with an original-file download action.",
    "openai/widgetPrefersBorder": true,
  }
}

export function pippitWidgetListResources(): Readonly<Record<string, unknown>> {
  return {
    resources: [
      {
        description: "Inline preview and original-file download for generated Pippit images.",
        mimeType: PIPPIT_WIDGET_MIME_TYPE,
        name: "Pippit image result widget",
        uri: PIPPIT_IMAGE_WIDGET_URI,
      },
      {
        description: "Inline status, private preview, and reference-guided regeneration controls for Pippit video jobs.",
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
  if (uri === PIPPIT_IMAGE_WIDGET_URI) {
    return {
      contents: [
        {
          _meta: pippitImageWidgetResourceMetadata(options),
          mimeType: PIPPIT_WIDGET_MIME_TYPE,
          text: PIPPIT_IMAGE_WIDGET_HTML,
          uri,
        },
      ],
    }
  }
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
