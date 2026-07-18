import { describe, expect, it, vi } from "vitest"
import { VIDEO_MODELS } from "@pippit-bridge/core"
import type { Config } from "@opencode-ai/plugin"
import pluginModule from "../src/index.js"
import { PippitPlugin } from "../src/plugin.js"

function accepts(schema: unknown, value: unknown): boolean {
  if (typeof schema !== "object" || schema === null || !("safeParse" in schema)) return false
  return (schema as { safeParse(input: unknown): { success: boolean } }).safeParse(value).success
}

describe("Pippit OpenCode plugin", () => {
  it("uses the current PluginModule format with a stable plugin id", () => {
    expect(pluginModule.id).toBe("pippit.opencode-provider")
    expect(pluginModule.server).toBe(PippitPlugin)
  })

  it("registers auth and media tools without advertising a fake language model", async () => {
    const hooks = await PippitPlugin({} as never)
    const config = {} as Config

    await hooks.config?.(config)

    expect(hooks.auth?.provider).toBe("pippit")
    expect(Object.keys(hooks.tool ?? {})).toEqual(["pippit_generate_video", "pippit_get_video"])
    expect(config.provider?.pippit).toMatchObject({
      env: ["PIPPIT_ACCESS_KEY"],
      models: {},
      name: "Pippit (小云雀 media tools)",
    })
  })

  it("only exposes website one-click auth when official endpoints are configured", async () => {
    const hooks = await PippitPlugin({} as never, {
      deviceAuthorization: {
        authorizationURL: "https://xyq.jianying.com/developer/ak/device_authorization",
        tokenURL: "https://xyq.jianying.com/developer/ak/token",
      },
    })

    expect(hooks.auth?.methods.map((method) => method.type)).toEqual(["oauth", "api"])
  })

  it("derives geometry choices from the shared model catalog", async () => {
    const hooks = await PippitPlugin({} as never)
    const args = hooks.tool?.pippit_generate_video?.args

    for (const model of VIDEO_MODELS) {
      expect(accepts(args?.model, model.id)).toBe(true)
      for (const aspectRatio of model.supported_aspect_ratios ?? []) {
        expect(accepts(args?.aspect_ratio, aspectRatio)).toBe(true)
      }
      for (const resolution of model.supported_resolutions ?? []) {
        expect(accepts(args?.resolution, resolution)).toBe(true)
      }
    }
  })

  it("asks before a default get operation writes a video into the worktree", async () => {
    const hooks = await PippitPlugin({} as never)
    const execute = hooks.tool?.pippit_get_video?.execute
    if (execute === undefined) throw new Error("Expected the Pippit get tool")
    const ask = vi.fn(async () => {
      throw new Error("permission denied")
    })

    await expect(
      execute(
        {
          download: true,
          max_wait_seconds: 900,
          run_id: "run-1",
          thread_id: "thread-1",
          wait_for_completion: false,
        },
        { ask } as never,
      ),
    ).rejects.toThrow("permission denied")
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        always: [],
        metadata: expect.objectContaining({
          output_directory: ".pippit/outputs",
          run_id: "run-1",
          target_origin: "https://xyq.jianying.com",
        }),
        permission: "pippit_download_video",
      }),
    )
  })
})
