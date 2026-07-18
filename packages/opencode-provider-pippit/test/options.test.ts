import { describe, expect, it } from "vitest"
import { parsePluginOptions } from "../src/options.js"

describe("parsePluginOptions", () => {
  it("uses secure direct-provider defaults", () => {
    expect(parsePluginOptions(undefined)).toEqual({
      allowPrivateReferenceUrls: false,
      baseURL: "https://xyq.jianying.com",
      outputDirectory: ".pippit/outputs",
      pollIntervalMs: 2_000,
      requestTimeoutMs: 120_000,
    })
  })

  it("accepts same-origin HTTPS device authorization endpoints", () => {
    expect(
      parsePluginOptions({
        deviceAuthorization: {
          authorizationURL: "https://xyq.jianying.com/developer/ak/device_authorization",
          tokenURL: "https://xyq.jianying.com/developer/ak/token",
        },
      }).deviceAuthorization,
    ).toEqual({
      authorizationURL: "https://xyq.jianying.com/developer/ak/device_authorization",
      clientID: "pippit-opencode",
      scope: "asset.upload video.generate video.read",
      tokenURL: "https://xyq.jianying.com/developer/ak/token",
    })
  })

  it("rejects cross-origin or non-HTTPS device token delivery", () => {
    expect(() =>
      parsePluginOptions({
        deviceAuthorization: {
          authorizationURL: "https://xyq.jianying.com/device",
          tokenURL: "https://attacker.example/token",
        },
      }),
    ).toThrow("must share one HTTPS origin")
    expect(() =>
      parsePluginOptions({
        deviceAuthorization: {
          authorizationURL: "http://xyq.jianying.com/device",
          tokenURL: "http://xyq.jianying.com/token",
        },
      }),
    ).toThrow("must use HTTPS")
    expect(() =>
      parsePluginOptions({
        deviceAuthorization: {
          authorizationURL: "https://auth.example/device",
          tokenURL: "https://auth.example/token",
        },
      }),
    ).toThrow("official Pippit origin")
  })

  it("rejects output traversal", () => {
    expect(() => parsePluginOptions({ outputDirectory: "../secrets" })).toThrow("inside the OpenCode worktree")
  })

  it("never sends an OpenCode-owned Access Key to a configured third-party origin", () => {
    expect(() => parsePluginOptions({ baseURL: "https://attacker.example" })).toThrow(
      "fixed to the official origin",
    )
  })
})
