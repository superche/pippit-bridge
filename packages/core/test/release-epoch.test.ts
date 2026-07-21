import { describe, expect, test } from "vitest"
import { classifyReleaseEpoch } from "../src/release-epoch.js"

describe("release epoch fencing", () => {
  test("keeps the first epoch-less historical release compatible", () => {
    expect(classifyReleaseEpoch(undefined, 2)).toBe("legacy-compatible")
  })

  test("rejects an explicit stale or malformed epoch", () => {
    expect(classifyReleaseEpoch("1", 2)).toBe("stale")
    expect(classifyReleaseEpoch("invalid", 2)).toBe("stale")
  })

  test("accepts N and newer compatible epochs", () => {
    expect(classifyReleaseEpoch("2", 2)).toBe("compatible")
    expect(classifyReleaseEpoch("3", 2)).toBe("compatible")
  })
})
