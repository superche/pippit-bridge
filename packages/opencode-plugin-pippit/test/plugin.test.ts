import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryIdempotencyStore, VIDEO_MODELS } from "@pippit-bridge/core"
import { MemoryPippitAccountStore, PippitAccountManager } from "../src/account-store.js"
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
    expect(pluginModule.id).toBe("pippit.opencode-plugin")
    expect(pluginModule.server).toBe(PippitPlugin)
  })

  it("registers only custom tools and never contributes LLM provider or auth hooks", async () => {
    const hooks = await PippitPlugin({} as never)

    expect(hooks).not.toHaveProperty("auth")
    expect(hooks).not.toHaveProperty("config")
    expect(hooks).not.toHaveProperty("provider")
    expect(Object.keys(hooks.tool ?? {})).toEqual([
      "pippit_manage_access_keys",
      "pippit_generate_video",
      "pippit_get_video",
    ])
    expect(hooks.tool?.pippit_manage_access_keys?.args).not.toHaveProperty("access_key")
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
    const enrollment = {
      close: vi.fn(async () => undefined),
      createEnrollment: vi.fn(async (accountName: string) => ({
        account_name: accountName,
        enrollment_url: `http://127.0.0.1:43210/enroll/${"a".repeat(43)}`,
        expires_at: "2026-07-20T12:00:00.000Z",
      })),
    }
    const hooks = await createPippitPlugin({ accounts, enrollment })({} as never)
    const manage = hooks.tool?.pippit_manage_access_keys?.execute
    if (manage === undefined) throw new Error("Expected the Pippit access-key management tool")
    const context = { ask: vi.fn(async () => undefined), metadata: vi.fn() }
    try {
      for (const [accountName, accessKey] of [
        ["工作", "ak-work-account-secret"],
        ["个人", "ak-personal-account-secret"],
      ] as const) {
        const configured = await manage({ account_name: accountName, operation: "configure" }, context as never)
        const output = JSON.parse(typeof configured === "string" ? configured : configured.output) as {
          enrollment_url: string
        }
        expect(output.enrollment_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/enroll\//u)
        expect(JSON.stringify(configured)).not.toContain(accessKey)
        await accounts.addAccount(accountName, accessKey)
      }

      vi.stubEnv("PIPPIT_ACCESS_KEY", "ak-ci-override-never-returned")
      const listed = await manage({ operation: "list" }, context as never)
      const serializedList = JSON.stringify(listed)
      expect(serializedList).toContain("工作")
      expect(serializedList).toContain("个人")
      expect(serializedList).not.toContain("ak-work-account-secret")
      expect(serializedList).not.toContain("ak-personal-account-secret")
      expect(serializedList).not.toContain("ak-ci-override-never-returned")

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
        deleted_account: { account_id: personal.id, active: false },
      })
      expect(context.ask).toHaveBeenCalledTimes(2)
      expect(enrollment.createEnrollment).toHaveBeenCalledTimes(2)
    } finally {
      await hooks.dispose?.()
      expect(enrollment.close).toHaveBeenCalledOnce()
    }
  })

  it("validates account selectors before permission without reading or writing OpenCode auth", async () => {
    const accounts = new PippitAccountManager(new MemoryPippitAccountStore())
    const account = await accounts.addAccount("工作", "ak-private-account-secret")
    const hooks = await createPippitPlugin({ accounts })({ client: {} } as never)
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

    await expect(manage({ account_id: account.id, operation: "delete" }, context as never)).resolves.toBeDefined()
    await expect(accounts.resolveActive()).resolves.toBeUndefined()
  })

  it("returns a successful paid submission even when local account binding persistence fails", async () => {
    const accounts = new PippitAccountManager(new MemoryPippitAccountStore())
    const account = await accounts.addAccount("工作", "ak-billing-safe-secret")
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

  it("replays OpenCode generation by idempotency key and conflicts before a changed submission", async () => {
    const accounts = new PippitAccountManager(new MemoryPippitAccountStore())
    await accounts.addAccount("工作", "ak-idempotency-test")
    const generate = vi.fn(async () => ({
      model: "pippit/seedance-2.0",
      runId: "run-idempotent",
      status: "pending" as const,
      threadId: "thread-idempotent",
    }))
    const hooks = await createPippitPlugin({
      accounts,
      idempotency: new MemoryIdempotencyStore({ hmacKey: Buffer.alloc(32, 8) }),
      videos: {
        generate,
        get: vi.fn(async () => ({ runId: "unused", status: "pending" as const, threadId: "unused" })),
      },
    })({} as never)
    const execute = hooks.tool?.pippit_generate_video?.execute
    if (execute === undefined) throw new Error("Expected the Pippit generate tool")
    const context = {
      abort: new AbortController().signal,
      ask: vi.fn(async () => undefined),
      metadata: vi.fn(),
      worktree: "/tmp/pippit-idempotency-test",
    } as never
    const args = {
      idempotency_key: "same-open-code-key",
      max_wait_seconds: 43_200,
      model: "pippit/seedance-2.0",
      prompt: "submit once",
      wait_for_completion: false,
    } as const

    const first = await execute(args, context)
    const replay = await execute(args, context)
    await expect(execute({ ...args, prompt: "changed request" }, context)).rejects.toThrow("different Pippit request")
    await accounts.addAccount("个人", "ak-idempotency-second-account")
    await expect(execute(args, context)).rejects.toThrow("different Pippit request")

    expect(generate).toHaveBeenCalledTimes(1)
    expect(JSON.parse(typeof replay === "string" ? replay : replay.output)).toMatchObject(
      JSON.parse(typeof first === "string" ? first : first.output),
    )
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
