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

  it("scopes MCP list and delete operations to the requested facade caller", async () => {
    const firstCallerHash = sha256(FACADE_KEY)
    const secondCallerHash = sha256(SECOND_FACADE_KEY)
    const harness = createHarness({
      allowedFacadeKeys: [FACADE_KEY, SECOND_FACADE_KEY],
      byokSeeds: [
        {
          allowed_api_key_hashes: [firstCallerHash],
          key: "ak-first-only",
          name: "first-only",
          provider: "pippit",
        },
        {
          allowed_api_key_hashes: [secondCallerHash],
          key: "ak-second-only",
          name: "second-only",
          provider: "pippit",
        },
        { key: "ak-unrestricted", name: "unrestricted", provider: "pippit" },
        {
          allowed_api_key_hashes: [firstCallerHash],
          allowed_user_ids: ["server-user"],
          key: "ak-user-bound",
          name: "user-bound",
          provider: "pippit",
        },
      ],
    })
    const globalCredentials = (await harness.byokStore.list()).data
    const ids = new Map(globalCredentials.map((credential) => [credential.name, credential.id]))
    const firstId = ids.get("first-only")
    const secondId = ids.get("second-only")
    const unrestrictedId = ids.get("unrestricted")
    const userBoundId = ids.get("user-bound")
    if (
      firstId === undefined ||
      secondId === undefined ||
      unrestrictedId === undefined ||
      userBoundId === undefined
    ) {
      throw new Error("missing seeded caller-scoping credentials")
    }

    const firstList = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "GET",
      url: `/api/v1/byok?limit=100&offset=0&provider=pippit&facade_api_key_hash=${firstCallerHash}`,
    })
    const secondList = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "GET",
      url: `/api/v1/byok?limit=100&offset=0&provider=pippit&facade_api_key_hash=${secondCallerHash}`,
    })
    expect(firstList.json().data.map((credential: { name: string }) => credential.name)).toEqual([
      "first-only",
      "unrestricted",
    ])
    expect(firstList.json().total_count).toBe(2)
    expect(secondList.json().data.map((credential: { name: string }) => credential.name)).toEqual([
      "second-only",
      "unrestricted",
    ])
    expect(secondList.json().total_count).toBe(2)

    await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "PUT",
      payload: { credential_id: firstId, facade_api_key_hash: firstCallerHash },
      url: "/api/v1/byok/active",
    })

    const firstDeletesSecond = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "DELETE",
      url: `/api/v1/byok/${secondId}?facade_api_key_hash=${firstCallerHash}`,
    })
    const secondDeletesFirst = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "DELETE",
      url: `/api/v1/byok/${firstId}?facade_api_key_hash=${secondCallerHash}`,
    })
    const firstDeletesUserBound = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "DELETE",
      url: `/api/v1/byok/${userBoundId}?facade_api_key_hash=${firstCallerHash}`,
    })
    expect(firstDeletesSecond.statusCode).toBe(404)
    expect(secondDeletesFirst.statusCode).toBe(404)
    expect(firstDeletesUserBound.statusCode).toBe(404)
    expect((await harness.byokStore.list()).total_count).toBe(4)

    const blockedActiveDelete = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "DELETE",
      url: `/api/v1/byok/${firstId}?facade_api_key_hash=${firstCallerHash}`,
    })
    expect(blockedActiveDelete.statusCode).toBe(409)
    await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "PUT",
      payload: { credential_id: unrestrictedId, facade_api_key_hash: firstCallerHash },
      url: "/api/v1/byok/active",
    })
    const firstDeletesOwn = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "DELETE",
      url: `/api/v1/byok/${firstId}?facade_api_key_hash=${firstCallerHash}`,
    })
    const globalDeletesSecond = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "DELETE",
      url: `/api/v1/byok/${secondId}`,
    })
    expect(firstDeletesOwn.statusCode).toBe(200)
    expect(globalDeletesSecond.statusCode).toBe(200)
  })

  it("deletes a caller's sole active credential when other credentials belong to other callers", async () => {
    const firstCallerHash = sha256(FACADE_KEY)
    const secondCallerHash = sha256(SECOND_FACADE_KEY)
    const harness = createHarness({
      allowedFacadeKeys: [FACADE_KEY, SECOND_FACADE_KEY],
      byokSeeds: [
        {
          allowed_api_key_hashes: [firstCallerHash],
          key: "ak-first-private",
          name: "first-private",
          provider: "pippit",
        },
        {
          allowed_api_key_hashes: [secondCallerHash],
          key: "ak-second-private",
          name: "second-private",
          provider: "pippit",
        },
      ],
    })
    const credentials = (await harness.byokStore.list()).data
    const firstId = credentials.find((credential) => credential.name === "first-private")?.id
    if (firstId === undefined) throw new Error("missing first caller credential")

    const selected = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "PUT",
      payload: { credential_id: firstId, facade_api_key_hash: firstCallerHash },
      url: "/api/v1/byok/active",
    })
    expect(selected.statusCode).toBe(200)

    const deleted = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "DELETE",
      url: `/api/v1/byok/${firstId}?facade_api_key_hash=${firstCallerHash}`,
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toEqual({ deleted: true })

    const active = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "GET",
      url: `/api/v1/byok/active?facade_api_key_hash=${firstCallerHash}`,
    })
    const firstList = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "GET",
      url: `/api/v1/byok?facade_api_key_hash=${firstCallerHash}`,
    })
    const secondList = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "GET",
      url: `/api/v1/byok?facade_api_key_hash=${secondCallerHash}`,
    })
    expect(active.json()).toEqual({ data: null })
    expect(firstList.json()).toMatchObject({ data: [], total_count: 0 })
    expect(secondList.json().data.map((credential: { name: string }) => credential.name)).toEqual([
      "second-private",
    ])
  })

  it("gets, switches, and enforces caller-scoped active credentials", async () => {
    const firstCallerHash = sha256(FACADE_KEY)
    const secondCallerHash = sha256(SECOND_FACADE_KEY)
    const allowedHashes = [firstCallerHash, secondCallerHash]
    const harness = createHarness({
      allowedFacadeKeys: [FACADE_KEY, SECOND_FACADE_KEY],
      byokSeeds: [
        { allowed_api_key_hashes: allowedHashes, key: "ak-first", provider: "pippit" },
        { allowed_api_key_hashes: allowedHashes, key: "ak-second", provider: "pippit" },
      ],
    })
    const credentials = (await harness.byokStore.list()).data
    const firstId = credentials[0]?.id
    const secondId = credentials[1]?.id
    if (firstId === undefined || secondId === undefined) {
      throw new Error("missing seeded credentials")
    }

    const unselected = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "GET",
      url: `/api/v1/byok/active?facade_api_key_hash=${firstCallerHash}`,
    })
    expect(unselected.statusCode).toBe(200)
    expect(unselected.json()).toEqual({ data: null })

    const rejected = await harness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "PUT",
      payload: { credential_id: secondId, facade_api_key_hash: firstCallerHash },
      url: "/api/v1/byok/active",
    })
    expect(rejected.statusCode).toBe(401)

    const firstSelection = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "PUT",
      payload: { credential_id: secondId, facade_api_key_hash: firstCallerHash },
      url: "/api/v1/byok/active",
    })
    const secondSelection = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "PUT",
      payload: { credential_id: firstId, facade_api_key_hash: secondCallerHash },
      url: "/api/v1/byok/active",
    })
    expect(firstSelection.statusCode).toBe(200)
    expect(firstSelection.json().data).toMatchObject({
      credential_id: secondId,
      facade_api_key_hash: firstCallerHash,
    })
    expect(secondSelection.statusCode).toBe(200)

    expect((await createVideo(harness.app)).statusCode).toBe(202)
    expect((await createVideo(harness.app, SECOND_FACADE_KEY)).statusCode).toBe(202)
    const explicit = await harness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "POST",
      payload: {
        model: "pippit/seedance-2.0",
        prompt: "explicit credential wins",
        provider: { options: { pippit: { byok_id: firstId } } },
      },
      url: "/api/v1/videos",
    })
    expect(explicit.statusCode).toBe(202)
    expect(harness.pippit.submitRun.mock.calls.map(([input]) => input.accessKey)).toEqual([
      "ak-second",
      "ak-first",
      "ak-first",
    ])

    const blockedDelete = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "DELETE",
      url: `/api/v1/byok/${firstId}`,
    })
    expect(blockedDelete.statusCode).toBe(409)
    expect(blockedDelete.json().error.metadata.internal_code).toBe(
      "active_byok_delete_requires_switch",
    )

    await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "PUT",
      payload: { credential_id: secondId, facade_api_key_hash: secondCallerHash },
      url: "/api/v1/byok/active",
    })
    const deleted = await harness.app.inject({
      headers: bearer(MANAGEMENT_KEY),
      method: "DELETE",
      url: `/api/v1/byok/${firstId}`,
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toEqual({ deleted: true })
  })
})

describe("OpenRouter video facade", () => {
  it("publishes active-BYOK and localized-edit contracts in OpenAPI", async () => {
    const harness = createHarness()
    const response = await harness.app.inject({ method: "GET", url: "/openapi.json" })

    expect(response.statusCode).toBe(200)
    expect(response.json().paths["/api/v1/byok/active"]).toHaveProperty("put")
    expect(response.json().paths["/api/v1/byok"].get.parameters).toContainEqual({
      $ref: "#/components/parameters/OptionalFacadeApiKeyHash",
    })
    expect(response.json().paths["/api/v1/byok/{id}"].delete.parameters).toContainEqual({
      $ref: "#/components/parameters/OptionalFacadeApiKeyHash",
    })
    expect(response.json().paths["/api/v1/videos/edits"]).toHaveProperty("post")
    expect(response.json().components.parameters).not.toHaveProperty("IdempotencyKey")
    expect(response.json().components.schemas.VideoEditRequest.required).toEqual([
      "model",
      "segment",
      "source_job_id",
    ])
  })

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

  it("does not assign idempotency semantics to an unrelated HTTP header", async () => {
    const harness = createHarness()
    const request = {
      headers: { ...bearer(FACADE_KEY), "idempotency-key": "not-a-facade-contract" },
      method: "POST" as const,
      payload: { model: "pippit/seedance-2.0", prompt: "two intentional submissions" },
      url: "/api/v1/videos",
    }

    expect((await harness.app.inject(request)).statusCode).toBe(202)
    expect((await harness.app.inject(request)).statusCode).toBe(202)
    expect(harness.pippit.submitRun).toHaveBeenCalledTimes(2)
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

  it("regenerates from the complete source video with compiled guidance and derived duration", async () => {
    const harness = createHarness()
    const source = await createVideo(harness.app)
    const response = await harness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "POST",
      payload: {
        annotations: [
          {
            at_ms: 67_000,
            instruction: "Replace the sign with a blue logo",
            region: { height: 0.4, width: 0.3, x: 0.1, y: 0.2 },
          },
        ],
        model: "pippit/seedance-2.0",
        prompt: "Keep the original camera motion",
        resolution: "720p",
        segment: { end_ms: 72_400, start_ms: 60_000 },
        source_job_id: source.json().id,
      },
      url: "/api/v1/videos/edits",
    })

    expect(response.statusCode).toBe(202)
    expect(harness.loader.load.mock.calls[0]?.slice(0, 2)).toEqual([
      "https://cdn.test/result.mp4",
      "video",
    ])
    expect(harness.pippit.uploadFile).toHaveBeenCalledTimes(1)
    expect(harness.pippit.uploadFile.mock.calls[0]?.[0].accessKey).toBe(PIPPIT_ACCESS_KEY)
    const submitted = harness.submittedRequests.at(-1)
    expect(submitted?.video_part_tool_param.duration_sec).toBe(13)
    expect(submitted?.video_part_tool_param.videos).toEqual([{ pippit_asset_id: "asset-1" }])
    expect(submitted?.asset_ids).toEqual(["asset-1"])
    expect(submitted?.message).toBe(submitted?.video_part_tool_param.prompt)
    expect(submitted?.message).toContain("Pippit reference-guided video regeneration instruction v1.")
    expect(submitted?.message).toContain("The complete source video is attached as the only video reference.")
    expect(JSON.parse(submitted?.message.split("\n").at(-1) ?? "null")).toEqual({
      annotations: [
        {
          at_ms: 67_000,
          instruction: "Replace the sign with a blue logo",
          region: { height: 0.4, width: 0.3, x: 0.1, y: 0.2 },
        },
      ],
      instruction: "Keep the original camera motion",
      segment: { end_ms: 72_400, start_ms: 60_000 },
    })
  })

  it("rejects invalid edit metadata before querying or uploading the source", async () => {
    const harness = createHarness()
    const common = {
      model: "pippit/seedance-2.0",
      prompt: "edit",
      segment: { end_ms: 1_000, start_ms: 0 },
      source_job_id: "opaque-source-job",
    }
    const invalidPayloads = [
      { ...common, segment: { end_ms: 30_001, start_ms: 0 } },
      {
        ...common,
        annotations: [
          {
            at_ms: 500,
            instruction: "edit",
            region: { height: 0.5, width: 0.2, x: 0.9, y: 0 },
          },
        ],
      },
      {
        ...common,
        annotations: [
          {
            at_ms: 1_001,
            instruction: "edit",
            region: { height: 0.5, width: 0.5, x: 0, y: 0 },
          },
        ],
      },
      {
        model: common.model,
        segment: common.segment,
        source_job_id: common.source_job_id,
      },
    ]

    for (const payload of invalidPayloads) {
      const response = await harness.app.inject({
        headers: bearer(FACADE_KEY),
        method: "POST",
        payload,
        url: "/api/v1/videos/edits",
      })
      expect(response.statusCode).toBe(400)
    }
    expect(harness.pippit.queryVideoResult).not.toHaveBeenCalled()
    expect(harness.loader.load).not.toHaveBeenCalled()
    expect(harness.pippit.submitRun).not.toHaveBeenCalled()
  })

  it("rejects compiled edit instructions over the provider prompt limit", async () => {
    const harness = createHarness()
    const source = await createVideo(harness.app)
    const submittedBeforeEdit = harness.pippit.submitRun.mock.calls.length
    const response = await harness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "POST",
      payload: {
        annotations: Array.from({ length: 20 }, () => ({
          at_ms: 1_000,
          instruction: "x".repeat(1_000),
          region: { height: 0.5, width: 0.5, x: 0, y: 0 },
        })),
        model: "pippit/seedance-2.0",
        segment: { end_ms: 12_400, start_ms: 0 },
        source_job_id: source.json().id,
      },
      url: "/api/v1/videos/edits",
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().error.metadata.internal_code).toBe("edit_instruction_too_long")
    expect(harness.pippit.submitRun).toHaveBeenCalledTimes(submittedBeforeEdit)
    expect(harness.loader.load).not.toHaveBeenCalled()
    expect(harness.pippit.uploadFile).not.toHaveBeenCalled()
  })

  it("binds edit source jobs to the same facade caller", async () => {
    const harness = createHarness({ allowedFacadeKeys: [FACADE_KEY, SECOND_FACADE_KEY] })
    const source = await createVideo(harness.app)
    const response = await harness.app.inject({
      headers: bearer(SECOND_FACADE_KEY),
      method: "POST",
      payload: {
        model: "pippit/seedance-2.0",
        prompt: "edit",
        segment: { end_ms: 1_000, start_ms: 0 },
        source_job_id: source.json().id,
      },
      url: "/api/v1/videos/edits",
    })

    expect(response.statusCode).toBe(404)
    expect(harness.pippit.queryVideoResult).not.toHaveBeenCalled()
    expect(harness.loader.load).not.toHaveBeenCalled()
  })

  it("requires a completed source output at the requested index", async () => {
    const pendingHarness = createHarness({ queryState: 1 })
    const pendingSource = await createVideo(pendingHarness.app)
    const pending = await pendingHarness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "POST",
      payload: {
        model: "pippit/seedance-2.0",
        prompt: "edit",
        segment: { end_ms: 1_000, start_ms: 0 },
        source_job_id: pendingSource.json().id,
      },
      url: "/api/v1/videos/edits",
    })
    expect(pending.statusCode).toBe(400)
    expect(pending.json().error.metadata.internal_code).toBe("source_video_not_ready")
    expect(pendingHarness.loader.load).not.toHaveBeenCalled()

    const completedHarness = createHarness()
    const completedSource = await createVideo(completedHarness.app)
    const missing = await completedHarness.app.inject({
      headers: bearer(FACADE_KEY),
      method: "POST",
      payload: {
        model: "pippit/seedance-2.0",
        prompt: "edit",
        segment: { end_ms: 1_000, start_ms: 0 },
        source_index: 1,
        source_job_id: completedSource.json().id,
      },
      url: "/api/v1/videos/edits",
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.metadata.internal_code).toBe("source_video_output_not_found")
    expect(completedHarness.loader.load).not.toHaveBeenCalled()
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
