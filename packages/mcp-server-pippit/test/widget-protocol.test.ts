import { describe, expect, it, vi } from "vitest"

import {
  PIPPIT_RUNTIME_TOOL_DEFINITIONS,
  type PippitMcpCallToolResult,
} from "../src/tools.ts"
import {
  PIPPIT_IMAGE_WIDGET_HTML,
  PIPPIT_IMAGE_WIDGET_URI,
} from "../src/image-widget.ts"
import {
  PIPPIT_WIDGET_MIME_TYPE,
  pippitWidgetListResources,
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
    const imageMetadata = definitions.find((definition) => definition.name === "pippit_generate_image")?._meta
    expect((imageMetadata?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe(PIPPIT_IMAGE_WIDGET_URI)
    expect(imageMetadata?.["ui/resourceUri"]).toBe(PIPPIT_IMAGE_WIDGET_URI)
    expect(imageMetadata?.["openai/outputTemplate"]).toBe(PIPPIT_IMAGE_WIDGET_URI)
    expect(imageMetadata?.["openai/widgetAccessible"]).toBe(true)
    const imageOutputSchema = definitions.find(
      (definition) => definition.name === "pippit_generate_image",
    )?.outputSchema
    expect((imageOutputSchema?.anyOf as Readonly<Record<string, unknown>>[] | undefined)?.[0])
      .toMatchObject({ required: ["image_job_id", "model", "status"] })
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

  it("renders the single Annotation editor for light and dark hosts", () => {
    expect(PIPPIT_WIDGET_HTML).toContain(':root[data-theme="dark"] .loading-status')
    expect(PIPPIT_WIDGET_HTML).toContain(':root[data-theme="dark"] .annotation-panel')
    expect(PIPPIT_WIDGET_HTML).toContain(':root[data-theme="dark"] textarea')
    expect(PIPPIT_WIDGET_HTML).toContain(':root[data-widget-view="editor"] body { padding: 0; }')
    expect(PIPPIT_WIDGET_HTML).toContain(':root[data-widget-view="editor"] .editor { gap: 0; padding: 0; }')
    expect(PIPPIT_WIDGET_HTML).toContain('.viewer-card { position: relative; border: 0; border-radius: 0; }')
    expect(PIPPIT_WIDGET_HTML).toContain('border: 0;\n      border-radius: 0;\n      background: #f7f7f8;')
    expect(PIPPIT_WIDGET_HTML).toContain('<details id="annotation-panel" class="annotation-panel" open>')
    expect(PIPPIT_WIDGET_HTML).toContain('Applies to <strong><output id="selection-label">00:00.0–00:00.0</output></strong>')
    expect(PIPPIT_WIDGET_HTML).toContain('<output id="annotation-summary" class="annotation-summary">00:00.0–00:00.0 · Full frame</output>')
    expect(PIPPIT_WIDGET_HTML).toContain('id="instruction" maxlength="2000"')
    expect(PIPPIT_WIDGET_HTML).toContain('id="area-status" class="area-status">Full frame</span>')
    expect(PIPPIT_WIDGET_HTML).toContain('region: { x: 0, y: 0, width: 1, height: 1 }')
    expect(PIPPIT_WIDGET_HTML).not.toContain('No frame area')
    expect(PIPPIT_WIDGET_HTML).not.toContain('>Trim<')
    expect(PIPPIT_WIDGET_HTML).not.toContain('Add annotation')
    expect(PIPPIT_WIDGET_HTML).not.toContain('id="prompt"')
    expect(PIPPIT_WIDGET_HTML).toContain('.video-stage { border-radius: 0; }')
  })

  it("projects Codex images to persistent local resource identities without exposing local paths", async () => {
    const encodedImage = "a".repeat(1_900_000)
    const prepareImage = vi.fn(async () => ({
      bytes: 5,
      filename: `pippit-image-${"a".repeat(64)}.jpg`,
      localPath: "/Users/test/Movies/Pippit/private-image.jpg",
      mimeType: "image/jpeg",
      resourceUri: `pippit-image://artifact/${"a".repeat(64)}.jpg`,
    }))
    const projected = await projectPippitWidgetResult({
      content: [
        { text: "Generated 1 image.", type: "text" },
        { data: encodedImage, mimeType: "image/jpeg", type: "image" },
      ],
      structuredContent: { created: 1_780_000_000, model: "pippit/seedream-5.0" },
    }, undefined, prepareImage)

    expect(prepareImage).toHaveBeenCalledWith(encodedImage, "image/jpeg")
    expect(projected.content).toEqual([{ text: "Generated 1 image.", type: "text" }])
    expect(projected._meta?.["pippit/images"]).toEqual([
      {
        bytes: 5,
        filename: `pippit-image-${"a".repeat(64)}.jpg`,
        index: 0,
        kind: "image",
        mime_type: "image/jpeg",
        resource_uri: `pippit-image://artifact/${"a".repeat(64)}.jpg`,
      },
    ])
    expect(projected.structuredContent).toEqual({
      created: 1_780_000_000,
      images: [{
        bytes: 5,
        filename: `pippit-image-${"a".repeat(64)}.jpg`,
        media_type: "image/jpeg",
        resource_uri: `pippit-image://artifact/${"a".repeat(64)}.jpg`,
      }],
      model: "pippit/seedream-5.0",
    })
    expect(JSON.stringify(projected._meta)).not.toContain("localPath")
    expect(JSON.stringify(projected._meta)).not.toContain("/Users/test")
    expect(JSON.stringify(projected.structuredContent)).not.toContain("localPath")
    expect(JSON.stringify(projected.structuredContent)).not.toContain("/Users/test")
    expect(JSON.stringify(projected)).not.toContain(encodedImage)
    expect(JSON.stringify(projected).length).toBeLessThan(2_000)
  })

  it("projects generated images into widget-only downloadable attachments", async () => {
    const projected = await projectPippitWidgetResult({
      content: [
        { text: "Generated 1 image.", type: "text" },
        { data: "aW1hZ2U=", mimeType: "image/jpeg", type: "image" },
      ],
      structuredContent: {
        created: 1_780_000_000,
        images: [{ media_type: "image/jpeg" }],
        model: "pippit/seedream-5.0-pro",
      },
    })

    expect(projected.content).toContainEqual({ data: "aW1hZ2U=", mimeType: "image/jpeg", type: "image" })
    expect(projected._meta?.["pippit/images"]).toEqual([
      {
        data: "aW1hZ2U=",
        filename: "pippit-image-1780000000-1.jpg",
        index: 0,
        kind: "image",
        mime_type: "image/jpeg",
      },
    ])
    expect(projected.structuredContent).toEqual({
      created: 1_780_000_000,
      images: [{ media_type: "image/jpeg" }],
      model: "pippit/seedream-5.0-pro",
    })
  })

  it("lets the image widget recover structured local previews and uses the Infinity Run loader", () => {
    expect(PIPPIT_IMAGE_WIDGET_HTML).toContain("structured.images")
    expect(PIPPIT_IMAGE_WIDGET_HTML).toContain("current.mcp_tool_result")
    expect(PIPPIT_IMAGE_WIDGET_HTML).toContain("current.call_tool_result")
    expect(PIPPIT_IMAGE_WIDGET_HTML).toContain("event.detail.globals")
    expect(PIPPIT_IMAGE_WIDGET_HTML).toContain("if (output === undefined && !hasEnvelope) return undefined")
    expect(PIPPIT_IMAGE_WIDGET_HTML).toContain("infinityPoint")
    expect(PIPPIT_IMAGE_WIDGET_HTML).toContain("repeat(5, 8px)")
    expect(PIPPIT_IMAGE_WIDGET_HTML).not.toContain("0 images")
  })

  it("renders a local image from the Codex tool response metadata envelope", async () => {
    type Listener = (event: Readonly<Record<string, unknown>>) => void
    class FakeElement {
      readonly children: FakeElement[] = []
      readonly listeners = new Map<string, Listener>()
      readonly style: Record<string, string> = {}
      className = ""
      download = ""
      hidden = false
      href = ""
      textContent = ""

      addEventListener(type: string, listener: Listener): void {
        this.listeners.set(type, listener)
      }

      append(...children: FakeElement[]): void {
        this.children.push(...children)
      }

      appendChild(child: FakeElement): FakeElement {
        this.children.push(child)
        return child
      }

      replaceChildren(): void {
        this.children.length = 0
      }

      set src(_value: string) {
        queueMicrotask(() => this.listeners.get("load")?.({}))
      }
    }

    const elements = new Map([
      "loading-view",
      "loading-status",
      "infinity-loader",
      "result-header",
      "summary",
      "gallery",
      "empty",
    ].map((id) => [id, new FakeElement()]))
    const listeners = new Map<string, Listener[]>()
    const callTool = vi.fn(async () => ({
      structuredContent: {
        blob: "aW1hZ2U=",
        bytes: 5,
        filename: "pippit-image-test.jpg",
        mime_type: "image/jpeg",
        resource_uri: `pippit-image://artifact/${"a".repeat(64)}.jpg`,
      },
    }))
    const parent = {
      postMessage(message: Readonly<Record<string, unknown>>): void {
        if (message.method !== "ui/initialize") return
        queueMicrotask(() => dispatch("message", {
          data: {
            id: message.id,
            jsonrpc: "2.0",
            result: { hostCapabilities: { serverResources: false, serverTools: false } },
          },
          source: parent,
        }))
      },
    }
    const windowValue = {
      addEventListener(type: string, listener: Listener): void {
        listeners.set(type, [...(listeners.get(type) ?? []), listener])
      },
      atob(value: string): string {
        return Buffer.from(value, "base64").toString("binary")
      },
      clearInterval(): void {},
      clearTimeout(): void {},
      matchMedia(): { matches: boolean } {
        return { matches: true }
      },
      openai: { callTool },
      parent,
      setInterval(): number {
        return 1
      },
      setTimeout(): number {
        return 1
      },
    }
    function dispatch(type: string, event: Readonly<Record<string, unknown>>): void {
      for (const listener of listeners.get(type) ?? []) listener(event)
    }
    const documentValue = {
      createElement(): FakeElement {
        return new FakeElement()
      },
      documentElement: { scrollHeight: 320, scrollWidth: 640 },
      getElementById(id: string): FakeElement {
        const element = elements.get(id)
        if (element === undefined) throw new Error(`Missing fake element ${id}`)
        return element
      },
    }
    const script = /<script>([\s\S]*)<\/script>/u.exec(PIPPIT_IMAGE_WIDGET_HTML)?.[1]
    if (script === undefined) throw new Error("Missing image widget script.")
    const execute = new Function("window", "document", "URL", "Blob", "Uint8Array", script)
    execute(
      windowValue,
      documentValue,
      { createObjectURL: () => "blob:pippit-image", revokeObjectURL: () => undefined },
      Blob,
      Uint8Array,
    )
    const image = {
      bytes: 5,
      filename: "pippit-image-test.jpg",
      kind: "image",
      mime_type: "image/jpeg",
      resource_uri: `pippit-image://artifact/${"a".repeat(64)}.jpg`,
    }
    dispatch("openai:set_globals", {
      detail: {
        globals: {
          toolResponseMetadata: {
            mcp_tool_result: {
              _meta: { "pippit/images": [image] },
              content: [],
              structuredContent: { created: 1, images: [image], model: "pippit/seedream-5.0", usage: {} },
            },
            status: "completed",
          },
        },
      },
    })
    await vi.waitFor(() => {
      expect(elements.get("summary")?.textContent).toBe("1 image")
    })
    expect(callTool).toHaveBeenCalledWith("pippit_read_image", { resource_uri: image.resource_uri })
    expect(elements.get("gallery")?.hidden).toBe(false)
    expect(elements.get("empty")?.hidden).toBe(true)
  })

  it("projects completed outputs into widget-only signed media and removes facade URLs", async () => {
    const previewUrl = vi.fn(async (_jobId: string, index: number) => ({
      bytes: 100 + index,
      filename: `pippit-video-${index}.mp4`,
      localPath: `/Users/test/Movies/Pippit/pippit-video-${index}.mp4`,
      resourceUri: `pippit-video://artifact/${String(index).padStart(64, "0")}`,
    }))
    const projected = await projectPippitWidgetResult(result({
      authorization: "Bearer secret",
      id: "job_123",
      local_path: "/Users/test/private-source.mp4",
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
    expect(projected.content[0]?.type).toBe("text")
    expect(projected.content[0]?.type === "text" ? projected.content[0].text : "").not.toContain("unsigned_urls")
    expect(projected.content[0]?.type === "text" ? projected.content[0].text : "").not.toContain("Bearer secret")
    expect(projected._meta?.["pippit/media"]).toEqual([
      {
        bytes: 100,
        filename: "pippit-video-0.mp4",
        index: 0,
        kind: "video",
        resource_uri: `pippit-video://artifact/${"0".repeat(64)}`,
      },
      {
        bytes: 101,
        filename: "pippit-video-1.mp4",
        index: 1,
        kind: "video",
        resource_uri: `pippit-video://artifact/${"0".repeat(63)}1`,
      },
    ])
    expect(JSON.stringify(projected)).not.toContain("local_path")
    expect(JSON.stringify(projected)).not.toContain("/Users/test")
  })

  it("does not create previews for pending or failed tool results", async () => {
    const previewUrl = vi.fn(async () => "https://media.example.test/video")
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

  it("returns a standard MCP App resource with blob media CSP and no loopback dependency", () => {
    expect(pippitWidgetListResources()).toMatchObject({
      resources: [
        { mimeType: PIPPIT_WIDGET_MIME_TYPE, uri: PIPPIT_IMAGE_WIDGET_URI },
        { mimeType: PIPPIT_WIDGET_MIME_TYPE, uri: PIPPIT_WIDGET_URI },
      ],
    })
    const imageResource = pippitWidgetReadResource(PIPPIT_IMAGE_WIDGET_URI)
    expect(imageResource).toMatchObject({
      contents: [{ mimeType: PIPPIT_WIDGET_MIME_TYPE, text: PIPPIT_IMAGE_WIDGET_HTML, uri: PIPPIT_IMAGE_WIDGET_URI }],
    })
    expect(pippitWidgetReadResource("ui://widget/pippit-image-result-v1.html")).toMatchObject({
      contents: [{ text: PIPPIT_IMAGE_WIDGET_HTML, uri: "ui://widget/pippit-image-result-v1.html" }],
    })
    expect(pippitWidgetReadResource("ui://widget/pippit-image-result-v2.html")).toMatchObject({
      contents: [{ text: PIPPIT_IMAGE_WIDGET_HTML, uri: "ui://widget/pippit-image-result-v2.html" }],
    })
    expect(pippitWidgetReadResource("ui://widget/pippit-image-result-v3.html")).toMatchObject({
      contents: [{ text: PIPPIT_IMAGE_WIDGET_HTML, uri: "ui://widget/pippit-image-result-v3.html" }],
    })
    expect(PIPPIT_IMAGE_WIDGET_HTML).toContain("Show in Finder")
    expect(PIPPIT_IMAGE_WIDGET_HTML).toContain('callTool("pippit_get_image"')
    expect(PIPPIT_IMAGE_WIDGET_HTML).toContain('callTool("pippit_reveal_image"')
    expect(PIPPIT_IMAGE_WIDGET_HTML).toContain("Download original")
    expect(PIPPIT_IMAGE_WIDGET_HTML).toContain("toolResponseMetadata")
    expect(PIPPIT_IMAGE_WIDGET_HTML).toContain('request("resources/read"')
    expect(PIPPIT_IMAGE_WIDGET_HTML).toContain('"pippit_read_image"')
    expect(PIPPIT_IMAGE_WIDGET_HTML).not.toContain("http://127.0.0.1")
    expect(PIPPIT_IMAGE_WIDGET_HTML).not.toContain("file://")
    const resource = pippitWidgetReadResource(PIPPIT_WIDGET_URI)
    expect(resource).toMatchObject({
      contents: [{ mimeType: PIPPIT_WIDGET_MIME_TYPE, text: PIPPIT_WIDGET_HTML, uri: PIPPIT_WIDGET_URI }],
    })
    if (resource === undefined) throw new Error("Missing widget resource in test.")
    const metadata = (resource.contents as Array<{ _meta?: Record<string, unknown> }>)[0]?._meta
    expect(metadata?.ui).toMatchObject({
      csp: {
        connectDomains: [],
        resourceDomains: ["blob:"],
      },
    })
    expect((metadata?.ui as { domain?: string } | undefined)?.domain).toBeUndefined()
    expect(pippitWidgetReadResource("ui://widget/pippit-video-job-v5.html"))
      .toMatchObject({ contents: [{ text: PIPPIT_WIDGET_HTML, uri: "ui://widget/pippit-video-job-v5.html" }] })
    expect(pippitWidgetReadResource("ui://widget/pippit-video-job-v6.html"))
      .toMatchObject({ contents: [{ text: PIPPIT_WIDGET_HTML, uri: "ui://widget/pippit-video-job-v6.html" }] })
    expect(pippitWidgetReadResource("ui://widget/pippit-video-job-v7.html"))
      .toMatchObject({ contents: [{ text: PIPPIT_WIDGET_HTML, uri: "ui://widget/pippit-video-job-v7.html" }] })
    expect(pippitWidgetReadResource("ui://widget/pippit-video-job-v8.html"))
      .toMatchObject({ contents: [{ text: PIPPIT_WIDGET_HTML, uri: "ui://widget/pippit-video-job-v8.html" }] })
    expect(pippitWidgetReadResource("ui://widget/pippit-video-job-v9.html"))
      .toMatchObject({ contents: [{ text: PIPPIT_WIDGET_HTML, uri: "ui://widget/pippit-video-job-v9.html" }] })
    expect(pippitWidgetReadResource("ui://widget/pippit-video-job-v10.html"))
      .toMatchObject({ contents: [{ text: PIPPIT_WIDGET_HTML, uri: "ui://widget/pippit-video-job-v10.html" }] })
    expect(pippitWidgetReadResource("ui://widget/pippit-video-job-v11.html"))
      .toMatchObject({ contents: [{ text: PIPPIT_WIDGET_HTML, uri: "ui://widget/pippit-video-job-v11.html" }] })
    expect(pippitWidgetReadResource("ui://widget/pippit-video-job-v12.html"))
      .toMatchObject({ contents: [{ text: PIPPIT_WIDGET_HTML, uri: "ui://widget/pippit-video-job-v12.html" }] })
    expect(pippitWidgetReadResource("ui://widget/pippit-video-job-v13.html"))
      .toMatchObject({ contents: [{ text: PIPPIT_WIDGET_HTML, uri: "ui://widget/pippit-video-job-v13.html" }] })
    expect(pippitWidgetReadResource("ui://widget/unknown.html")).toBeUndefined()
  })

})
