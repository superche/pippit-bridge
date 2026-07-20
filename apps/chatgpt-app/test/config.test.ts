import { describe, expect, it, vi } from "vitest"

import {
  mediaPreviewsEnabled,
  parseChatGptAppConfig,
  resolveChatGptAppConfig,
} from "../src/config.js"

const KEY = "a".repeat(64)

describe("parseChatGptAppConfig", () => {
  it("uses loopback developer defaults while requiring the facade key", () => {
    const config = parseChatGptAppConfig({ PIPPIT_FACADE_API_KEY: "server-secret" })
    expect(config).toMatchObject({
      facadeApiKey: "server-secret",
      facadeBaseUrl: "http://127.0.0.1:3000",
      facadeTimeoutMs: 43_200_000,
      host: "127.0.0.1",
      mediaTtlSeconds: 300,
      port: 8787,
      runtimeDataRoot: expect.any(String),
    })
    expect(mediaPreviewsEnabled(config)).toBe(false)
  })

  it("enables previews only when a public URL and signing key are paired", () => {
    const config = parseChatGptAppConfig({
      CHATGPT_APP_MEDIA_SIGNING_KEY_HEX: KEY,
      CHATGPT_APP_PUBLIC_BASE_URL: "https://apps.example.test/",
      PIPPIT_FACADE_API_KEY: "server-secret",
    })
    expect(config.publicBaseUrl).toBe("https://apps.example.test")
    expect(mediaPreviewsEnabled(config)).toBe(true)

    expect(() =>
      parseChatGptAppConfig({
        CHATGPT_APP_PUBLIC_BASE_URL: "https://apps.example.test",
        PIPPIT_FACADE_API_KEY: "server-secret",
      }),
    ).toThrow(/configured together/u)
  })

  it("rejects unsafe public base URLs", () => {
    for (const publicBaseUrl of [
      "http://apps.example.test",
      "https://user:pass@apps.example.test",
      "https://apps.example.test?secret=yes",
      "https://apps.example.test/#fragment",
      "https://apps.example.test/pippit",
    ]) {
      expect(() =>
        parseChatGptAppConfig({
          CHATGPT_APP_MEDIA_SIGNING_KEY_HEX: KEY,
          CHATGPT_APP_PUBLIC_BASE_URL: publicBaseUrl,
          PIPPIT_FACADE_API_KEY: "server-secret",
        }),
      ).toThrow()
    }
    expect(
      parseChatGptAppConfig({
        CHATGPT_APP_MEDIA_SIGNING_KEY_HEX: KEY,
        CHATGPT_APP_PUBLIC_BASE_URL: "http://localhost:8787",
        PIPPIT_FACADE_API_KEY: "server-secret",
      }).publicBaseUrl,
    ).toBe("http://localhost:8787")
  })

  it("projects a local runtime into App config without exposing its management key", async () => {
    const runtimeEnvironmentResolver = vi.fn(async (env: NodeJS.ProcessEnv) => ({
      environment: {
        ...env,
        PIPPIT_FACADE_API_KEY: "local-facade-secret",
        PIPPIT_FACADE_BASE_URL: "http://127.0.0.1:43123",
        PIPPIT_FACADE_MANAGEMENT_API_KEY: "local-management-secret",
      },
      local: {
        dataRoot: "/tmp/pippit-bridge-test",
        mediaSigningKeyHex: "b".repeat(64),
      },
      mode: "local" as const,
    }))

    const config = await resolveChatGptAppConfig(
      { CHATGPT_APP_PUBLIC_BASE_URL: "https://apps.example.test" },
      { runtimeEnvironmentResolver },
    )

    expect(runtimeEnvironmentResolver).toHaveBeenCalledWith({
      CHATGPT_APP_PUBLIC_BASE_URL: "https://apps.example.test",
    })
    expect(config).toMatchObject({
      facadeApiKey: "local-facade-secret",
      facadeBaseUrl: "http://127.0.0.1:43123",
      mediaSigningKeyHex: "b".repeat(64),
      publicBaseUrl: "https://apps.example.test",
      runtimeDataRoot: "/tmp/pippit-bridge-test",
    })
    expect(config).not.toHaveProperty("PIPPIT_FACADE_MANAGEMENT_API_KEY")
    expect(config).not.toHaveProperty("managementApiKey")
    expect(mediaPreviewsEnabled(config)).toBe(true)
  })

  it("fails closed for a partial external Facade configuration", async () => {
    await expect(
      resolveChatGptAppConfig({ PIPPIT_FACADE_BASE_URL: "https://facade.example.test" }),
    ).rejects.toThrow(/PIPPIT_FACADE_API_KEY.*required/u)
  })

  it("does not borrow local media credentials for an external Facade", async () => {
    await expect(
      resolveChatGptAppConfig({
        CHATGPT_APP_PUBLIC_BASE_URL: "https://apps.example.test",
        PIPPIT_FACADE_API_KEY: "external-facade-secret",
        PIPPIT_FACADE_BASE_URL: "https://facade.example.test",
      }),
    ).rejects.toThrow(/configured together/u)
  })

  it("rejects wildcard and non-loopback listeners even with a public HTTPS origin", () => {
    expect(() =>
      parseChatGptAppConfig({
        CHATGPT_APP_HOST: "0.0.0.0",
        PIPPIT_FACADE_API_KEY: "server-secret",
      }),
    ).toThrow(/listen only/u)

    expect(() =>
      parseChatGptAppConfig({
        CHATGPT_APP_HOST: "::",
        CHATGPT_APP_MEDIA_SIGNING_KEY_HEX: KEY,
        CHATGPT_APP_PUBLIC_BASE_URL: "http://localhost:8787",
        PIPPIT_FACADE_API_KEY: "server-secret",
      }),
    ).toThrow(/listen only/u)

    expect(() =>
      parseChatGptAppConfig({
        CHATGPT_APP_HOST: "0.0.0.0",
        CHATGPT_APP_MEDIA_SIGNING_KEY_HEX: KEY,
        CHATGPT_APP_PUBLIC_BASE_URL: "https://apps.example.test",
        PIPPIT_FACADE_API_KEY: "server-secret",
      }),
    ).toThrow(/listen only/u)

    expect(() =>
      parseChatGptAppConfig({
        CHATGPT_APP_HOST: "app.internal.example.test",
        CHATGPT_APP_MEDIA_SIGNING_KEY_HEX: KEY,
        CHATGPT_APP_PUBLIC_BASE_URL: "https://apps.example.test",
        PIPPIT_FACADE_API_KEY: "server-secret",
      }),
    ).toThrow(/listen only/u)
  })
})
