import { describe, expect, it } from "vitest"
import {
  IMAGE_MODELS,
  UnknownImageModelError,
  UnknownVideoModelError,
  VIDEO_MODELS,
  publicImageModel,
  publicVideoModel,
  resolveImageModel,
  resolveVideoModel,
} from "../src/models.js"

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

describe("Pippit image model catalog", () => {
  it("publishes Seedream 5.0 aliases without leaking upstream names", () => {
    expect(IMAGE_MODELS.map((model) => model.id)).toEqual([
      "pippit/seedream-5.0",
      "pippit/seedream-5.0-pro",
    ])
    for (const model of IMAGE_MODELS) {
      expect(resolveImageModel(model.id)).toBe(model)
      expect(resolveImageModel(model.upstreamModel)).toBe(model)
      expect(publicImageModel(model)).not.toHaveProperty("upstreamModel")
    }
    expect(resolveImageModel("pippit/seedream-5.0").supported_parameters).not.toHaveProperty("resolution")
    expect(resolveImageModel("pippit/seedream-5.0-pro").supported_parameters.resolution).toEqual({
      type: "enum",
      values: ["1K", "2K", "4K"],
    })
  })

  it("rejects unknown image models with a transport-neutral error", () => {
    expect(() => resolveImageModel("pippit/not-an-image-model")).toThrow(UnknownImageModelError)
  })
})
