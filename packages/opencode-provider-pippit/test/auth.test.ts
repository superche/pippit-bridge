import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createDeviceAuthorizationMethod,
  createPippitAuthHook,
  PippitCredentialSource,
} from "../src/auth.js"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("PippitCredentialSource", () => {
  it("reads the OpenCode-owned API credential captured by the auth loader", async () => {
    const credentials = new PippitCredentialSource()
    const hook = createPippitAuthHook(credentials)

    expect(hook.methods).toEqual([
      {
        type: "api",
        label: "粘贴官网已签发的 AK / Paste an Access Key issued by Pippit",
      },
    ])
    await hook.loader?.(async () => ({ type: "api", key: "ak-from-opencode" }), {} as never)

    await expect(credentials.read()).resolves.toBe("ak-from-opencode")
  })

  it("prefers an explicit process credential for isolated CI", async () => {
    vi.stubEnv("PIPPIT_ACCESS_KEY", "ak-from-environment")
    const credentials = new PippitCredentialSource()
    credentials.setStoredAuthGetter(async () => ({ type: "api", key: "ak-from-opencode" }))

    await expect(credentials.read()).resolves.toBe("ak-from-environment")
  })

  it("does not assume an ak- prefix or a fixed future key length", async () => {
    const credentials = new PippitCredentialSource()
    credentials.setStoredAuthGetter(async () => ({ type: "api", key: "future.key_format-1" }))

    await expect(credentials.read()).resolves.toBe("future.key_format-1")
  })
})

describe("Pippit device authorization", () => {
  it("polls RFC 8628 responses and returns the website-issued key to OpenCode", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://xyq.jianying.com/device",
          verification_uri_complete: "https://xyq.jianying.com/device?user_code=ABCD-EFGH",
          expires_in: 300,
          interval: 1,
        }),
      )
      .mockResolvedValueOnce(Response.json({ error: "authorization_pending" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ error: "slow_down" }, { status: 400 }))
      .mockResolvedValueOnce(
        Response.json({ access_token: "ak-issued-after-consent", token_type: "Bearer" }),
      )
    const sleep = vi.fn(async () => undefined)
    const method = createDeviceAuthorizationMethod(
      {
        authorizationURL: "https://xyq.jianying.com/developer/ak/device_authorization",
        clientID: "pippit-opencode",
        scope: "asset.upload video.generate video.read",
        tokenURL: "https://xyq.jianying.com/developer/ak/token",
      },
      { fetchImpl, now: () => 0, sleep },
    )
    if (method.type !== "oauth") throw new Error("Expected an OAuth auth method")

    const authorization = await method.authorize()
    expect(authorization.url).toBe("https://xyq.jianying.com/device?user_code=ABCD-EFGH")
    expect(authorization.method).toBe("auto")
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).toBe(
      "client_id=pippit-opencode&scope=asset.upload+video.generate+video.read",
    )
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    )
    if (authorization.method !== "auto") throw new Error("Expected automatic device polling")

    await expect(authorization.callback()).resolves.toEqual({
      type: "success",
      provider: "pippit",
      key: "ak-issued-after-consent",
    })
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000)
    expect(sleep).toHaveBeenNthCalledWith(2, 1_000)
    expect(sleep).toHaveBeenNthCalledWith(3, 6_000)
    expect(fetchImpl).toHaveBeenCalledTimes(4)

    const tokenRequest = fetchImpl.mock.calls[1]?.[1]
    expect(String(tokenRequest?.body)).toContain("device_code=device-secret")
    expect(String(tokenRequest?.body)).not.toContain("ak-issued-after-consent")
  })

  it("rejects a verification URL on another origin", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://phishing.example/device",
        expires_in: 300,
        interval: 1,
      }),
    )
    const method = createDeviceAuthorizationMethod(
      {
        authorizationURL: "https://xyq.jianying.com/developer/ak/device_authorization",
        clientID: "pippit-opencode",
        scope: "video.generate",
        tokenURL: "https://xyq.jianying.com/developer/ak/token",
      },
      { fetchImpl },
    )
    if (method.type !== "oauth") throw new Error("Expected an OAuth auth method")

    await expect(method.authorize()).rejects.toThrow("untrusted verification URL")
  })

  it("bounds a stalled website authorization request", async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined))
      const method = createDeviceAuthorizationMethod(
        {
          authorizationURL: "https://xyq.jianying.com/developer/ak/device_authorization",
          clientID: "pippit-opencode",
          scope: "video.generate",
          tokenURL: "https://xyq.jianying.com/developer/ak/token",
        },
        { fetchImpl, requestTimeoutMs: 25 },
      )
      if (method.type !== "oauth") throw new Error("Expected an OAuth auth method")

      const assertion = expect(method.authorize()).rejects.toThrow("timed out")
      await vi.advanceTimersByTimeAsync(25)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it("backs off and retries a transient token request failure", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://xyq.jianying.com/device",
          expires_in: 300,
          interval: 1,
        }),
      )
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(Response.json({ access_token: "ak-after-retry" }))
    const sleep = vi.fn(async () => undefined)
    const method = createDeviceAuthorizationMethod(
      {
        authorizationURL: "https://xyq.jianying.com/developer/ak/device_authorization",
        clientID: "pippit-opencode",
        scope: "video.generate",
        tokenURL: "https://xyq.jianying.com/developer/ak/token",
      },
      { fetchImpl, now: () => 0, sleep },
    )
    if (method.type !== "oauth") throw new Error("Expected an OAuth auth method")
    const authorization = await method.authorize()
    if (authorization.method !== "auto") throw new Error("Expected automatic device polling")

    await expect(authorization.callback()).resolves.toMatchObject({ key: "ak-after-retry", type: "success" })
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000)
    expect(sleep).toHaveBeenNthCalledWith(2, 2_000)
  })
})
