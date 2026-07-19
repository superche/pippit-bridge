import { chmod, lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createPippitWidgetMediaServer,
  type PippitWidgetMediaServer,
} from "../src/widget-media.ts"
import { PIPPIT_WIDGET_URI } from "../src/widget.ts"

const cleanupRoots = new Set<string>()

async function artifactRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pippit-widget-media-"))
  cleanupRoots.add(root)
  return root
}

async function artifactFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(root, entry.name))
}

async function readResourceBytes(
  media: Pick<PippitWidgetMediaServer, "readResource">,
  resourceUri: string,
  totalBytes: number,
  chunkBytes = 3,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
    const expectedBytes = Math.min(chunkBytes, totalBytes - offset)
    const uri = new URL(resourceUri)
    uri.searchParams.set("length", String(expectedBytes))
    uri.searchParams.set("offset", String(offset))
    const result = await media.readResource(uri.toString()) as {
      contents?: Array<{
        _meta?: { "pippit/chunk"?: Record<string, unknown> }
        blob?: string
        mimeType?: string
        uri?: string
      }>
    } | undefined
    const content = result?.contents?.[0]
    expect(content).toMatchObject({
      _meta: {
        "pippit/chunk": {
          bytes: expectedBytes,
          complete: offset + expectedBytes === totalBytes,
          offset,
          total_bytes: totalBytes,
        },
      },
      mimeType: "video/mp4",
      uri: uri.toString(),
    })
    if (content?.blob === undefined) throw new Error("Missing media resource blob.")
    chunks.push(Buffer.from(content.blob, "base64"))
  }
  return new Uint8Array(Buffer.concat(chunks))
}

afterEach(async () => {
  await Promise.all([...cleanupRoots].map(async root => rm(root, { force: true, recursive: true })))
  cleanupRoots.clear()
})

describe("Pippit widget media server", () => {
  it("downloads a complete artifact before issuing a stable local resource, then reads private chunks", async () => {
    const root = await artifactRoot()
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])
    const downloadVideo = vi.fn(async (_jobId: string, _options?: { readonly index?: number; readonly signal?: AbortSignal }) => new Response(bytes, {
      headers: { "content-length": String(bytes.byteLength), "content-type": "application/octet-stream" },
    }))
    const media = createPippitWidgetMediaServer({ artifactRoot: root, backend: { downloadVideo } })
    try {
      const preview = await media.preparePreview("job_123", 2)
      expect(preview.resourceUri).toMatch(/^pippit-video:\/\/artifact\/[a-f0-9]{64}$/u)
      expect(preview.localPath).toBe(join(root, preview.filename))
      expect(preview.bytes).toBe(bytes.byteLength)
      expect(downloadVideo).toHaveBeenCalledOnce()
      expect(downloadVideo).toHaveBeenCalledWith("job_123", expect.objectContaining({ index: 2, signal: expect.any(AbortSignal) }))
      expect(downloadVideo.mock.calls[0]?.[1]).not.toHaveProperty("range")

      const files = await artifactFiles(root)
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/pippit-video-[a-f0-9]{64}\.mp4$/u)
      expect(new Uint8Array(await readFile(files[0]!))).toEqual(bytes)

      const resource = await media.readResource(PIPPIT_WIDGET_URI)
      if (resource === undefined) throw new Error("Missing widget resource in test.")
      const metadata = (resource.contents as Array<{ _meta?: Record<string, unknown> }>)[0]?._meta
      expect((metadata?.ui as { csp?: { resourceDomains?: string[] } } | undefined)?.csp?.resourceDomains).toEqual([
        "blob:",
      ])
      await expect(media.listResourceTemplates?.()).resolves.toMatchObject({
        resourceTemplates: [{
          mimeType: "video/mp4",
          uriTemplate: "pippit-video://artifact/{artifact_id}{?length,offset}",
        }],
      })
      expect(await readResourceBytes(media, preview.resourceUri, bytes.byteLength)).toEqual(bytes)
      expect(downloadVideo).toHaveBeenCalledOnce()
    } finally {
      await media.close()
    }
  })

  it("deduplicates concurrent materialization and reuses the persistent artifact after restart", async () => {
    const root = await artifactRoot()
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6])
    const downloadVideo = vi.fn(async () => {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
      return new Response(bytes, { headers: { "content-type": "video/mp4" } })
    })
    const first = createPippitWidgetMediaServer({ artifactRoot: root, backend: { downloadVideo } })
    const previews = await Promise.all(Array.from({ length: 20 }, async () => first.preparePreview("job_shared", 0)))
    expect(new Set(previews.map(preview => preview.resourceUri)).size).toBe(1)
    expect(downloadVideo).toHaveBeenCalledOnce()
    await first.close()

    const shouldNotDownload = vi.fn(async () => { throw new Error("unexpected download") })
    const restarted = createPippitWidgetMediaServer({ artifactRoot: root, backend: { downloadVideo: shouldNotDownload } })
    try {
      expect(await readResourceBytes(restarted, previews[0]!.resourceUri, bytes.byteLength)).toEqual(bytes)
      expect(shouldNotDownload).not.toHaveBeenCalled()
      expect(await artifactFiles(root)).toHaveLength(1)
    } finally {
      await restarted.close()
    }
  })

  it("waits for the full local download before resolving the preview resource", async () => {
    const root = await artifactRoot()
    let finish: (() => void) | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        finish = () => {
          controller.enqueue(new Uint8Array([3, 4]))
          controller.close()
        }
      },
    })
    const media = createPippitWidgetMediaServer({
      artifactRoot: root,
      backend: { async downloadVideo() { return new Response(body, { headers: { "content-type": "video/mp4" } }) } },
    })
    try {
      let resolved = false
      const preview = media.preparePreview("job_stream", 0).then((prepared) => {
        resolved = true
        return prepared
      })
      await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
      expect(resolved).toBe(false)
      finish?.()
      expect(await readResourceBytes(media, (await preview).resourceUri, 4)).toEqual(new Uint8Array([1, 2, 3, 4]))
    } finally {
      await media.close()
    }
  })

  it("reuses one stable resource identity and does not download the same local file twice", async () => {
    const root = await artifactRoot()
    const downloadVideo = vi.fn(async () => new Response("video", { headers: { "content-type": "video/mp4" } }))
    const media = createPippitWidgetMediaServer({
      artifactRoot: root,
      backend: { downloadVideo },
    })
    try {
      const first = await media.preparePreview("job_123", 0)
      const reused = await media.preparePreview("job_123", 0)
      expect(reused.resourceUri).toBe(first.resourceUri)
      expect(reused.localPath).toBe(first.localPath)
      expect(downloadVideo).toHaveBeenCalledOnce()
    } finally {
      await media.close()
    }
  })

  it("fails closed for non-video, oversized, and truncated upstream responses", async () => {
    const cases = [
      new Response("not video", { headers: { "content-type": "text/html" } }),
      new Response(new Uint8Array(5), { headers: { "content-length": "5", "content-type": "video/mp4" } }),
      new Response(new Uint8Array(2), { headers: { "content-length": "3", "content-type": "video/mp4" } }),
    ]
    for (const [index, upstream] of cases.entries()) {
      const root = await artifactRoot()
      const media = createPippitWidgetMediaServer({
        artifactRoot: root,
        backend: { async downloadVideo() { return upstream } },
        maxArtifactBytes: index === 1 ? 4 : 1024,
      })
      try {
        await expect(media.preparePreview(`job_bad_${index}`, 0)).rejects.toThrow()
        expect(await artifactFiles(root)).toEqual([])
      } finally {
        await media.close()
      }
    }
  })

  it("rejects malformed, oversized, and out-of-bounds local resource reads", async () => {
    const root = await artifactRoot()
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6])
    const media = createPippitWidgetMediaServer({
      artifactRoot: root,
      backend: { async downloadVideo() { return new Response(bytes, { headers: { "content-type": "video/mp4" } }) } },
      maxResourceChunkBytes: 4,
    })
    try {
      const preview = await media.preparePreview("job_resource_validation", 0)
      const malformed = [
        "pippit-video://artifact/not-a-hash?length=1&offset=0",
        `${preview.resourceUri}?length=1&length=1&offset=0`,
        `${preview.resourceUri}?length=1`,
        `${preview.resourceUri}?length=0&offset=0`,
        `${preview.resourceUri}?length=5&offset=0`,
        `${preview.resourceUri}?length=1&offset=-1`,
        `${preview.resourceUri}?length=1&offset=${bytes.byteLength}`,
        preview.resourceUri.replace("pippit-video:", "file:"),
      ]
      for (const uri of malformed) expect(await media.readResource(uri)).toBeUndefined()
      expect(await readResourceBytes(media, preview.resourceUri, bytes.byteLength, 4)).toEqual(bytes)
    } finally {
      await media.close()
    }
  })

  it("keeps oversized inline previews as ordinary local files but refuses to serialize them", async () => {
    const root = await artifactRoot()
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const media = createPippitWidgetMediaServer({
      artifactRoot: root,
      backend: { async downloadVideo() { return new Response(bytes, { headers: { "content-type": "video/mp4" } }) } },
      maxArtifactBytes: bytes.byteLength,
      maxInlinePreviewBytes: bytes.byteLength - 1,
    })
    try {
      const preview = await media.preparePreview("job_inline_limit", 0)
      expect(new Uint8Array(await readFile(preview.localPath))).toEqual(bytes)
      const uri = new URL(preview.resourceUri)
      uri.searchParams.set("length", "1")
      uri.searchParams.set("offset", "0")
      await expect(media.readResource(uri.toString())).rejects.toThrow(/unsafe/u)
      expect(new Uint8Array(await readFile(preview.localPath))).toEqual(bytes)
    } finally {
      await media.close()
    }
  })

  it("closes resource access but keeps the persistent local artifact", async () => {
    const root = await artifactRoot()
    const media = createPippitWidgetMediaServer({
      artifactRoot: root,
      backend: { async downloadVideo() { return new Response("video", { headers: { "content-type": "video/mp4" } }) } },
    })
    const preview = await media.preparePreview("job_123", 0)
    const filesBeforeClose = await artifactFiles(root)
    await media.close()
    const chunkUri = new URL(preview.resourceUri)
    chunkUri.searchParams.set("length", "1")
    chunkUri.searchParams.set("offset", "0")
    await expect(media.readResource(chunkUri.toString())).rejects.toThrow(/closed/u)
    expect(await artifactFiles(root)).toEqual(filesBeforeClose)
  })

  it("does not change permissions on an existing safe user output directory", async () => {
    if (process.platform === "win32") return
    const root = await artifactRoot()
    await chmod(root, 0o755)
    const media = createPippitWidgetMediaServer({
      artifactRoot: root,
      backend: {
        async downloadVideo() {
          return new Response("video", { headers: { "content-type": "video/mp4" } })
        },
      },
    })
    try {
      await media.preparePreview("job_existing_output_root", 0)
      expect((await lstat(root)).mode & 0o777).toBe(0o755)
    } finally {
      await media.close()
    }
  })
})
