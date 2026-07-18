import { describe, expect, it, vi } from "vitest"
import { prepareReferences } from "../src/media/prepare-references.js"
import { ReferenceLoadError, type ReferenceLoader } from "@pippit-bridge/core"
import type { PippitApi } from "@pippit-bridge/sdk"

function createDependencies() {
  const load = vi.fn<ReferenceLoader["load"]>(async (_url, kind) => ({
    bytes: new TextEncoder().encode(kind),
    filename: `${kind}.bin`,
    mediaType: `${kind}/test`,
  }))
  let nextAsset = 0
  const uploadFile = vi.fn<PippitApi["uploadFile"]>(async () => ({ assetId: `asset-${++nextAsset}` }))
  const pippit = {
    queryVideoResult: vi.fn<PippitApi["queryVideoResult"]>(),
    submitRun: vi.fn<PippitApi["submitRun"]>(),
    uploadFile,
  } satisfies PippitApi
  return { loader: { load } satisfies ReferenceLoader, load, pippit, uploadFile }
}

describe("prepareReferences", () => {
  it("uploads image, video, and audio references before returning asset ids", async () => {
    const dependencies = createDependencies()
    const result = await prepareReferences({
      accessKey: "ak-test",
      concurrency: 2,
      loader: dependencies.loader,
      pippit: dependencies.pippit,
      request: {
        input_references: [
          { image_url: { url: "https://media.test/image.png" }, type: "image_url" },
          { type: "video_url", video_url: { url: "https://media.test/video.mp4" } },
          { audio_url: { url: "https://media.test/audio.mp3" }, type: "audio_url" },
        ],
        model: "pippit/seedance-2.0",
        prompt: "test",
      },
    })

    expect(result).toEqual({
      assetIds: ["asset-1", "asset-2", "asset-3"],
      audios: [{ pippit_asset_id: "asset-3" }],
      images: [{ pippit_asset_id: "asset-1" }],
      videos: [{ pippit_asset_id: "asset-2" }],
    })
  })

  it("uses frame_images in first/last order and ignores input_references", async () => {
    const dependencies = createDependencies()
    const result = await prepareReferences({
      accessKey: "ak-test",
      concurrency: 2,
      loader: dependencies.loader,
      pippit: dependencies.pippit,
      request: {
        frame_images: [
          {
            frame_type: "last_frame",
            image_url: { url: "https://media.test/last.png" },
            type: "image_url",
          },
          {
            frame_type: "first_frame",
            image_url: { url: "https://media.test/first.png" },
            type: "image_url",
          },
        ],
        input_references: [
          { type: "video_url", video_url: { url: "https://media.test/ignored.mp4" } },
        ],
        model: "pippit/seedance-2.0",
        prompt: "test",
      },
    })

    expect(dependencies.load.mock.calls.map(([url]) => url)).toEqual([
      "https://media.test/first.png",
      "https://media.test/last.png",
    ])
    expect(result.generateType).toBe(1)
    expect(result.videos).toEqual([])
  })

  it("deduplicates an identical URL without changing logical reference order", async () => {
    const dependencies = createDependencies()
    const result = await prepareReferences({
      accessKey: "ak-test",
      concurrency: 3,
      loader: dependencies.loader,
      pippit: dependencies.pippit,
      request: {
        input_references: [
          { image_url: { url: "https://media.test/same.png" }, type: "image_url" },
          { image_url: { url: "https://media.test/same.png" }, type: "image_url" },
        ],
        model: "pippit/seedance-2.0",
        prompt: "test",
      },
    })

    expect(dependencies.load).toHaveBeenCalledTimes(1)
    expect(dependencies.uploadFile).toHaveBeenCalledTimes(1)
    expect(result.assetIds).toEqual(["asset-1", "asset-1"])
  })

  it("does not submit generation when an upload fails", async () => {
    const dependencies = createDependencies()
    dependencies.uploadFile.mockRejectedValueOnce(new Error("upload failed"))

    await expect(
      prepareReferences({
        accessKey: "ak-test",
        concurrency: 1,
        loader: dependencies.loader,
        pippit: dependencies.pippit,
        request: {
          input_references: [{ image_url: { url: "https://media.test/image.png" }, type: "image_url" }],
          model: "pippit/seedance-2.0",
          prompt: "test",
        },
      }),
    ).rejects.toThrow("upload failed")
    expect(dependencies.pippit.submitRun).not.toHaveBeenCalled()
  })

  it("aborts sibling workers and waits for cleanup after the first failure", async () => {
    const dependencies = createDependencies()
    dependencies.load.mockImplementation(async (url, _kind, signal) => {
      if (url.endsWith("first.png")) throw new Error("first failed")
      return new Promise((_, reject) => {
        const abort = () => reject(new ReferenceLoadError("ABORTED"))
        if (signal?.aborted) abort()
        else signal?.addEventListener("abort", abort, { once: true })
      })
    })

    await expect(
      prepareReferences({
        accessKey: "ak-test",
        concurrency: 2,
        loader: dependencies.loader,
        pippit: dependencies.pippit,
        request: {
          input_references: [
            { image_url: { url: "https://media.test/first.png" }, type: "image_url" },
            { image_url: { url: "https://media.test/second.png" }, type: "image_url" },
            { image_url: { url: "https://media.test/third.png" }, type: "image_url" },
          ],
          model: "pippit/seedance-2.0",
          prompt: "test",
        },
      }),
    ).rejects.toThrow("first failed")

    expect(dependencies.load).toHaveBeenCalledTimes(2)
    expect(dependencies.uploadFile).not.toHaveBeenCalled()
  })

  it("enforces the aggregate byte budget before uploading the overflowing reference", async () => {
    const dependencies = createDependencies()
    dependencies.load.mockResolvedValue({
      bytes: new Uint8Array(6),
      filename: "image.png",
      mediaType: "image/png",
    })

    await expect(
      prepareReferences({
        accessKey: "ak-test",
        concurrency: 1,
        loader: dependencies.loader,
        maxTotalBytes: 10,
        pippit: dependencies.pippit,
        request: {
          input_references: [
            { image_url: { url: "https://media.test/one.png" }, type: "image_url" },
            { image_url: { url: "https://media.test/two.png" }, type: "image_url" },
          ],
          model: "pippit/seedance-2.0",
          prompt: "test",
        },
      }),
    ).rejects.toMatchObject({ code: "TOTAL_TOO_LARGE" })

    expect(dependencies.uploadFile).toHaveBeenCalledTimes(1)
  })
})
