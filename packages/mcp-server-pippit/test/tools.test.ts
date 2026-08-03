import { access, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { MemoryIdempotencyStore } from "@pippit-bridge/core"
import { PippitFacadeError } from "../src/client.ts"
import {
  createPippitToolRuntime,
  getPippitToolDefinition,
  PIPPIT_RUNTIME_TOOL_NAMES,
  PIPPIT_TOOL_DEFINITIONS,
  PIPPIT_TOOL_DEFINITIONS_BY_NAME,
  type PippitFacadeBackend,
  type PippitFacadeManagementBackend,
} from "../src/tools.ts"

function backend(overrides: Partial<PippitFacadeBackend> = {}): PippitFacadeBackend {
  return {
    generateImage: async () => ({
      created: 1,
      data: [{ b64_json: "aW1hZ2U=" }],
      model: "pippit/seedream-5.0",
      usage: { cost: null, is_byok: true },
    }),
    listImageModels: async () => ({ data: [] }),
    downloadVideo: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } }),
    editVideo: async () => ({ id: "edit-1", polling_url: "/api/v1/videos/edit-1", status: "pending" }),
    generateVideo: async () => ({ id: "job-1", polling_url: "/api/v1/videos/job-1", status: "pending" }),
    getVideo: async () => ({ id: "job-1", polling_url: "/api/v1/videos/job-1", status: "completed" }),
    listVideoModels: async () => ({ data: [] }),
    ...overrides,
  }
}

describe("Pippit tool runtime", () => {
  it("publishes an exact-name canonical registry and hides management tools without management auth", () => {
    expect(PIPPIT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "pippit_list_image_models",
      "pippit_generate_image",
      "pippit_list_video_models",
      "pippit_generate_video",
      "pippit_get_video",
      "pippit_download_video",
      "pippit_edit_video_segment",
      "pippit_list_access_keys",
      "pippit_add_access_key",
      "pippit_switch_access_key",
      "pippit_delete_access_key",
    ])
    for (const tool of PIPPIT_TOOL_DEFINITIONS) {
      expect(Object.keys(tool.annotations).sort()).toEqual([
        "destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint", "title",
      ])
    }
    expect(PIPPIT_TOOL_DEFINITIONS.find((tool) => tool.name === "pippit_generate_video")?.annotations.idempotentHint).toBe(false)
    expect(PIPPIT_TOOL_DEFINITIONS_BY_NAME.pippit_edit_video_segment).toBe(
      getPippitToolDefinition("pippit_edit_video_segment"),
    )
    const runtime = createPippitToolRuntime({ client: backend(), outputRoot: "/tmp/pippit-test" })
    expect(runtime.listTools().map((tool) => tool.name)).toEqual(PIPPIT_RUNTIME_TOOL_NAMES)
    expect(PIPPIT_TOOL_DEFINITIONS_BY_NAME.pippit_generate_video.inputSchema.required).not.toContain("idempotency_key")
    expect(PIPPIT_TOOL_DEFINITIONS_BY_NAME.pippit_generate_video.inputSchema).toMatchObject({
      properties: { model: { default: "pippit/seedance-2.5" } },
    })
    expect(PIPPIT_TOOL_DEFINITIONS_BY_NAME.pippit_generate_image.inputSchema).toMatchObject({
      properties: { model: { default: "pippit/seedream-5.0" } },
    })
    expect(PIPPIT_TOOL_DEFINITIONS_BY_NAME.pippit_edit_video_segment.inputSchema).toMatchObject({
      properties: { model: { default: "pippit/seedance-2.0-vision" } },
    })
    expect(PIPPIT_TOOL_DEFINITIONS_BY_NAME.pippit_edit_video_segment.inputSchema.required).not.toContain("idempotency_key")
    expect(getPippitToolDefinition("pippit_add_access_key").inputSchema).toMatchObject({
      additionalProperties: false,
      properties: { account_name: expect.any(Object) },
      required: ["account_name"],
    })
  })

  it("applies governed image and video defaults when model is omitted", async () => {
    const generateImage = vi.fn(async () => ({
      created: 1,
      data: [{ b64_json: "aW1hZ2U=" }],
      model: "pippit/seedream-5.0",
      usage: { cost: null, is_byok: true },
    }))
    const editVideo = vi.fn(async () => ({ id: "edit-1", polling_url: "/poll", status: "pending" as const }))
    const generateVideo = vi.fn(async () => ({ id: "job-1", polling_url: "/poll", status: "pending" as const }))
    const runtime = createPippitToolRuntime({
      client: backend({ editVideo, generateImage, generateVideo }),
      outputRoot: "/tmp/pippit-test",
    })

    await runtime.callTool("pippit_generate_image", { prompt: "Default image" })
    await runtime.callTool("pippit_generate_video", { prompt: "Default video" })
    await runtime.callTool("pippit_edit_video_segment", {
      guidance_annotations: [],
      prompt: "Default edit",
      source_job_id: "source-job",
      time_range: { end_time_us: 4_000_000, start_time_us: 0 },
    })

    expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({ model: "pippit/seedream-5.0" }))
    expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({ model: "pippit/seedance-2.5" }))
    expect(editVideo).toHaveBeenCalledWith(expect.objectContaining({ model: "pippit/seedance-2.0-vision" }))
  })

  it("deduplicates exact submissions and rejects key reuse with another payload", async () => {
    const generateVideo = vi.fn(async () => ({ id: "job-1", polling_url: "/poll", status: "pending" as const }))
    const runtime = createPippitToolRuntime({ client: backend({ generateVideo }), outputRoot: "/tmp/pippit-test" })
    const first = { idempotency_key: "stable-key", model: "pippit/seedance-2.0-vision", prompt: "A comet" }
    await runtime.callTool("pippit_generate_video", first)
    await runtime.callTool("pippit_generate_video", first)
    expect(generateVideo).toHaveBeenCalledTimes(1)
    const conflict = await runtime.callTool("pippit_generate_video", { ...first, prompt: "A moon" })
    expect(conflict.isError).toBe(true)
  })

  it("does not require a recovery key or deduplicate ordinary repeated submissions", async () => {
    const generateVideo = vi.fn(async () => ({ id: "job-1", polling_url: "/poll", status: "pending" as const }))
    const runtime = createPippitToolRuntime({ client: backend({ generateVideo }), outputRoot: "/tmp/pippit-test" })
    const request = { model: "pippit/seedance-2.0-vision", prompt: "Generate this again intentionally" }

    await runtime.callTool("pippit_generate_video", request)
    await runtime.callTool("pippit_generate_video", request)

    expect(generateVideo).toHaveBeenCalledTimes(2)
  })

  it("validates Seedream settings and returns generated images as MCP image content", async () => {
    const generateImage = vi.fn(async () => ({
      created: 1_780_000_000,
      data: [{ b64_json: "aW1hZ2U=", media_type: "image/jpeg" }],
      model: "pippit/seedream-5.0-pro",
      usage: { cost: null, is_byok: true },
    }))
    const runtime = createPippitToolRuntime({ client: backend({ generateImage }), outputRoot: "/tmp/pippit-test" })
    const result = await runtime.callTool("pippit_generate_image", {
      byok_id: "cred-1",
      images: [{ image_url: { url: "https://example.test/reference.png" }, type: "image_url" }],
      model: "pippit/seedream-5.0-pro",
      n: 2,
      prompt: "Create a premium product poster",
      resolution: "4K",
      thread_id: "thread-1",
    })

    expect(generateImage).toHaveBeenCalledWith({
      input_references: [{ image_url: { url: "https://example.test/reference.png" }, type: "image_url" }],
      model: "pippit/seedream-5.0-pro",
      n: 2,
      prompt: "Create a premium product poster",
      provider: { options: { pippit: { byok_id: "cred-1", thread_id: "thread-1" } } },
      resolution: "4K",
    })
    expect(result.content).toEqual([
      {
        text: "Generated 1 image with pippit/seedream-5.0-pro. The inline result card displays the images and can reveal each persistent local file in Finder or the system file manager; do not regenerate when the user asks for the same file.",
        type: "text",
      },
      { data: "aW1hZ2U=", mimeType: "image/jpeg", type: "image" },
    ])
    expect(result.structuredContent).toEqual({
      created: 1_780_000_000,
      images: [{ media_type: "image/jpeg" }],
      model: "pippit/seedream-5.0-pro",
      usage: { cost: null, is_byok: true },
    })

    await expect(runtime.callTool("pippit_generate_image", {
      model: "pippit/seedream-5.0",
      prompt: "invalid resolution",
      resolution: "2K",
    })).resolves.toMatchObject({ isError: true })
    expect(generateImage).toHaveBeenCalledTimes(1)
  })

  it("replays an explicit recovery key from the MCP-owned durable store", async () => {
    const generateVideo = vi.fn(async () => ({ id: "job-recovered", polling_url: "/poll", status: "pending" as const }))
    const client = backend({ generateVideo })
    const idempotencyStore = new MemoryIdempotencyStore({ hmacKey: Buffer.alloc(32, 4) })
    const options = { client, idempotencyScope: "facade-identity", idempotencyStore, outputRoot: "/tmp/pippit-test" }
    const request = { idempotency_key: "recover-this-call", model: "pippit/seedance-2.0-vision", prompt: "Recover me" }

    await createPippitToolRuntime(options).callTool("pippit_generate_video", request)
    await createPippitToolRuntime(options).callTool("pippit_generate_video", request)

    expect(generateVideo).toHaveBeenCalledTimes(1)
  })

  it("records the sanitized upstream operation for a definitive failed submission", async () => {
    const editVideo = vi.fn(async () => {
      throw new PippitFacadeError({
        code: "HTTP_ERROR",
        message: "Pippit facade rejected edit_video_segment with HTTP 502.",
        operation: "edit_video_segment",
        status: 502,
        upstreamCode: "VIDEO.MODEL-42",
        upstreamLogId: "20260722163045A1B2C3D4E5F6071829AB",
        upstreamOperation: "submit_run",
      })
    })
    const idempotencyStore = new MemoryIdempotencyStore({ hmacKey: Buffer.alloc(32, 9) })
    const options = {
      client: backend({ editVideo }),
      idempotencyScope: "facade-identity",
      idempotencyStore,
      outputRoot: "/tmp/pippit-test",
    }
    const request = {
      guidance_annotations: [{
        at_time_us: 0,
        instruction: "Change the style",
        region: { height: 1, width: 1, x: 0, y: 0 },
      }],
      idempotency_key: "failed-edit",
      model: "pippit/seedance-2.5",
      source_job_id: "source-job",
      time_range: { end_time_us: 5_000_000, start_time_us: 0 },
    }

    const failed = await createPippitToolRuntime(options).callTool("pippit_edit_video_segment", request)
    expect(failed.structuredContent).toEqual({
      error: {
        code: "HTTP_ERROR",
        message: "Pippit facade rejected edit_video_segment with HTTP 502.",
        operation: "edit_video_segment",
        status: 502,
        upstream_code: "VIDEO.MODEL-42",
        upstream_log_id: "20260722163045A1B2C3D4E5F6071829AB",
        upstream_operation: "submit_run",
      },
    })
    const replay = await createPippitToolRuntime(options).callTool("pippit_edit_video_segment", request)

    expect(replay.content).toEqual([{
      text: "The previous recovery request failed (http_error_submit_run_code_video_model_42_logid_20260722163045a1b2c3d4e5f6071829ab).",
      type: "text",
    }])
    expect(editVideo).toHaveBeenCalledTimes(1)
  })

  it("attaches the composite runtime identity to success and visible failure results", async () => {
    const runtimeIdentity = {
      facadeArtifactSha256: "f".repeat(64),
      gatewayArtifactSha256: "a".repeat(64),
      stamp: "gaaaaaaaaaa/wbbbbbbbbbb/ffffffffff",
      workerArtifactSha256: "b".repeat(64),
      workerGeneration: "generation-1",
    }
    const failedBackend = backend({
      generateVideo: async () => {
        throw new PippitFacadeError({
          code: "HTTP_ERROR",
          message: "Pippit returned HTTP 502.",
          operation: "generate_video",
          status: 502,
          upstreamLogId: "20260730174415A1B2C3D4E5F6071829AB",
        })
      },
    })
    const success = await createPippitToolRuntime({
      client: backend(),
      outputRoot: "/tmp/pippit-test",
      runtimeIdentity,
    }).callTool("pippit_list_video_models", {})
    const failed = await createPippitToolRuntime({
      client: failedBackend,
      outputRoot: "/tmp/pippit-test",
      runtimeIdentity,
    }).callTool("pippit_generate_video", { prompt: "test" })

    expect(success._meta?.["pippit/runtime"]).toMatchObject({
      facade_artifact_sha256: "f".repeat(64),
      gateway_artifact_sha256: "a".repeat(64),
      stamp: runtimeIdentity.stamp,
      worker_artifact_sha256: "b".repeat(64),
      worker_generation: "generation-1",
    })
    expect(failed.content[0]).toMatchObject({
      text: expect.stringContaining(`Internal version: ${runtimeIdentity.stamp}`),
    })
    expect(failed.structuredContent).toMatchObject({
      error: {
        internal_version: runtimeIdentity.stamp,
        upstream_log_id: "20260730174415A1B2C3D4E5F6071829AB",
      },
    })
  })

  it("rejects mixed frame and general references", async () => {
    const runtime = createPippitToolRuntime({ client: backend(), outputRoot: "/tmp/pippit-test" })
    const result = await runtime.callTool("pippit_generate_video", {
      frame_images: [{ frame_type: "first_frame", image_url: { url: "https://example.test/first.png" }, type: "image_url" }],
      idempotency_key: "key",
      input_references: [{ image_url: { url: "https://example.test/ref.png" }, type: "image_url" }],
      model: "pippit/seedance-2.0-vision",
      prompt: "Move",
    })
    expect(result.isError).toBe(true)
  })

  it("validates, maps, and deduplicates segment edits", async () => {
    const editVideo = vi.fn(async () => ({ id: "edit-1", polling_url: "/poll/edit-1", status: "pending" as const }))
    const runtime = createPippitToolRuntime({ client: backend({ editVideo }), outputRoot: "/tmp/pippit-test" })
    const valid = {
      guidance_annotations: [{
        at_time_us: 14_000_000,
        instruction: "Change the character to black",
        region: { height: 0.5, width: 0.4, x: 0.2, y: 0.1 },
      }],
      byok_id: "cred-1",
      idempotency_key: "edit-key",
      model: "pippit/seedance-2.5",
      prompt: "Keep the motion",
      resolution: "1080p",
      seed: 7,
      source_index: 1,
      source_job_id: "source-job",
      thread_id: "thread-1",
      time_range: { end_time_us: 30_000_000, start_time_us: 0 },
    }
    await runtime.callTool("pippit_edit_video_segment", valid)
    await runtime.callTool("pippit_edit_video_segment", valid)
    expect(editVideo).toHaveBeenCalledTimes(1)
    expect(editVideo).toHaveBeenCalledWith({
      guidance_annotations: valid.guidance_annotations,
      model: valid.model,
      prompt: valid.prompt,
      provider: { options: { pippit: { byok_id: "cred-1", thread_id: "thread-1" } } },
      resolution: "1080p",
      seed: 7,
      source_index: 1,
      source_job_id: "source-job",
      time_range: valid.time_range,
    })

    const invalidInputs = [
      { ...valid, idempotency_key: "empty-range", time_range: { end_time_us: 0, start_time_us: 0 } },
      { ...valid, guidance_annotations: [{ ...valid.guidance_annotations[0], at_time_us: 31_000_000 }], idempotency_key: "time" },
      { ...valid, guidance_annotations: [{ ...valid.guidance_annotations[0], region: { height: 0.5, width: 0.6, x: 0.5, y: 0 } }], idempotency_key: "roi" },
      { ...valid, guidance_annotations: [], idempotency_key: "empty", prompt: undefined },
    ]
    for (const input of invalidInputs) {
      await expect(runtime.callTool("pippit_edit_video_segment", input)).resolves.toMatchObject({ isError: true })
    }
    expect(editVideo).toHaveBeenCalledTimes(1)
  })

  it("exposes and dispatches four management tools only when configured", async () => {
    const management: PippitFacadeManagementBackend = {
      addAccessKey: vi.fn(),
      deleteAccessKey: vi.fn(async (credentialId: string) => ({ credential_id: credentialId, deleted: true as const })),
      listAccessKeys: vi.fn(async () => ({
        data: [{ account_name: "work", active: true, credential_id: "cred-1", disabled: false, label: "ak-****" }],
        total_count: 1,
      })),
      switchAccessKey: vi.fn(async (credentialId: string) => ({
        active: true as const,
        credential_id: credentialId,
        updated_at: "2026-07-18T00:00:00.000Z",
      })),
    }
    const enrollmentServer = {
      close: vi.fn(async () => undefined),
      createEnrollment: vi.fn(async (accountName: string) => ({
        account_name: accountName,
        enrollment_url: "http://127.0.0.1:1234/enroll/abcdefghijklmnopqrstuvwxyzABCDEF",
        expires_at: "2026-07-18T00:05:00.000Z",
      })),
    }
    const runtime = createPippitToolRuntime({
      client: backend(),
      enrollmentServer,
      managementClient: management,
      outputRoot: "/tmp/pippit-test",
    })
    expect(runtime.listTools()).toHaveLength(11)
    expect((await runtime.callTool("pippit_list_access_keys", {})).isError).toBeUndefined()
    expect((await runtime.callTool("pippit_add_access_key", { account_name: "personal" })).isError).toBeUndefined()
    expect(enrollmentServer.createEnrollment).toHaveBeenCalledWith("personal")
    await expect(runtime.callTool("pippit_add_access_key", { account_name: "personal", access_key: "must-not-enter-tools" })).resolves.toMatchObject({ isError: true })
    expect((await runtime.callTool("pippit_switch_access_key", { credential_id: "cred-2" })).isError).toBeUndefined()
    await expect(runtime.callTool("pippit_delete_access_key", { credential_id: "cred-2", confirm: false })).resolves.toMatchObject({ isError: true })
    expect((await runtime.callTool("pippit_delete_access_key", { credential_id: "cred-2", confirm: true })).isError).toBeUndefined()
    await runtime.close?.()
    expect(enrollmentServer.close).toHaveBeenCalledOnce()
  })

  it("downloads beneath the output root and never overwrites", async () => {
    const root = await mkdtemp(join(tmpdir(), "pippit-mcp-"))
    try {
      const runtime = createPippitToolRuntime({ client: backend(), outputRoot: root })
      const input = { job_id: "job-1", output_path: "clips/result.mp4" }
      const first = await runtime.callTool("pippit_download_video", input)
      expect(first.isError).toBeUndefined()
      await expect(readFile(join(root, "clips/result.mp4"))).resolves.toEqual(Buffer.from([1, 2, 3]))
      const second = await runtime.callTool("pippit_download_video", input)
      expect(second.isError).toBe(true)
      const traversal = await runtime.callTool("pippit_download_video", { job_id: "job-1", output_path: "../escape.mp4" })
      expect(traversal.isError).toBe(true)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rejects a symlinked output parent before creating anything outside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pippit-mcp-root-"))
    const outside = await mkdtemp(join(tmpdir(), "pippit-mcp-outside-"))
    try {
      await symlink(outside, join(root, "linked"), "dir")
      const runtime = createPippitToolRuntime({ client: backend(), outputRoot: root })
      const result = await runtime.callTool("pippit_download_video", {
        job_id: "job-1",
        output_path: "linked/nested/result.mp4",
      })
      expect(result.isError).toBe(true)
      await expect(access(join(outside, "nested"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(root, { force: true, recursive: true })
      await rm(outside, { force: true, recursive: true })
    }
  })
})
