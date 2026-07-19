import { access, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
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
    expect(getPippitToolDefinition("pippit_add_access_key").inputSchema).toMatchObject({
      additionalProperties: false,
      properties: { account_name: expect.any(Object) },
      required: ["account_name"],
    })
  })

  it("deduplicates exact submissions and rejects key reuse with another payload", async () => {
    const generateVideo = vi.fn(async () => ({ id: "job-1", polling_url: "/poll", status: "pending" as const }))
    const runtime = createPippitToolRuntime({ client: backend({ generateVideo }), outputRoot: "/tmp/pippit-test" })
    const first = { idempotency_key: "stable-key", model: "pippit/seedance-2.0", prompt: "A comet" }
    await runtime.callTool("pippit_generate_video", first)
    await runtime.callTool("pippit_generate_video", first)
    expect(generateVideo).toHaveBeenCalledTimes(1)
    const conflict = await runtime.callTool("pippit_generate_video", { ...first, prompt: "A moon" })
    expect(conflict.isError).toBe(true)
  })

  it("rejects mixed frame and general references", async () => {
    const runtime = createPippitToolRuntime({ client: backend(), outputRoot: "/tmp/pippit-test" })
    const result = await runtime.callTool("pippit_generate_video", {
      frame_images: [{ frame_type: "first_frame", image_url: { url: "https://example.test/first.png" }, type: "image_url" }],
      idempotency_key: "key",
      input_references: [{ image_url: { url: "https://example.test/ref.png" }, type: "image_url" }],
      model: "pippit/seedance-2.0",
      prompt: "Move",
    })
    expect(result.isError).toBe(true)
  })

  it("validates, maps, and deduplicates segment edits", async () => {
    const editVideo = vi.fn(async () => ({ id: "edit-1", polling_url: "/poll/edit-1", status: "pending" as const }))
    const runtime = createPippitToolRuntime({ client: backend({ editVideo }), outputRoot: "/tmp/pippit-test" })
    const valid = {
      annotations: [{
        at_ms: 14_000,
        instruction: "Change the character to black",
        region: { height: 0.5, width: 0.4, x: 0.2, y: 0.1 },
      }],
      byok_id: "cred-1",
      idempotency_key: "edit-key",
      model: "pippit/seedance-2.0",
      prompt: "Keep the motion",
      resolution: "1080p",
      seed: 7,
      segment: { end_ms: 30_000, start_ms: 0 },
      source_index: 1,
      source_job_id: "source-job",
      thread_id: "thread-1",
    }
    await runtime.callTool("pippit_edit_video_segment", valid)
    await runtime.callTool("pippit_edit_video_segment", valid)
    expect(editVideo).toHaveBeenCalledTimes(1)
    expect(editVideo).toHaveBeenCalledWith({
      annotations: valid.annotations,
      model: valid.model,
      prompt: valid.prompt,
      provider: { options: { pippit: { byok_id: "cred-1", thread_id: "thread-1" } } },
      resolution: "1080p",
      seed: 7,
      segment: valid.segment,
      source_index: 1,
      source_job_id: "source-job",
    })

    const invalidInputs = [
      { ...valid, idempotency_key: "long", segment: { end_ms: 30_001, start_ms: 0 } },
      { ...valid, annotations: [{ ...valid.annotations[0], at_ms: 31_000 }], idempotency_key: "time" },
      { ...valid, annotations: [{ ...valid.annotations[0], region: { height: 0.5, width: 0.6, x: 0.5, y: 0 } }], idempotency_key: "roi" },
      { ...valid, annotations: [], idempotency_key: "empty", prompt: undefined },
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
    expect(runtime.listTools()).toHaveLength(9)
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
