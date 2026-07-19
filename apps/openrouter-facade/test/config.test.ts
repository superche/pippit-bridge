import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { loadConfig, mergeConfig, parseConfig } from "../src/config.js"

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex")

describe("configuration safety", () => {
  it("uses 12-hour defaults for every generation-related facade deadline", () => {
    const config = parseConfig({})
    expect(config.PIPPIT_REQUEST_TIMEOUT_MS).toBe(43_200_000)
    expect(config.REFERENCE_FETCH_TIMEOUT_MS).toBe(43_200_000)
    expect(config.CONTENT_STREAM_IDLE_TIMEOUT_MS).toBe(43_200_000)
  })

  it("requires independent BYOK, job-signing, management, and facade credentials", () => {
    expect(() => loadConfig({})).toThrow(/BYOK_ENCRYPTION_KEY_HEX/u)
  })

  it("accepts a complete BYOK configuration", () => {
    const config = loadConfig({
      BYOK_ENCRYPTION_KEY_HEX: "a".repeat(64),
      BYOK_MANAGEMENT_KEY_SHA256: sha256("management-test-key"),
      FACADE_API_KEY_SHA256_ALLOWLIST: sha256("facade-test-key"),
      HOST: "0.0.0.0",
      JOB_SIGNING_KEY_HEX: "b".repeat(64),
    })

    expect(config.HOST).toBe("0.0.0.0")
    expect(config.FACADE_API_KEY_SHA256_ALLOWLIST).toEqual([sha256("facade-test-key")])
  })

  it("rejects reuse of the encryption key as the job signing key", () => {
    expect(() =>
      loadConfig({
        BYOK_ENCRYPTION_KEY_HEX: "a".repeat(64),
        BYOK_MANAGEMENT_KEY_SHA256: sha256("management-test-key"),
        FACADE_API_KEY_SHA256_ALLOWLIST: sha256("facade-test-key"),
        JOB_SIGNING_KEY_HEX: "a".repeat(64),
      }),
    ).toThrow(/must be different/u)
  })

  it("rejects the same credential in the management and runtime auth planes", () => {
    const sharedDigest = sha256("shared-management-and-facade-key")
    expect(() =>
      loadConfig({
        BYOK_ENCRYPTION_KEY_HEX: "a".repeat(64),
        BYOK_MANAGEMENT_KEY_SHA256: sharedDigest,
        FACADE_API_KEY_SHA256_ALLOWLIST: sharedDigest,
        JOB_SIGNING_KEY_HEX: "b".repeat(64),
      }),
    ).toThrow(/must not also be authorized/u)
  })

  it("rejects malformed facade digests supplied as programmatic overrides", () => {
    expect(() =>
      mergeConfig(parseConfig({}), {
        BYOK_ENCRYPTION_KEY_HEX: "a".repeat(64),
        BYOK_MANAGEMENT_KEY_SHA256: sha256("management-test-key"),
        FACADE_API_KEY_SHA256_ALLOWLIST: ["not-a-sha256"],
        JOB_SIGNING_KEY_HEX: "b".repeat(64),
      }),
    ).toThrow(/only lowercase SHA-256 digests/u)
  })

  it.each([
    ["encryption", "c".repeat(64), "b".repeat(64)],
    ["job signing", "a".repeat(64), "c".repeat(64)],
  ])("rejects obvious %s key reuse with an authentication digest", (_label, encryptionKey, jobKey) => {
    expect(() =>
      loadConfig({
        BYOK_ENCRYPTION_KEY_HEX: encryptionKey,
        BYOK_MANAGEMENT_KEY_SHA256: "c".repeat(64),
        FACADE_API_KEY_SHA256_ALLOWLIST: "d".repeat(64),
        JOB_SIGNING_KEY_HEX: jobKey,
      }),
    ).toThrow(/must not reuse/u)
  })
})
