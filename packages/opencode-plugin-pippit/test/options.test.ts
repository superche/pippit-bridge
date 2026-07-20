import { describe, expect, it } from "vitest"
import { parsePluginOptions } from "../src/options.js"

describe("parsePluginOptions", () => {
  it("uses secure direct-provider defaults", () => {
    expect(parsePluginOptions(undefined)).toEqual({
      allowPrivateReferenceUrls: false,
      baseURL: "https://xyq.jianying.com",
      outputDirectory: ".pippit/outputs",
      pollIntervalMs: 2_000,
      requestTimeoutMs: 43_200_000,
    })
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
