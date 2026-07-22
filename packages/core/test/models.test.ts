import { describe, expect, it } from "vitest"
import {
  IMAGE_MODELS,
  PIPPIT_DEFAULT_IMAGE_MODEL,
  PIPPIT_DEFAULT_VIDEO_MODEL,
  UnknownImageModelError,
  UnknownVideoModelError,
  VIDEO_MODELS,
  publicImageModel,
  publicVideoModel,
  resolveImageModel,
  resolveVideoModel,
} from "../src/models.js"

describe("Pippit video model catalog", () => {
  it("publishes only the governed catalog with Mini as the default", () => {
    expect(PIPPIT_DEFAULT_VIDEO_MODEL).toBe("pippit/seedance-2.0-mini")
    expect(VIDEO_MODELS.map((model) => [model.id, model.upstreamModel])).toEqual([
      ["pippit/seedance-2.0-mini", "Seedance_2.0_mini"],
      ["pippit/seedance-2.0", "seedance2.0_direct"],
      ["pippit/seedance-2.0-mini-lite", "Seedance_2.0_mini_lite"],
      ["pippit/seedance-2.0-vision", "seedance2.0_vision"],
    ])
    for (const model of VIDEO_MODELS) {
      expect(resolveVideoModel(model.id)).toBe(model)
      expect(() => resolveVideoModel(model.upstreamModel)).toThrow(UnknownVideoModelError)
      expect(publicVideoModel(model)).not.toHaveProperty("upstreamModel")
    }
  })

  it("rejects removed models and uses a transport-neutral unknown-model error", () => {
    expect(() => resolveVideoModel("pippit/seedance-2.0-fast")).toThrow(UnknownVideoModelError)
    expect(() => resolveVideoModel("seedance2.0_fast_vision")).toThrow(UnknownVideoModelError)
    expect(() => resolveVideoModel("pippit/not-a-model")).toThrow(UnknownVideoModelError)
  })
})

describe("Pippit image model catalog", () => {
  it("publishes only stable Seedream 5.0 ids without leaking upstream names", () => {
    expect(PIPPIT_DEFAULT_IMAGE_MODEL).toBe("pippit/seedream-5.0")
    expect(IMAGE_MODELS.map((model) => model.id)).toEqual([
      "pippit/seedream-5.0",
      "pippit/seedream-5.0-pro",
    ])
    for (const model of IMAGE_MODELS) {
      expect(resolveImageModel(model.id)).toBe(model)
      expect(() => resolveImageModel(model.upstreamModel)).toThrow(UnknownImageModelError)
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
