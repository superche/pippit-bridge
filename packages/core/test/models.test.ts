import { describe, expect, it } from "vitest"
import { UnknownVideoModelError, VIDEO_MODELS, publicVideoModel, resolveVideoModel } from "../src/models.js"

describe("Pippit video model catalog", () => {
  it("keeps stable ids while accepting the existing upstream aliases", () => {
    for (const model of VIDEO_MODELS) {
      expect(resolveVideoModel(model.id)).toBe(model)
      expect(resolveVideoModel(model.upstreamModel)).toBe(model)
      expect(publicVideoModel(model)).not.toHaveProperty("upstreamModel")
    }
  })

  it("uses a transport-neutral unknown-model error", () => {
    expect(() => resolveVideoModel("pippit/not-a-model")).toThrow(UnknownVideoModelError)
  })
})
