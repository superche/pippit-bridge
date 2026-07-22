import { describe, expect, it } from "vitest"
import { resolveVideoModel } from "@pippit-bridge/core"
import { pippitStateToOpenRouterStatus, resolveOutputGeometry } from "../src/openrouter/video-mapping.js"

describe("video mapping", () => {
  it.each([
    [0, "failed"],
    [1, "pending"],
    [2, "in_progress"],
    [3, "completed"],
    [4, "failed"],
    [5, "cancelled"],
    [6, "failed"],
    [7, "in_progress"],
    [9, "failed"],
    [99, "failed"],
  ] as const)("maps Pippit state %s to %s", (state, expected) => {
    expect(pippitStateToOpenRouterStatus(state)).toBe(expected)
  })

  it("rejects exact size because Pippit only guarantees ratio and resolution", () => {
    expect(() =>
      resolveOutputGeometry({ size: "1280x720" }, resolveVideoModel("pippit/seedance-2.0")),
    ).toThrowError(expect.objectContaining({ code: "unsupported_parameter", param: "size" }))
  })

  it("rejects 1080p for every model except Seedance 2.0 Vision", () => {
    expect(() =>
      resolveOutputGeometry({ resolution: "1080p" }, resolveVideoModel("pippit/seedance-2.0")),
    ).toThrowError(expect.objectContaining({ code: "unsupported_parameter", param: "resolution" }))

    expect(resolveOutputGeometry({ resolution: "1080p" }, resolveVideoModel("pippit/seedance-2.0-vision"))).toEqual({
      resolution: "1080p",
    })
  })
})
