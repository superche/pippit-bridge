import { createHash } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildApp } from "../src/app.js"
import { MemoryByokStore, type ByokCredentialSeed } from "../src/byok/index.js"
import {
  ReferenceLoadError,
  type ReferenceLoader,
  type ReferenceTransport,
} from "@pippit-bridge/core"
import { PippitApiError, type PippitApi, type PippitSubmitRunRequest } from "@pippit-bridge/sdk"

const FACADE_KEY = "facade-test-key"
const SECOND_FACADE_KEY = "facade-second-key"
const MANAGEMENT_KEY = "management-test-key"
const PIPPIT_ACCESS_KEY = "ak-pippit-upstream"
const BYOK_ENCRYPTION_KEY_HEX = "a".repeat(64)
const JOB_SIGNING_KEY_HEX = "b".repeat(64)

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex")
const bearer = (value: string): Record<string, string> => ({ authorization: `Bearer ${value}` })

const openApps: ReturnType<typeof buildApp>[] = []

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()))
})

function createHarness(overrides: {
  readonly allowedFacadeKeys?: readonly string[]
  readonly byokSeeds?: readonly ByokCredentialSeed[]
  readonly contentStreamIdleTimeoutMs?: number
  readonly queryState?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
  readonly videoUrls?: readonly string[]
} = {}) {
  const events: string[] = []
  const submittedRequests: PippitSubmitRunRequest[] = []
  let nextAsset = 0
  const pippit = {
    queryVideoResult: vi.fn<PippitApi["queryVideoResult"]>(async () => ({
      imageUrls: [],
      runState: overrides.queryState ?? 3,
      videoUrls: [...(overrides.videoUrls ?? ["https://cdn.test/result.mp4"])],
    })),
    submitRun: vi.fn<PippitApi["submitRun"]>(async ({ request }) => {
      events.push("submit")
      submittedRequests.push(request)
      return { run: { runId: "run-1", state: 1, threadId: "thread-1" } }
    }),
    uploadFile: vi.fn<PippitApi["uploadFile"]>(async ({ file }) => {
      events.push(`upload:${file.filename}`)
      return { assetId: `asset-${++nextAsset}` }
    }),
  } satisfies PippitApi
  const loader = {
    load: vi.fn<ReferenceLoader["load"]>(async (_url, kind) => ({
      bytes: new TextEncoder().encode(kind),
      filename: `${kind}.bin`,
      mediaType: `${kind}/test`,
    })),
  } satisfies ReferenceLoader
  const contentTransport = vi.fn<ReferenceTransport>(async () =>
    new Response("video bytes", {
      headers: { "content-length": "11", "content-type": "video/mp4" },
    }),
  )
  const byokStore = new MemoryByokStore({
    seed: overrides.byokSeeds ?? [{ key: PIPPIT_ACCESS_KEY, provider: "pippit" }],
  })
  const app = buildApp({
    byokStore,
    config: {
      BYOK_ENCRYPTION_KEY_HEX,
      BYOK_MANAGEMENT_KEY_SHA256: sha256(MANAGEMENT_KEY),
      FACADE_API_KEY_SHA256_ALLOWLIST: (overrides.allowedFacadeKeys ?? [FACADE_KEY]).map(sha256),
      JOB_SIGNING_KEY_HEX,
      ...(overrides.contentStreamIdleTimeoutMs === undefined
        ? {}
        : { CONTENT_STREAM_IDLE_TIMEOUT_MS: overrides.contentStreamIdleTimeoutMs }),
    },
    contentLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    contentTransport,
    pippit,
    referenceLoader: loader,
  })
  openApps.push(app)
  return { app, byokStore, contentTransport, events, loader, pippit, submittedRequests }
}

async function createVideo(app: ReturnType<typeof buildApp>, facadeKey = FACADE_KEY) {
  return app.inject({
    headers: bearer(facadeKey),
    method: "POST",
    payload: { model: "pippit/seedance-2.0", prompt: "test" },
    url: "/api/v1/videos",
  })
}

describe("OpenRouter BYOK control plane", () => {
  it("requires a Management Key and keeps runtime and management credentials separate", async () => {
    const harness = createHarness({ byokSeeds: [] })

    const withoutKey = await harness.app.inject({ method: "GET", url: "/api/v1/byok" })
    const withFacadeKey = await harness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "GET",
      url: "/api/v1/byok",
    })
    const runtimeWithManagementKey = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "GET",
      url: "/api/v1/models",
    })

    expect(withoutKey.statusCode).toBe(401)
    expect(withoutKey.headers["cache-control"]).toBe("no-store")
    expect(withFacadeKey.statusCode).toBe(401)
    expect(runtimeWithManagementKey.statusCode).toBe(401)
  })

  it("creates, lists, reads, rotates, updates, and deletes a Pippit credential", async () => {
    const harness = createHarness({ byokSeeds: [] })
    const created = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "POST",
      payload: {
        allowed_api_key_hashes: [sha256(FACADE_KEY)],
        allowed_models: ["pippit/seedance-2.0"],
        key: "ak-created-secret",
        name: "production",
        provider: "pippit",
      },
      url: "/api/v1/byok",
    })

    expect(created.statusCode).toBe(201)
    expect(created.headers["cache-control"]).toBe("no-store")
    expect(created.body).not.toContain("ak-created-secret")
    expect(created.json().data).toMatchObject({
      allowed_api_key_hashes: [sha256(FACADE_KEY)],
      allowed_models: ["pippit/seedance-2.0"],
      label: "ak-****cret",
      name: "production",
      provider: "pippit",
    })
    const id = created.json().data.id as string

    const listed = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "GET",
      url: "/api/v1/byok?limit=10&offset=0&provider=pippit",
    })
    expect(listed.json()).toMatchObject({ total_count: 1 })
    expect(listed.json().data[0].id).toBe(id)

    const fetched = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "GET",
      url: `/api/v1/byok/${id}`,
    })
    expect(fetched.json().data.id).toBe(id)

    const updated = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "PATCH",
      payload: { disabled: true, key: "ak-rotated-secret", name: "paused" },
      url: `/api/v1/byok/${id}`,
    })
    expect(updated.body).not.toContain("ak-rotated-secret")
    expect(updated.json().data).toMatchObject({ disabled: true, label: "ak-****cret", name: "paused" })

    const deleted = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "DELETE",
      url: `/api/v1/byok/${id}`,
    })
    expect(deleted.json()).toEqual({ deleted: true })
    const missing = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "GET",
      url: `/api/v1/byok/${id}`,
    })
    expect(missing.statusCode).toBe(404)
  })
})

describe("OpenRouter video facade", () => {
  it("requires an authorized facade API key", async () => {
    const harness = createHarness()
    const missing = await harness.app.inject({ method: "GET", url: "/api/v1/videos/models" })
    const rejected = await harness.app.inject({
      headers: bearer("facade-not-allowed"),
      method: "POST",
      payload: {
        input_references: [{ image_url: { url: "https://media.test/image.png" }, type: "image_url" }],
        model: "pippit/seedance-2.0",
        prompt: "test",
      },
      url: "/api/v1/videos",
    })

    expect(missing.statusCode).toBe(401)
    expect(missing.json().error.message).toContain("facade API key")
    expect(rejected.statusCode).toBe(401)
    expect(harness.loader.load).not.toHaveBeenCalled()
    expect(harness.pippit.uploadFile).not.toHaveBeenCalled()
  })

  it("lists only public model fields", async () => {
    const harness = createHarness()
    const response = await harness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "GET",
      url: "/api/v1/videos/models",
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data).toHaveLength(4)
    expect(response.json().data[0]).not.toHaveProperty("upstreamModel")
  })

  it("uploads image, video, and audio with the stored AK before submit_run", async () => {
    const harness = createHarness()
    const response = await harness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "POST",
      payload: {
        aspect_ratio: "9:16",
        duration: 10,
        input_references: [
          { image_url: { url: "https://media.test/image.png" }, type: "image_url" },
          { type: "video_url", video_url: { url: "https://media.test/video.mp4" } },
          { audio_url: { url: "https://media.test/audio.mp3" }, type: "audio_url" },
        ],
        model: "pippit/seedance-2.0",
        prompt: "make a video",
        provider: { options: { pippit: { thread_id: "existing-thread" } } },
        resolution: "720p",
        seed: 42,
      },
      url: "/api/v1/videos",
    })

    expect(response.statusCode).toBe(202)
    expect(harness.events.slice(0, -1).every((event) => event.startsWith("upload:"))).toBe(true)
    expect(harness.events.at(-1)).toBe("submit")
    expect(harness.pippit.uploadFile).toHaveBeenCalledTimes(3)
    for (const [input] of harness.pippit.uploadFile.mock.calls) expect(input.accessKey).toBe(PIPPIT_ACCESS_KEY)
    expect(harness.pippit.submitRun).toHaveBeenCalledWith(
      expect.objectContaining({ accessKey: PIPPIT_ACCESS_KEY }),
    )
    expect(harness.submittedRequests).toEqual([
      {
        asset_ids: ["asset-1", "asset-2", "asset-3"],
        message: "make a video",
        thread_id: "existing-thread",
        video_part_tool_param: {
          audios: [{ pippit_asset_id: "asset-3" }],
          duration_sec: 10,
          images: [{ pippit_asset_id: "asset-1" }],
          model: "seedance2.0_vision",
          prompt: "make a video",
          ratio: "9:16",
          resolution: "720p",
          seed: 42,
          videos: [{ pippit_asset_id: "asset-2" }],
        },
      },
    ])
    expect(response.json()).toMatchObject({
      generation_id: "run-1",
      model: "pippit/seedance-2.0",
      status: "pending",
      usage: { is_byok: true },
    })
    expect(response.json().id).toMatch(/^pippit_job_v2\./u)
  })

  it("polls the pinned credential version and exposes facade content URLs", async () => {
    const harness = createHarness({ videoUrls: ["https://cdn.test/one.mp4", "https://cdn.test/two.mp4"] })
    const created = await createVideo(harness.app)
    const credential = (await harness.byokStore.list()).data[0]
    if (credential === undefined) throw new Error("missing seeded credential")
    await harness.byokStore.update(credential.id, { key: "ak-new-active" })

    const jobId = created.json().id as string
    const polled = await harness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "GET",
      url: `/api/v1/videos/${encodeURIComponent(jobId)}`,
    })

    expect(polled.statusCode).toBe(200)
    expect(harness.pippit.queryVideoResult).toHaveBeenCalledWith(
      expect.objectContaining({ accessKey: PIPPIT_ACCESS_KEY, runId: "run-1", threadId: "thread-1" }),
    )
    expect(polled.json()).toMatchObject({
      generation_id: "run-1",
      status: "completed",
      unsigned_urls: [
        `/api/v1/videos/${encodeURIComponent(jobId)}/content?index=0`,
        `/api/v1/videos/${encodeURIComponent(jobId)}/content?index=1`,
      ],
      usage: { is_byok: true },
    })
  })

  it("rejects a completed state without a video URL", async () => {
    const harness = createHarness({ videoUrls: [] })
    const created = await createVideo(harness.app)
    const polled = await harness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "GET",
      url: `/api/v1/videos/${encodeURIComponent(created.json().id as string)}`,
    })

    expect(polled.statusCode).toBe(502)
    expect(polled.json().error.metadata.internal_code).toBe("invalid_upstream_response")
  })

  it("binds a job handle to the facade key, not the Pippit AK", async () => {
    const harness = createHarness({ allowedFacadeKeys: [FACADE_KEY, SECOND_FACADE_KEY] })
    const created = await createVideo(harness.app)
    const queriedBefore = harness.pippit.queryVideoResult.mock.calls.length
    const polled = await harness.app.inject({
      headers: bearer(SECOND_FACADE_KEY),
      method: "GET",
      url: `/api/v1/videos/${encodeURIComponent(created.json().id as string)}`,
    })

    expect(polled.statusCode).toBe(404)
    expect(harness.pippit.queryVideoResult).toHaveBeenCalledTimes(queriedBefore)
  })

  it("returns 409 when a job's credential has been deleted", async () => {
    const harness = createHarness()
    const created = await createVideo(harness.app)
    const credential = (await harness.byokStore.list()).data[0]
    if (credential === undefined) throw new Error("missing seeded credential")
    await harness.byokStore.delete(credential.id)

    const polled = await harness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "GET",
      url: `/api/v1/videos/${encodeURIComponent(created.json().id as string)}`,
    })
    expect(polled.statusCode).toBe(409)
    expect(polled.json().error.metadata.internal_code).toBe("byok_credential_unavailable")
  })

  it("reuploads references with a fallback credential after a definite upstream auth failure", async () => {
    const harness = createHarness({
      byokSeeds: [
        { key: "ak-primary", provider: "pippit" },
        { is_fallback: true, key: "ak-fallback", provider: "pippit" },
      ],
    })
    harness.pippit.uploadFile.mockRejectedValueOnce(
      new PippitApiError({ code: "HTTP_ERROR", operation: "upload_file", status: 401 }),
    )

    const response = await harness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "POST",
      payload: {
        input_references: [{ image_url: { url: "https://media.test/image.png" }, type: "image_url" }],
        model: "pippit/seedance-2.0",
        prompt: "test fallback",
      },
      url: "/api/v1/videos",
    })

    expect(response.statusCode).toBe(202)
    expect(harness.loader.load).toHaveBeenCalledTimes(2)
    expect(harness.pippit.uploadFile.mock.calls.map(([input]) => input.accessKey)).toEqual([
      "ak-primary",
      "ak-fallback",
    ])
    expect(harness.pippit.submitRun).toHaveBeenCalledWith(
      expect.objectContaining({ accessKey: "ak-fallback" }),
    )
  })

  it("does not fallback after an ambiguous submit timeout", async () => {
    const harness = createHarness({
      byokSeeds: [
        { key: "ak-primary", provider: "pippit" },
        { is_fallback: true, key: "ak-fallback", provider: "pippit" },
      ],
    })
    harness.pippit.submitRun.mockRejectedValueOnce(
      new PippitApiError({ code: "TIMEOUT", operation: "submit_run" }),
    )
    const response = await createVideo(harness.app)

    expect(response.statusCode).toBe(504)
    expect(harness.pippit.submitRun).toHaveBeenCalledTimes(1)
    expect(harness.pippit.submitRun.mock.calls[0]?.[0].accessKey).toBe("ak-primary")
  })

  it("requires explicit byok_id when continuing a thread across multiple credentials", async () => {
    const harness = createHarness({
      byokSeeds: [
        { key: "ak-one", provider: "pippit" },
        { key: "ak-two", provider: "pippit" },
      ],
    })
    const response = await harness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "POST",
      payload: {
        model: "pippit/seedance-2.0",
        prompt: "continue",
        provider: { options: { pippit: { thread_id: "existing-thread" } } },
      },
      url: "/api/v1/videos",
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.metadata.internal_code).toBe("byok_credential_required")
    expect(harness.pippit.submitRun).not.toHaveBeenCalled()
  })

  it("streams generated content and forwards byte ranges", async () => {
    const harness = createHarness()
    harness.contentTransport.mockResolvedValueOnce(
      new Response("video", {
        headers: {
          "accept-ranges": "bytes",
          "content-range": "bytes 0-4/11",
          "content-type": "video/mp4",
        },
        status: 206,
      }),
    )
    const created = await createVideo(harness.app)
    const response = await harness.app.inject({
      headers: { ...bearer(FACADE_KEY), range: "bytes=0-4" },
      method: "GET",
      url: `/api/v1/videos/${encodeURIComponent(created.json().id as string)}/content`,
    })

    expect(response.statusCode).toBe(206)
    expect(response.headers["content-type"]).toBe("video/mp4")
    expect(response.headers["content-range"]).toBe("bytes 0-4/11")
    const requestHeaders = new Headers(harness.contentTransport.mock.calls.at(-1)?.[2]?.headers)
    expect(requestHeaders.get("range")).toBe("bytes=0-4")
  })

  it("revalidates redirects and rejects non-video content", async () => {
    const harness = createHarness()
    harness.contentTransport.mockResolvedValueOnce(
      new Response(null, { headers: { location: "http://127.0.0.1/private.mp4" }, status: 302 }),
    )
    const created = await createVideo(harness.app)
    const blocked = await harness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "GET",
      url: `/api/v1/videos/${encodeURIComponent(created.json().id as string)}/content`,
    })
    expect(blocked.statusCode).toBe(502)

    harness.contentTransport.mockResolvedValueOnce(
      new Response("<html>not a video</html>", { headers: { "content-type": "text/html" } }),
    )
    const rejected = await harness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "GET",
      url: `/api/v1/videos/${encodeURIComponent(created.json().id as string)}/content`,
    })
    expect(rejected.statusCode).toBe(502)
    expect(rejected.json().error.metadata.internal_code).toBe("invalid_upstream_response")
  })

  it("aborts a generated-content body that exceeds the idle timeout", async () => {
    const harness = createHarness({ contentStreamIdleTimeoutMs: 10 })
    let bodyCancelled = false
    let downloadSignal: AbortSignal | undefined
    harness.contentTransport.mockImplementationOnce(async (_url, _target, options) => {
      downloadSignal = options.signal
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            bodyCancelled = true
          },
        }),
        { headers: { "content-type": "video/mp4" } },
      )
    })
    const created = await createVideo(harness.app)

    await harness.app
      .inject({
        headers: bearer(FACADE_KEY),
        method: "GET",
        url: `/api/v1/videos/${encodeURIComponent(created.json().id as string)}/content`,
      })
      .catch(() => undefined)

    expect(downloadSignal?.aborted).toBe(true)
    expect(bodyCancelled).toBe(true)
  })

  it("rejects unsupported controls and blocked references before submit", async () => {
    const harness = createHarness()
    const unsupported = await harness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "POST",
      payload: { generate_audio: false, model: "pippit/seedance-2.0", prompt: "test" },
      url: "/api/v1/videos",
    })
    expect(unsupported.statusCode).toBe(400)
    expect(unsupported.json().error.param).toBe("generate_audio")

    harness.loader.load.mockRejectedValueOnce(new ReferenceLoadError("PRIVATE_ADDRESS"))
    const blocked = await harness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "POST",
      payload: {
        input_references: [{ image_url: { url: "http://127.0.0.1/private.png" }, type: "image_url" }],
        model: "pippit/seedance-2.0",
        prompt: "test",
      },
      url: "/api/v1/videos",
    })
    expect(blocked.statusCode).toBe(400)
    expect(blocked.body).not.toContain("127.0.0.1")
    expect(harness.pippit.submitRun).not.toHaveBeenCalled()
  })

  it("maps a rejected Pippit BYOK credential without echoing it", async () => {
    const harness = createHarness()
    harness.pippit.submitRun.mockRejectedValueOnce(
      new PippitApiError({ code: "HTTP_ERROR", operation: "submit_run", status: 401 }),
    )
    const response = await createVideo(harness.app)

    expect(response.statusCode).toBe(502)
    expect(response.body).not.toContain(PIPPIT_ACCESS_KEY)
    expect(response.json().error.metadata.internal_code).toBe("byok_credential_rejected")
  })
})
