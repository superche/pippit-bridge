import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryPippitAccountStore, PippitAccountManager } from "../src/account-store.js"
import { PippitCredentialSource } from "../src/auth.js"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("PippitCredentialSource", () => {
  it("requires a private managed account when no operator environment override exists", async () => {
    const credentials = new PippitCredentialSource(
      new PippitAccountManager(new MemoryPippitAccountStore()),
    )

    await expect(credentials.read()).rejects.toThrow("operation=configure")
  })

  it("prefers an explicit process credential for isolated CI", async () => {
    vi.stubEnv("PIPPIT_ACCESS_KEY", "ak-from-environment")
    const credentials = new PippitCredentialSource(
      new PippitAccountManager(new MemoryPippitAccountStore()),
    )

    await expect(credentials.read()).resolves.toBe("ak-from-environment")
    expect(credentials.hasEnvironmentOverride()).toBe(true)
  })

  it("reads the selected managed account while preserving the environment override", async () => {
    const accounts = new PippitAccountManager(new MemoryPippitAccountStore())
    const first = await accounts.addAccount("工作", "ak-managed-work-secret")
    await accounts.addAccount("个人", "ak-managed-personal-secret")
    const credentials = new PippitCredentialSource(accounts)

    await accounts.switchAccount({ accountId: first.id })
    await expect(credentials.readRuntimeCredential()).resolves.toMatchObject({
      accessKey: "ak-managed-work-secret",
      accountId: first.id,
      source: "managed_account",
    })

    vi.stubEnv("PIPPIT_ACCESS_KEY", "ak-ci-override")
    await expect(credentials.readRuntimeCredential()).resolves.toEqual({
      accessKey: "ak-ci-override",
      source: "environment",
    })
  })

  it("keeps an existing run on its bound account when an environment override is present", async () => {
    const accounts = new PippitAccountManager(new MemoryPippitAccountStore())
    const first = await accounts.addAccount("工作", "ak-managed-work-secret")
    await accounts.bindRun("run-existing", "thread-existing", first.id)
    const second = await accounts.addAccount("个人", "ak-managed-personal-secret")

    vi.stubEnv("PIPPIT_ACCESS_KEY", "ak-ci-override")
    const credentials = new PippitCredentialSource(accounts)
    await expect(credentials.readForRun("run-existing", "thread-existing")).resolves.toMatchObject({
      accessKey: "ak-managed-work-secret",
      accountId: first.id,
      source: "managed_account",
    })
    await expect(credentials.readForRun("run-unbound", "thread-unbound", second.id)).resolves.toMatchObject({
      accessKey: "ak-managed-personal-secret",
      accountId: second.id,
      source: "managed_account",
    })
    await expect(credentials.readForRun("run-existing", "thread-existing", second.id)).rejects.toThrow(
      "does not match this run's saved Pippit account binding",
    )
  })
})
