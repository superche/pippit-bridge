import { describe, expect, it, vi } from "vitest"

import {
  PIPPIT_RUNTIME_TOOL_DEFINITIONS,
  type PippitMcpCallToolResult,
} from "../src/tools.ts"
import {
  PIPPIT_WIDGET_MIME_TYPE,
  pippitWidgetReadResource,
  projectPippitWidgetResult,
  withPippitWidgetTools,
} from "../src/widget-protocol.ts"
import {
  PIPPIT_WIDGET_HTML,
  PIPPIT_WIDGET_URI,
} from "../src/widget.ts"

function result(value: Readonly<Record<string, unknown>>): PippitMcpCallToolResult {
  return {
    content: [{ text: JSON.stringify(value), type: "text" }],
    structuredContent: value,
  }
}

describe("Pippit widget protocol", () => {
  it("binds the shared app resource to generate, get, and edit tools", () => {
    const definitions = withPippitWidgetTools(PIPPIT_RUNTIME_TOOL_DEFINITIONS)
    for (const name of ["pippit_generate_video", "pippit_get_video", "pippit_edit_video_segment"]) {
      const metadata = definitions.find((definition) => definition.name === name)?._meta
      expect((metadata?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe(PIPPIT_WIDGET_URI)
      expect(metadata?.["ui/resourceUri"]).toBe(PIPPIT_WIDGET_URI)
      expect(metadata?.["openai/outputTemplate"]).toBe(PIPPIT_WIDGET_URI)
      expect(metadata?.["openai/widgetAccessible"]).toBe(true)
      expect((definitions.find((definition) => definition.name === name)?.outputSchema.properties as Record<string, unknown>))
        .not.toHaveProperty("unsigned_urls")
    }
    expect(definitions.find((definition) => definition.name === "pippit_list_video_models")?._meta).toBeUndefined()
    expect(definitions.find((definition) => definition.name === "pippit_download_video")?._meta).toBeUndefined()
  })

  it("projects completed outputs into widget-only signed media and removes facade URLs", async () => {
    const previewUrl = vi.fn(async (_jobId: string, index: number) => ({
      bytes: 100 + index,
      filename: `pippit-video-${index}.mp4`,
      localPath: `/Users/test/Movies/Pippit/pippit-video-${index}.mp4`,
      url: `http://127.0.0.1:4123/media?token=${index}`,
    }))
    const projected = await projectPippitWidgetResult(result({
      authorization: "Bearer secret",
      id: "job_123",
      polling_url: "/api/v1/videos/job_123",
      status: "completed",
      unsigned_urls: [
        "/api/v1/videos/job_123/content?index=0",
        "/api/v1/videos/job_123/content?index=1",
      ],
    }), previewUrl)

    expect(previewUrl).toHaveBeenCalledTimes(2)
    expect(projected.structuredContent).toEqual({
      id: "job_123",
      polling_url: "/api/v1/videos/job_123",
      status: "completed",
    })
    expect(projected.content[0]?.text).not.toContain("unsigned_urls")
    expect(projected.content[0]?.text).not.toContain("Bearer secret")
    expect(projected._meta?.["pippit/media"]).toEqual([
      {
        bytes: 100,
        filename: "pippit-video-0.mp4",
        index: 0,
        kind: "video",
        local_path: "/Users/test/Movies/Pippit/pippit-video-0.mp4",
        url: "http://127.0.0.1:4123/media?token=0",
      },
      {
        bytes: 101,
        filename: "pippit-video-1.mp4",
        index: 1,
        kind: "video",
        local_path: "/Users/test/Movies/Pippit/pippit-video-1.mp4",
        url: "http://127.0.0.1:4123/media?token=1",
      },
    ])
  })

  it("does not create previews for pending or failed tool results", async () => {
    const previewUrl = vi.fn(async () => "http://127.0.0.1/media")
    const pending = await projectPippitWidgetResult(result({
      id: "job_pending",
      status: "in_progress",
      unsigned_urls: [],
    }), previewUrl)
    const failed = await projectPippitWidgetResult({
      ...result({ id: "job_failed", status: "completed", unsigned_urls: ["private"] }),
      _meta: { "pippit/media": [{ index: 0, kind: "video", url: "http://stale.example/media" }] },
      isError: true,
    }, previewUrl)
    expect(previewUrl).not.toHaveBeenCalled()
    expect(pending._meta).toBeUndefined()
    expect(failed._meta).toBeUndefined()
  })

  it("returns a standard MCP App resource with media-only loopback CSP", () => {
    const resource = pippitWidgetReadResource(PIPPIT_WIDGET_URI, { origin: "http://127.0.0.1:4321" })
    expect(resource).toMatchObject({
      contents: [{ mimeType: PIPPIT_WIDGET_MIME_TYPE, text: PIPPIT_WIDGET_HTML, uri: PIPPIT_WIDGET_URI }],
    })
    if (resource === undefined) throw new Error("Missing widget resource in test.")
    const metadata = (resource.contents as Array<{ _meta?: Record<string, unknown> }>)[0]?._meta
    expect(metadata?.ui).toMatchObject({
      csp: {
        connectDomains: ["http://127.0.0.1:4321"],
        resourceDomains: ["http://127.0.0.1:4321"],
      },
    })
    expect((metadata?.ui as { domain?: string } | undefined)?.domain).toBeUndefined()
    expect(pippitWidgetReadResource("ui://widget/pippit-video-job-v5.html", { origin: "http://127.0.0.1:4321" }))
      .toMatchObject({ contents: [{ text: PIPPIT_WIDGET_HTML, uri: "ui://widget/pippit-video-job-v5.html" }] })
    expect(pippitWidgetReadResource("ui://widget/pippit-video-job-v6.html", { origin: "http://127.0.0.1:4321" }))
      .toMatchObject({ contents: [{ text: PIPPIT_WIDGET_HTML, uri: "ui://widget/pippit-video-job-v6.html" }] })
    expect(pippitWidgetReadResource("ui://widget/unknown.html")).toBeUndefined()
  })

  it("includes native cross-origin playback, automatic polling, lease renewal, and display-mode handling", () => {
    expect(PIPPIT_WIDGET_HTML).toContain('<video id="video" controls')
    expect(PIPPIT_WIDGET_HTML).toContain('crossorigin="anonymous"')
    expect(PIPPIT_WIDGET_HTML).toContain("function previewExpirationMs(media)")
    expect(PIPPIT_WIDGET_HTML).toContain("expiresAtMs <= Date.now() + 5000")
    expect(PIPPIT_WIDGET_HTML).toContain("schedulePreviewRenewal(expiresAtMs)")
    expect(PIPPIT_WIDGET_HTML).toContain("Retrying the local video…")
    expect(PIPPIT_WIDGET_HTML).toContain("Saved locally: ")
    expect(PIPPIT_WIDGET_HTML).toContain("if (changedSource) previewRetryCount = 0")
    expect(PIPPIT_WIDGET_HTML).toContain("void refresh(true)")
    expect(PIPPIT_WIDGET_HTML).toContain("schedulePoll(pollDelayMs)")
    expect(PIPPIT_WIDGET_HTML).toContain('typeof result.mode === "string"')
    expect(PIPPIT_WIDGET_HTML).not.toContain("result.displayMode")
    expect(PIPPIT_WIDGET_HTML).not.toContain("file://")
  })
})
