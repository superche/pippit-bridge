import { describe, expect, it } from "vitest"

import { createMediaTokenSigner } from "../src/media-token.js"

describe("media tokens", () => {
  it("issues distinct renewal tokens within the same second", () => {
    const signer = createMediaTokenSigner({
      keyHex: "11".repeat(32),
      now: () => 1_700_000_000_000,
      ttlSeconds: 300,
    })

    const first = signer.issue("job_123", 0)
    const renewed = signer.issue("job_123", 0)
    expect(renewed).not.toBe(first)
    expect(signer.verify(renewed)).toEqual(signer.verify(first))
  })

  it("round-trips a scoped, short-lived job token", () => {
    const signer = createMediaTokenSigner({
      keyHex: "1".repeat(64),
      now: () => 1_000_000,
      ttlSeconds: 60,
    })
    expect(signer.verify(signer.issue("job_123", 2))).toEqual({
      expiresAt: 1_060,
      index: 2,
      jobId: "job_123",
    })
  })

  it("rejects tampering", () => {
    const signer = createMediaTokenSigner({
      keyHex: "2".repeat(64),
      now: () => 1_000_000,
      ttlSeconds: 60,
    })
    const token = signer.issue("job_123")
    const lastCharacter = token.endsWith("a") ? "b" : "a"
    expect(() => signer.verify(token.slice(0, -1) + lastCharacter)).toThrow(/signature/u)
  })

  it("rejects tokens at or after expiry", () => {
    let now = 1_000_000
    const signer = createMediaTokenSigner({
      keyHex: "3".repeat(64),
      now: () => now,
      ttlSeconds: 30,
    })
    const token = signer.issue("job_123")
    now += 30_000
    expect(() => signer.verify(token)).toThrow(/expired/u)
  })
})
