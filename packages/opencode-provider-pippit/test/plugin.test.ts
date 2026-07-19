import { afterEach, describe, expect, it, vi } from "vitest"
import { VIDEO_MODELS } from "@pippit-bridge/core"
import type { Config } from "@opencode-ai/plugin"
import { MemoryPippitAccountStore, PippitAccountManager } from "../src/account-store.js"
import { PIPPIT_MANAGED_AUTH_SENTINEL } from "../src/access-key.js"
import pluginModule from "../src/index.js"
import { createPippitPlugin, PippitPlugin } from "../src/plugin.js"

afterEach(() => {
  vi.unstubAllEnvs()
})

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
    expect(Object.keys(hooks.tool ?? {})).toEqual([
      "pippit_manage_access_keys",
      "pippit_generate_video",
      "pippit_get_video",
    ])
    expect(hooks.tool?.pippit_manage_access_keys?.args).not.toHaveProperty("access_key")
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

  it("configures, lists, switches, and deletes multiple accounts without exposing raw AKs", async () => {
    const accounts = new PippitAccountManager(new MemoryPippitAccountStore())
    const setAuth = vi.fn(async () => ({ data: true }))
    const hooks = await createPippitPlugin({ accounts })({
      client: { auth: { set: setAuth }, provider: { list: vi.fn(async () => ({ data: {} })) } },
    } as never)
    const manage = hooks.tool?.pippit_manage_access_keys?.execute
    if (manage === undefined) throw new Error("Expected the Pippit access-key management tool")
    const context = { ask: vi.fn(async () => undefined), metadata: vi.fn() }

    const firstAuth = {
      key: "ak-work-account-secret",
      type: "api",
    } as const
    const secondAuth = {
      key: "ak-personal-account-secret",
      type: "api",
    } as const
    await manage({ account_name: "工作", operation: "configure" }, context as never)
    await hooks.auth?.loader?.(async () => firstAuth, {} as never)
    await manage({ account_name: "个人", operation: "configure" }, context as never)
    await hooks.auth?.loader?.(async () => secondAuth, {} as never)

    vi.stubEnv("PIPPIT_ACCESS_KEY", "ak-ci-override-never-returned")
    const configure = await manage(
      { account_name: "新账号", operation: "configure" },
      context as never,
    )
    expect(JSON.stringify(configure)).toContain("https://xyq.jianying.com")
    expect(JSON.stringify(configure)).toContain("页面顶部签发 AK")
    expect(JSON.stringify(configure)).toContain("/connect")
    expect(JSON.stringify(configure)).toContain("PIPPIT_ACCESS_KEY")

    const listed = await manage({ operation: "list" }, context as never)
    const serializedList = JSON.stringify(listed)
    expect(serializedList).toContain("工作")
    expect(serializedList).toContain("个人")
    expect(serializedList).not.toContain(firstAuth.key)
    expect(serializedList).not.toContain(secondAuth.key)
    expect(serializedList).not.toContain("ak-ci-override-never-returned")
    expect(serializedList).toContain("PIPPIT_ACCESS_KEY")

    const accountList = await accounts.list()
    const work = accountList.accounts.find((account) => account.name === "工作")
    const personal = accountList.accounts.find((account) => account.name === "个人")
    if (work === undefined || personal === undefined) throw new Error("Expected two accounts")
    const switched = await manage({ account_id: work.id, operation: "switch" }, context as never)
    const deleted = await manage({ account_id: personal.id, operation: "delete" }, context as never)
    expect(JSON.parse(typeof switched === "string" ? switched : switched.output)).toMatchObject({
      active_account: { account_id: work.id, active: true },
      environment_override: "PIPPIT_ACCESS_KEY",
    })
    expect(JSON.parse(typeof deleted === "string" ? deleted : deleted.output)).toMatchObject({
      bound_run_count: 0,
      deleted_account: { account_id: personal.id, active: false },
      environment_override: "PIPPIT_ACCESS_KEY",
      official_url: "https://xyq.jianying.com",
    })
    expect(JSON.stringify(deleted)).not.toContain(secondAuth.key)
    expect(JSON.stringify(deleted)).not.toContain("ak-ci-override-never-returned")
    await expect(accounts.resolveActive()).resolves.toMatchObject({ accountId: work.id })
    expect(context.ask).toHaveBeenCalledTimes(2)
    expect(setAuth).toHaveBeenCalledWith({
      body: {
        key: PIPPIT_MANAGED_AUTH_SENTINEL,
        metadata: { managed_account_store: "v1" },
        type: "api",
      },
      path: { id: "pippit" },
    })
  })

  it("synchronizes an existing OpenCode credential before starting a pending configuration", async () => {
    const accounts = new PippitAccountManager(new MemoryPippitAccountStore())
    const existingAuth = { key: "ak-existing-before-manager", type: "api" } as const
    let loadExisting: (() => Promise<void>) | undefined
    const providerList = vi.fn(async () => {
      await loadExisting?.()
      return { data: {} }
    })
    const hooks = await createPippitPlugin({ accounts })({
      client: { provider: { list: providerList } },
    } as never)
    loadExisting = async () => {
      await hooks.auth?.loader?.(async () => existingAuth, {} as never)
    }
    const manage = hooks.tool?.pippit_manage_access_keys?.execute
    if (manage === undefined) throw new Error("Expected the Pippit access-key management tool")

    await manage(
      { account_name: "新账号", operation: "configure" },
      { ask: vi.fn(), metadata: vi.fn() } as never,
    )

    expect(providerList).toHaveBeenCalledTimes(1)
    const listed = await accounts.list()
    expect(listed.accounts).toHaveLength(1)
    expect(listed.pendingAccountName).toBe("新账号")
    expect(JSON.stringify(listed)).not.toContain(existingAuth.key)
  })

  it("validates account selectors before permission and preserves the account when auth scrub fails", async () => {
    const accounts = new PippitAccountManager(new MemoryPippitAccountStore())
    const storedAuth = { key: "ak-preserved-after-scrub-error", type: "api" } as const
    await accounts.beginConfiguration("工作", undefined)
    const account = await accounts.reconcile(storedAuth)
    if (account === undefined) throw new Error("Expected a managed account")
    const hooks = await createPippitPlugin({ accounts })({
      client: {
        auth: { set: vi.fn(async () => ({ error: { message: "write failed" } })) },
        provider: { list: vi.fn(async () => ({ data: {} })) },
      },
    } as never)
    await hooks.auth?.loader?.(async () => storedAuth, {} as never)
    const manage = hooks.tool?.pippit_manage_access_keys?.execute
    if (manage === undefined) throw new Error("Expected the Pippit access-key management tool")
    const ask = vi.fn(async () => undefined)
    const context = { ask, metadata: vi.fn() }

    await expect(manage({ operation: "switch" }, context as never)).rejects.toThrow(
      "Provide exactly one",
    )
    await expect(
      manage({ account_name: "hidden\u202ename", operation: "switch" }, context as never),
    ).rejects.toThrow("visible characters")
    expect(ask).not.toHaveBeenCalled()

    await expect(
      manage({ account_id: account.id, operation: "delete" }, context as never),
    ).rejects.toThrow("local Pippit account was preserved")
    await expect(accounts.resolveActive()).resolves.toMatchObject({ accountId: account.id })
  })

  it("returns a successful paid submission even when local account binding persistence fails", async () => {
    const accounts = new PippitAccountManager(new MemoryPippitAccountStore())
    await accounts.beginConfiguration("工作", undefined)
    const account = await accounts.reconcile({ key: "ak-billing-safe-secret", type: "api" })
    if (account === undefined) throw new Error("Expected a managed account")
    vi.spyOn(accounts, "bindRun").mockRejectedValueOnce(new Error("disk full"))
    const generate = vi.fn(async () => ({
      model: "pippit/seedance-2.0",
      runId: "run-paid-once",
      status: "pending" as const,
      threadId: "thread-paid-once",
    }))
    const hooks = await createPippitPlugin({
      accounts,
      videos: {
        generate,
        get: vi.fn(async () => ({
          runId: "unused-run",
          status: "pending" as const,
          threadId: "unused-thread",
        })),
      },
    })({} as never)
    const execute = hooks.tool?.pippit_generate_video?.execute
    if (execute === undefined) throw new Error("Expected the Pippit generate tool")

    const result = await execute(
      {
        max_wait_seconds: 43_200,
        model: "pippit/seedance-2.0",
        prompt: "只提交一次",
        wait_for_completion: false,
      },
      {
        abort: new AbortController().signal,
        ask: vi.fn(async () => undefined),
        metadata: vi.fn(),
        worktree: "/tmp/pippit-plugin-test",
      } as never,
    )

    expect(generate).toHaveBeenCalledTimes(1)
    expect(JSON.parse(typeof result === "string" ? result : result.output)).toMatchObject({
      account_binding_persisted: false,
      account_id: account.id,
      run_id: "run-paid-once",
      status: "pending",
      warning: expect.stringContaining("Do not retry"),
    })
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
          max_wait_seconds: 43_200,
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
