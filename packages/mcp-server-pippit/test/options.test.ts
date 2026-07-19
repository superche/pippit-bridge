import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { defaultPippitOutputDirectory, facadeManagementClientOptions, parsePippitMcpOptions } from "../src/options.ts"

describe("parsePippitMcpOptions", () => {
  it("loads facade-only credentials without exposing raw Pippit access keys", () => {
    const options = parsePippitMcpOptions({
      PIPPIT_FACADE_API_KEY: "facade-secret",
      PIPPIT_FACADE_BASE_URL: "https://bridge.example.test/",
      PIPPIT_FACADE_TIMEOUT_MS: "45000",
      PIPPIT_MCP_OUTPUT_ROOT: "./outputs",
    })
    expect(options.facadeBaseUrl).toBe("https://bridge.example.test")
    expect(options.facadeTimeoutMs).toBe(45_000)
    expect(options.outputRoot).toMatch(/outputs$/u)
    expect(JSON.stringify(options)).not.toContain("PIPPIT_ACCESS_KEY")
  })

  it("allows loopback HTTP and rejects plaintext remote facade credentials", () => {
    expect(() => parsePippitMcpOptions({ PIPPIT_FACADE_API_KEY: "key", PIPPIT_FACADE_BASE_URL: "http://localhost:3000" })).not.toThrow()
    expect(() => parsePippitMcpOptions({ PIPPIT_FACADE_API_KEY: "key", PIPPIT_FACADE_BASE_URL: "http://bridge.example.test" })).toThrow(/HTTPS/u)
  })

  it("keeps every default output outside the process working directory", () => {
    expect(defaultPippitOutputDirectory("/Users/tester", "darwin")).toBe("/Users/tester/Movies/Pippit")
    expect(defaultPippitOutputDirectory("/home/tester", "linux")).toBe("/home/tester/Videos/Pippit")
    expect(parsePippitMcpOptions({ PIPPIT_FACADE_API_KEY: "key" }).outputRoot)
      .toBe(defaultPippitOutputDirectory())
  })

  it("requires the facade API key", () => {
    expect(() => parsePippitMcpOptions({})).toThrow("PIPPIT_FACADE_API_KEY is required")
  })

  it("keeps the management key optional and derives caller identity from the runtime key", () => {
    const withoutManagement = parsePippitMcpOptions({ PIPPIT_FACADE_API_KEY: "runtime-key" })
    expect(facadeManagementClientOptions(withoutManagement)).toBeUndefined()

    const configured = parsePippitMcpOptions({
      PIPPIT_FACADE_API_KEY: "runtime-key",
      PIPPIT_FACADE_MANAGEMENT_API_KEY: "management-key",
      PIPPIT_MCP_ENROLLMENT_PORT: "0",
      PIPPIT_MCP_ENROLLMENT_TTL_MS: "300000",
    })
    expect(facadeManagementClientOptions(configured)).toEqual({
      baseUrl: "http://127.0.0.1:3000",
      facadeApiKeyHash: createHash("sha256").update("runtime-key").digest("hex"),
      managementApiKey: "management-key",
      timeoutMs: 120_000,
    })
  })
})
