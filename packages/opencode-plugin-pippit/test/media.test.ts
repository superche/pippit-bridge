import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PublicHttpFetcher, ReferenceLoader } from "@pippit-bridge/core"
import { downloadPippitVideos, loadPippitReference } from "../src/media.js"

const temporaryDirectories: string[] = []
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MP4_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
])

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pippit-opencode-test-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("OpenCode Pippit media boundaries", () => {
  it("loads a signature-checked local reference inside the worktree", async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, "product.png"), PNG_BYTES)
    const remoteLoader: ReferenceLoader = { load: vi.fn() }

    await expect(
      loadPippitReference({ kind: "image", remoteLoader, rootDirectory: root, source: "product.png" }),
    ).resolves.toEqual({ bytes: PNG_BYTES, filename: "product.png", mediaType: "image/png" })
    expect(remoteLoader.load).not.toHaveBeenCalled()
  })

  it("rejects a local reference that resolves outside the worktree", async () => {
    const root = await temporaryDirectory()
    const outside = await temporaryDirectory()
    await writeFile(join(outside, "secret.png"), PNG_BYTES)

    await expect(
      loadPippitReference({
        kind: "image",
        remoteLoader: { load: vi.fn() },
        rootDirectory: root,
        source: join(outside, "secret.png"),
      }),
    ).rejects.toThrow("inside the OpenCode worktree")
  })

  it("treats a Windows drive path as a local path rather than a URL scheme", async () => {
    const root = await temporaryDirectory()

    await expect(
      loadPippitReference({
        kind: "image",
        remoteLoader: { load: vi.fn() },
        rootDirectory: root,
        source: "C:\\workspace\\product.png",
      }),
    ).rejects.toThrow("does not exist")
  })

  it("streams completed videos to a private file inside the worktree", async () => {
    const root = await temporaryDirectory()
    const fetcher: PublicHttpFetcher = {
      fetch: vi.fn(async () => ({
        response: new Response(MP4_BYTES, { headers: { "content-type": "video/mp4" } }),
        url: new URL("https://example.com/result.mp4"),
      })),
    }

    const files = await downloadPippitVideos({
      fetcher,
      outputDirectory: ".pippit/outputs",
      rootDirectory: root,
      runId: "run/unsafe:id",
      urls: ["https://example.com/result.mp4"],
    })

    expect(files).toEqual([join(await realpath(root), ".pippit/outputs/run-unsafe-id-1.mp4")])
    await expect(readFile(files[0]!)).resolves.toEqual(Buffer.from(MP4_BYTES))
  })

  it("removes earlier downloads when a later video fails", async () => {
    const root = await temporaryDirectory()
    let request = 0
    const fetcher: PublicHttpFetcher = {
      fetch: vi.fn(async () => {
        request += 1
        return request === 1
          ? {
              response: new Response(MP4_BYTES, { headers: { "content-type": "video/mp4" } }),
              url: new URL("https://example.com/first.mp4"),
            }
          : {
              response: new Response(null, { status: 502 }),
              url: new URL("https://example.com/second.mp4"),
            }
      }),
    }

    await expect(
      downloadPippitVideos({
        fetcher,
        outputDirectory: ".pippit/outputs",
        rootDirectory: root,
        runId: "run-atomic",
        urls: ["https://example.com/first.mp4", "https://example.com/second.mp4"],
      }),
    ).rejects.toThrow("could not be downloaded")

    await expect(readFile(join(root, ".pippit/outputs/run-atomic-1.mp4"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("never deletes a pre-existing output when the generated filename collides", async () => {
    const root = await temporaryDirectory()
    const outputDirectory = join(root, ".pippit/outputs")
    const existing = join(outputDirectory, "run-existing-1.mp4")
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(existing, "keep this file")
    const fetcher: PublicHttpFetcher = {
      fetch: vi.fn(async () => ({
        response: new Response(MP4_BYTES, { headers: { "content-type": "video/mp4" } }),
        url: new URL("https://example.com/result.mp4"),
      })),
    }

    const files = await downloadPippitVideos({
        fetcher,
        outputDirectory: ".pippit/outputs",
        rootDirectory: root,
        runId: "run-existing",
        urls: ["https://example.com/result.mp4"],
      })

    expect(files).toEqual([join(await realpath(outputDirectory), "run-existing-1-2.mp4")])
    await expect(readFile(existing, "utf8")).resolves.toBe("keep this file")
    await expect(readFile(files[0]!)).resolves.toEqual(Buffer.from(MP4_BYTES))
  })

  it("bounds a stalled generated-video download", async () => {
    vi.useFakeTimers()
    try {
      const root = await temporaryDirectory()
      let notifyStarted: (() => void) | undefined
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve
      })
      const fetcher: PublicHttpFetcher = {
        fetch: vi.fn(() => {
          notifyStarted?.()
          return new Promise<never>(() => undefined)
        }),
      }
      const pending = downloadPippitVideos({
        fetcher,
        outputDirectory: ".pippit/outputs",
        rootDirectory: root,
        runId: "run-stalled",
        timeoutMs: 25,
        urls: ["https://example.com/result.mp4"],
      })
      await started

      const assertion = expect(pending).rejects.toThrow("timed out")
      await vi.advanceTimersByTimeAsync(25)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
