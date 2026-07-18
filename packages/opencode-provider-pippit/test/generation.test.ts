import { describe, expect, it, vi } from "vitest"
import type { PublicHttpFetcher, ReferenceLoader } from "@pippit-bridge/core"
import type { PippitApi } from "@pippit-bridge/sdk"
import { PippitVideoService } from "../src/generation.js"

function createHarness() {
  let nextAsset = 0
  const remoteLoader: ReferenceLoader = {
    load: vi.fn(async (_url, kind) => ({
      bytes: new TextEncoder().encode(kind),
      filename: `${kind}.bin`,
      mediaType: `${kind}/test`,
    })),
  }
  const pippit: PippitApi = {
    uploadFile: vi.fn<PippitApi["uploadFile"]>(async () => ({ assetId: `asset-${++nextAsset}` })),
    submitRun: vi.fn<PippitApi["submitRun"]>(async () => ({
      run: { runId: "run-1", state: 1, threadId: "thread-1" },
      webThreadLink: "https://xyq.jianying.com/thread/thread-1",
    })),
    queryVideoResult: vi.fn<PippitApi["queryVideoResult"]>(async () => ({
      imageUrls: [],
      runState: 1,
      videoUrls: [],
    })),
  }
  const outputFetcher: PublicHttpFetcher = {
    fetch: vi.fn(async () => {
      throw new Error("Unexpected output download")
    }),
  }
  const service = new PippitVideoService({
    defaultOutputDirectory: ".pippit/outputs",
    outputFetcher,
    pippit,
    pollIntervalMs: 1,
    remoteLoader,
    sleep: vi.fn(async () => undefined),
  })
  return { outputFetcher, pippit, remoteLoader, service }
}

describe("PippitVideoService", () => {
  it("maps a stable model and uploaded references to the documented Pippit request", async () => {
    const { pippit, service } = createHarness()

    const result = await service.generate({
      accessKey: "ak-secret",
      aspectRatio: "9:16",
      duration: 10,
      model: "pippit/seedance-2.0-fast",
      prompt: "A product reveal",
      references: [
        { kind: "image", source: "https://example.com/product.png" },
        { kind: "video", source: "https://example.com/motion.mp4" },
        { kind: "audio", source: "https://example.com/music.mp3" },
      ],
      resolution: "720p",
      rootDirectory: process.cwd(),
      seed: 42,
      waitForCompletion: false,
    })

    expect(result).toMatchObject({
      model: "pippit/seedance-2.0-fast",
      runId: "run-1",
      status: "pending",
      threadId: "thread-1",
    })
    expect(pippit.submitRun).toHaveBeenCalledWith({
      accessKey: "ak-secret",
      request: {
        asset_ids: ["asset-1", "asset-2", "asset-3"],
        message: "A product reveal",
        video_part_tool_param: {
          audios: [{ pippit_asset_id: "asset-3" }],
          duration_sec: 10,
          images: [{ pippit_asset_id: "asset-1" }],
          model: "seedance2.0_fast_vision",
          prompt: "A product reveal",
          ratio: "9:16",
          resolution: "720p",
          seed: 42,
          videos: [{ pippit_asset_id: "asset-2" }],
        },
      },
    })
  })

  it("gives ordered first/last frames precedence over generic references", async () => {
    const { pippit, remoteLoader, service } = createHarness()

    await service.generate({
      accessKey: "ak-secret",
      firstFrame: "https://example.com/first.png",
      lastFrame: "https://example.com/last.png",
      prompt: "Day to night",
      references: [{ kind: "audio", source: "https://example.com/ignored.mp3" }],
      rootDirectory: process.cwd(),
      waitForCompletion: false,
    })

    expect(remoteLoader.load).toHaveBeenNthCalledWith(1, "https://example.com/first.png", "image", undefined)
    expect(remoteLoader.load).toHaveBeenNthCalledWith(2, "https://example.com/last.png", "image", undefined)
    expect(remoteLoader.load).toHaveBeenCalledTimes(2)
    expect(pippit.submitRun).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          video_part_tool_param: expect.objectContaining({
            generate_type: 1,
            images: [{ pippit_asset_id: "asset-1" }, { pippit_asset_id: "asset-2" }],
          }),
        }),
      }),
    )
  })

  it("returns completed URLs without downloading when requested", async () => {
    const { pippit, service } = createHarness()
    vi.mocked(pippit.queryVideoResult).mockResolvedValueOnce({
      imageUrls: [],
      runState: 3,
      videoUrls: ["https://example.com/result.mp4"],
    })

    await expect(
      service.get({
        accessKey: "ak-secret",
        download: false,
        rootDirectory: process.cwd(),
        runId: "run-1",
        threadId: "thread-1",
      }),
    ).resolves.toEqual({
      runId: "run-1",
      status: "completed",
      threadId: "thread-1",
      videoUrls: ["https://example.com/result.mp4"],
    })
  })

  it("redacts the Access Key from upstream failure text", async () => {
    const { pippit, service } = createHarness()
    vi.mocked(pippit.queryVideoResult).mockResolvedValueOnce({
      failReason: { message: "credential ak-top-secret was rejected" },
      imageUrls: [],
      runState: 4,
      videoUrls: [],
    })

    const result = await service.get({
      accessKey: "ak-top-secret",
      rootDirectory: process.cwd(),
      runId: "run-1",
      threadId: "thread-1",
    })

    expect(result.failure).toBe("credential [REDACTED] was rejected")
    expect(JSON.stringify(result)).not.toContain("ak-top-secret")
  })

  it("rejects unsupported model geometry before submitting a paid run", async () => {
    const { pippit, service } = createHarness()

    await expect(
      service.generate({
        accessKey: "ak-secret",
        model: "pippit/seedance-2.0-fast",
        prompt: "A product reveal",
        resolution: "1080p",
        rootDirectory: process.cwd(),
      }),
    ).rejects.toThrow("does not support resolution 1080p")
    expect(pippit.submitRun).not.toHaveBeenCalled()
  })

  it("does not let a query overrun max_wait_seconds", async () => {
    vi.useFakeTimers()
    try {
      const { pippit, service } = createHarness()
      let notifyStarted: (() => void) | undefined
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve
      })
      vi.mocked(pippit.queryVideoResult).mockImplementationOnce(
        async ({ signal }) =>
          new Promise((_resolve, reject) => {
            notifyStarted?.()
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
          }),
      )
      const pending = service.get({
        accessKey: "ak-secret",
        maxWaitSeconds: 1,
        rootDirectory: process.cwd(),
        runId: "run-1",
        threadId: "thread-1",
        waitForCompletion: true,
      })
      await started

      const assertion = expect(pending).resolves.toEqual({
        runId: "run-1",
        status: "pending",
        threadId: "thread-1",
      })
      await vi.advanceTimersByTimeAsync(1_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
