import { chmod, lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createPippitWidgetMediaServer,
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

afterEach(async () => {
  await Promise.all([...cleanupRoots].map(async root => rm(root, { force: true, recursive: true })))
  cleanupRoots.clear()
})

describe("Pippit widget media server", () => {
  it("downloads a complete artifact before issuing a signed loopback URL, then serves local Range", async () => {
    const root = await artifactRoot()
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])
    const downloadVideo = vi.fn(async (_jobId: string, _options?: { readonly index?: number; readonly signal?: AbortSignal }) => new Response(bytes, {
      headers: { "content-length": String(bytes.byteLength), "content-type": "application/octet-stream" },
    }))
    const media = createPippitWidgetMediaServer({ artifactRoot: root, backend: { downloadVideo } })
    try {
      const preview = await media.preparePreview("job_123", 2)
      const url = preview.url
      expect(new URL(url).hostname).toBe("127.0.0.1")
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
        new URL(url).origin,
      ])

      const response = await fetch(url, { headers: { range: "bytes=0-3" } })
      expect(response.status).toBe(206)
      expect(response.headers.get("content-type")).toBe("video/mp4")
      expect(response.headers.get("content-range")).toBe(`bytes 0-3/${bytes.byteLength}`)
      expect(response.headers.get("cache-control")).toBe("private, no-store")
      expect(response.headers.get("access-control-allow-origin")).toBe("*")
      expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin")
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(0, 4))
      const head = await fetch(url, { method: "HEAD" })
      expect(head.status).toBe(200)
      expect(head.headers.get("accept-ranges")).toBe("bytes")
      expect(head.headers.get("content-length")).toBe(String(bytes.byteLength))
      expect((await head.arrayBuffer()).byteLength).toBe(0)
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
    const urls = await Promise.all(Array.from({ length: 20 }, async () => first.previewUrl("job_shared", 0)))
    expect(new Set(urls).size).toBe(1)
    expect(downloadVideo).toHaveBeenCalledOnce()
    await first.close()

    const shouldNotDownload = vi.fn(async () => { throw new Error("unexpected download") })
    const restarted = createPippitWidgetMediaServer({ artifactRoot: root, backend: { downloadVideo: shouldNotDownload } })
    try {
      const response = await fetch(await restarted.previewUrl("job_shared", 0))
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
      expect(shouldNotDownload).not.toHaveBeenCalled()
      expect(await artifactFiles(root)).toHaveLength(1)
    } finally {
      await restarted.close()
    }
  })

  it("waits for the full local download before resolving previewUrl", async () => {
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
      const preview = media.previewUrl("job_stream", 0).then((url) => {
        resolved = true
        return url
      })
      await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
      expect(resolved).toBe(false)
      finish?.()
      const response = await fetch(await preview)
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
    } finally {
      await media.close()
    }
  })

  it("supports open-ended and suffix ranges and rejects malformed or unsatisfiable ranges", async () => {
    const root = await artifactRoot()
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])
    const media = createPippitWidgetMediaServer({
      artifactRoot: root,
      backend: { async downloadVideo() { return new Response(bytes, { headers: { "content-type": "video/mp4" } }) } },
    })
    try {
      const url = await media.previewUrl("job_ranges", 0)
      const openEnded = await fetch(url, { headers: { range: "bytes=3-" } })
      expect(openEnded.status).toBe(206)
      expect(openEnded.headers.get("content-range")).toBe("bytes 3-7/8")
      expect(new Uint8Array(await openEnded.arrayBuffer())).toEqual(bytes.slice(3))

      const suffix = await fetch(url, { headers: { range: "bytes=-3" } })
      expect(suffix.status).toBe(206)
      expect(suffix.headers.get("content-range")).toBe("bytes 5-7/8")
      expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(bytes.slice(5))

      for (const range of ["bytes=9-", "bytes=4-2", "bytes=0-1,3-4", "items=0-1"]) {
        const invalid = await fetch(url, { headers: { range } })
        expect(invalid.status).toBe(416)
        expect(invalid.headers.get("content-range")).toBe("bytes */8")
      }
    } finally {
      await media.close()
    }
  })

  it("keeps plugin-lifecycle capabilities stable and rejects tampering without touching the artifact backend", async () => {
    const root = await artifactRoot()
    let now = 1_000_000
    const downloadVideo = vi.fn(async () => new Response("video", { headers: { "content-type": "video/mp4" } }))
    const media = createPippitWidgetMediaServer({
      artifactRoot: root,
      backend: { downloadVideo },
      now: () => now,
      signingKey: new Uint8Array(32).fill(7),
    })
    try {
      const url = await media.previewUrl("job_123", 0)
      expect(downloadVideo).toHaveBeenCalledOnce()
      const tampered = new URL(url)
      tampered.searchParams.set("token", `${tampered.searchParams.get("token")}x`)
      expect((await fetch(tampered)).status).toBe(401)
      now += 24 * 60 * 60 * 1_000
      expect((await fetch(url)).status).toBe(200)
      expect(downloadVideo).toHaveBeenCalledOnce()
    } finally {
      await media.close()
    }
  })

  it("reuses one stable URL and does not download the same local file twice", async () => {
    const root = await artifactRoot()
    const downloadVideo = vi.fn(async () => new Response("video", { headers: { "content-type": "video/mp4" } }))
    const media = createPippitWidgetMediaServer({
      artifactRoot: root,
      backend: { downloadVideo },
      now: () => 1_000_000,
      signingKey: new Uint8Array(32).fill(9),
    })
    try {
      const first = await media.previewUrl("job_123", 0)
      const reused = await media.previewUrl("job_123", 0)
      expect(reused).toBe(first)
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
        await expect(media.previewUrl(`job_bad_${index}`, 0)).rejects.toThrow()
        expect(await artifactFiles(root)).toEqual([])
      } finally {
        await media.close()
      }
    }
  })

  it("closes the loopback listener but keeps the persistent local artifact", async () => {
    const root = await artifactRoot()
    const media = createPippitWidgetMediaServer({
      artifactRoot: root,
      backend: { async downloadVideo() { return new Response("video", { headers: { "content-type": "video/mp4" } }) } },
    })
    const url = await media.previewUrl("job_123", 0)
    const filesBeforeClose = await artifactFiles(root)
    await media.close()
    await expect(fetch(url)).rejects.toThrow()
    expect(await artifactFiles(root)).toEqual(filesBeforeClose)
  })

  it("answers private-network preflight requests from the plugin listener", async () => {
    const root = await artifactRoot()
    const media = createPippitWidgetMediaServer({
      artifactRoot: root,
      backend: {
        async downloadVideo() {
          return new Response("video", { headers: { "content-type": "video/mp4" } })
        },
      },
    })
    try {
      const url = await media.previewUrl("job_pna", 0)
      const response = await fetch(url, {
        headers: {
          "access-control-request-headers": "range",
          "access-control-request-method": "GET",
          "access-control-request-private-network": "true",
          origin: "https://chatgpt.com",
        },
        method: "OPTIONS",
      })
      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-private-network")).toBe("true")
      expect(response.headers.get("access-control-allow-headers")).toContain("range")
      expect(response.headers.get("vary")).toContain("Access-Control-Request-Private-Network")
    } finally {
      await media.close()
    }
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
