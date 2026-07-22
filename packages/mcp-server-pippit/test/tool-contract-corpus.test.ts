import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WIDGET_MCP_INPUT_CONTRACTS } from "@pippit-bridge/contracts"
import {
  createPippitToolRuntime,
  type PippitFacadeBackend,
  type PippitFacadeManagementBackend,
  type PippitToolDefinition,
} from "../src/tools.ts"
import { withWidgetRuntime } from "../src/stdio/widget-runtime.ts"
import type { PippitWidgetMediaServer } from "../src/widget-media.ts"

const roots = new Set<string>()
afterEach(async () => Promise.all([...roots].map(async root => {
  roots.delete(root)
  await rm(root, { force: true, recursive: true })
})))

function backend(): PippitFacadeBackend {
  return {
    generateImage: vi.fn(async () => ({
      created: 1,
      data: [{ b64_json: "aW1hZ2U=" }],
      model: "pippit/seedream-5.0",
      usage: { cost: null, is_byok: true },
    })),
    listImageModels: vi.fn(async () => ({ data: [] })),
    downloadVideo: vi.fn(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "video/mp4" } })),
    editVideo: vi.fn(async () => ({ id: "edit", polling_url: "/edit", status: "pending" as const })),
    generateVideo: vi.fn(async () => ({ id: "job", polling_url: "/job", status: "pending" as const })),
    getVideo: vi.fn(async () => ({ id: "job", polling_url: "/job", status: "completed" as const })),
    listVideoModels: vi.fn(async () => ({ data: [] })),
  }
}

function management(): PippitFacadeManagementBackend {
  return {
    addAccessKey: vi.fn(async () => ({ account_name: "primary", active: false, credential_id: "cred", disabled: false, label: "ak_…test" })),
    deleteAccessKey: vi.fn(async credential_id => ({ credential_id, deleted: true as const })),
    listAccessKeys: vi.fn(async () => ({ data: [], total_count: 0 })),
    switchAccessKey: vi.fn(async credential_id => ({ active: true as const, credential_id, updated_at: "2026-07-21T00:00:00.000Z" })),
  }
}

describe("MCP contract/runtime corpus", () => {
  it("runs every published MCP tool through the same accepted and rejected inputs", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "pippit-tool-corpus-"))
    roots.add(outputRoot)
    const client = backend()
    const managementClient = management()
    const runtime = createPippitToolRuntime({
      client,
      enrollmentServer: {
        close: vi.fn(async () => undefined),
        createEnrollment: vi.fn(async account_name => ({
          account_name,
          enrollment_url: "http://127.0.0.1/enroll",
          expires_at: "2026-07-21T00:05:00.000Z",
        })),
      },
      managementClient,
      outputRoot,
    })
    const corpus = [
      ["pippit_list_image_models", {}, { extra: true }],
      ["pippit_generate_image", { model: "pippit/seedream-5.0", prompt: "paint" }, { model: "pippit/seedream-5.0", prompt: "paint", resolution: "2K" }],
      ["pippit_list_video_models", {}, { extra: true }],
      ["pippit_generate_video", { model: "pippit/seedance-2.0", prompt: "go" }, { model: "x", prompt: "go", extra: true }],
      ["pippit_get_video", { job_id: "job" }, { job_id: "" }],
      ["pippit_download_video", { job_id: "job", output_path: "clip.mp4" }, { job_id: "job", output_path: "../clip.mp4" }],
      ["pippit_edit_video_segment", {
        annotations: [{ at_ms: 10, instruction: "change", region: { height: 0.2, width: 0.2, x: 0, y: 0 } }],
        model: "pippit/seedance-2.0",
        segment: { end_ms: 100, start_ms: 0 },
        source_job_id: "job",
      }, {
        annotations: [],
        model: "pippit/seedance-2.0",
        segment: { end_ms: 100, start_ms: 0 },
        source_job_id: "job",
      }],
      ["pippit_list_access_keys", {}, { extra: true }],
      ["pippit_add_access_key", { account_name: "primary" }, { account_name: "" }],
      ["pippit_switch_access_key", { credential_id: "cred" }, { credential_id: "" }],
      ["pippit_delete_access_key", { confirm: true, credential_id: "cred" }, { confirm: false, credential_id: "cred" }],
    ] as const

    for (const [name, accepted, rejected] of corpus) {
      await expect(runtime.callTool(name, accepted)).resolves.not.toMatchObject({ isError: true })
      await expect(runtime.callTool(name, rejected)).resolves.toMatchObject({ isError: true })
    }
    expect(client.generateImage).toHaveBeenCalledWith(expect.objectContaining({ n: 1 }))
    await runtime.close?.()
  })

  it("runs every app-visible Widget tool through accepted and rejected inputs", async () => {
    const base = {
      callTool: vi.fn(async () => ({ content: [] })),
      listTools: () => [],
    }
    const media = {
      close: vi.fn(async () => undefined),
      listResources: vi.fn(async () => ({})),
      listResourceTemplates: vi.fn(async () => ({})),
      preparePreview: vi.fn(async () => ({
        bytes: 1,
        filename: "video.mp4",
        localPath: "/private/video.mp4",
        resourceUri: `pippit-video://artifact/${"a".repeat(64)}`,
      })),
      readChunk: vi.fn(async () => undefined),
      readImage: vi.fn(async () => undefined),
      readResource: vi.fn(async () => undefined),
      revealImage: vi.fn(async () => false),
    } satisfies PippitWidgetMediaServer
    const runtime = withWidgetRuntime(base, media, {
      record: vi.fn(async () => undefined),
      resolve: vi.fn(async anchor => anchor),
      track: vi.fn(),
    })
    const imageUri = `pippit-image://artifact/${"b".repeat(64)}.png`
    const videoUri = `pippit-video://artifact/${"c".repeat(64)}`
    const corpus = [
      ["pippit_get_image", { image_job_id: `pimg_${"a".repeat(32)}` }, { image_job_id: "bad" }],
      ["pippit_read_image", { resource_uri: imageUri }, { resource_uri: "https://example.test/image.png" }],
      ["pippit_reveal_image", { resource_uri: imageUri }, { resource_uri: `${imageUri}?secret=1` }],
      ["pippit_read_video_chunk", { length: 1, offset: 0, resource_uri: videoUri }, { length: 1, offset: 0, resource_uri: "https://example.test/video.mp4" }],
      ["pippit_resolve_latest_video", { anchor_job_id: "job" }, { anchor_job_id: " " }],
    ] as const
    const definitions = new Map<string, PippitToolDefinition>(
      runtime.listTools().map(definition => [definition.name, definition]),
    )
    for (const [name, accepted, rejected] of corpus) {
      const contract = WIDGET_MCP_INPUT_CONTRACTS[name]
      const { $schema: _schemaDialect, ...projected } = contract.toJsonSchema()
      expect(definitions.get(name)?.inputSchema, name).toEqual(projected)
      expect(() => contract.parse(accepted), name).not.toThrow()
      expect(() => contract.parse(rejected), name).toThrow()
      const acceptedResult = await runtime.callTool(name, accepted)
      expect(acceptedResult.structuredContent).not.toMatchObject({ error: { code: "invalid_arguments" } })
      const rejectedResult = await runtime.callTool(name, rejected)
      expect(rejectedResult).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "invalid_arguments" } },
      })
    }
    await runtime.close?.()
  })
})
