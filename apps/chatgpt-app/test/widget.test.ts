import { describe, expect, it } from "vitest"

import {
  adjustWidgetRegionFromKey,
  classifyPreviewUpdate,
  mergeWidgetDraftForMediaRefresh,
  reconcileWidgetDraftForDuration,
  resolveWidgetModel,
  shouldAcceptWidgetJobResult,
  widgetDraftPayloadEquals,
} from "@pippit-bridge/mcp-server"

describe("Pippit MCP App widget state", () => {
  it("classifies preview refreshes without reloading an unchanged source", () => {
    expect(classifyPreviewUpdate(undefined, 0, undefined, false, "job-1", 0, "https://media/one"))
      .toBe("new-source")
    expect(classifyPreviewUpdate(
      "job-1", 0, "https://media/one", true, "job-1", 0, "https://media/one",
    )).toBe("unchanged")
    expect(classifyPreviewUpdate(
      "job-1", 0, "https://media/one", true, "job-1", 0, "https://media/two",
    )).toBe("renewed-url")
    expect(classifyPreviewUpdate(
      "job-1", 0, "https://media/one", false, "job-1", 0, "https://media/two",
    )).toBe("new-source")
    expect(classifyPreviewUpdate(
      "job-1", 0, "https://media/one", true, "job-1", 1, "https://media/one",
    )).toBe("new-source")
  })

  it("keeps the regenerated job and artifact when bootstrap results replay", () => {
    type Selection = { artifactUri: string | undefined; jobId: string }
    const oldDone: Selection = {
      artifactUri: `pippit-video://artifact/${"a".repeat(64)}`,
      jobId: "job-old",
    }
    const newPending: Selection = { artifactUri: undefined, jobId: "job-new" }
    const newDone: Selection = {
      artifactUri: `pippit-video://artifact/${"b".repeat(64)}`,
      jobId: "job-new",
    }
    let selected: Selection | undefined
    let regenerationPending = false
    const apply = (incoming: Selection, authoritativeTransition = false): boolean => {
      const accepted = shouldAcceptWidgetJobResult(
        selected?.jobId,
        incoming.jobId,
        regenerationPending,
        authoritativeTransition,
      )
      if (accepted) selected = incoming
      return accepted
    }

    expect(apply(oldDone)).toBe(true)
    regenerationPending = true
    expect(apply(oldDone)).toBe(false)
    expect(apply(newPending)).toBe(false)
    expect(apply(newPending, true)).toBe(true)
    regenerationPending = false
    expect(apply(newDone)).toBe(true)
    expect(apply(oldDone)).toBe(false)
    expect(selected).toEqual(newDone)
    expect(selected?.artifactUri).toBe(newDone.artifactUri)

    expect(shouldAcceptWidgetJobResult(undefined, "A", false)).toBe(true)
    expect(shouldAcceptWidgetJobResult("A", "A", false)).toBe(true)
    expect(shouldAcceptWidgetJobResult("A", "A", true)).toBe(false)
    expect(shouldAcceptWidgetJobResult("A", "B", true)).toBe(false)
    expect(shouldAcceptWidgetJobResult("A", "B", true, true)).toBe(true)
    expect(shouldAcceptWidgetJobResult("B", "A", false)).toBe(false)
    expect(resolveWidgetModel(undefined, "pippit/original")).toBe("pippit/original")
    expect(resolveWidgetModel("pippit/original", undefined)).toBe("pippit/original")
    expect(resolveWidgetModel("pippit/original", null)).toBe("pippit/original")
    expect(resolveWidgetModel("pippit/original", "pippit/regenerated")).toBe("pippit/regenerated")
  })

  it("preserves a draft and playhead when a signed media URL is renewed", () => {
    const draft = {
      annotations: [
        { at_ms: 2_500, instruction: "Keep this", region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
        { at_ms: 7_000, instruction: "Past a shorter source", region: { x: 0.2, y: 0.3, width: 0.2, height: 0.2 } },
      ],
      currentTimeMs: 4_000,
      prompt: "Preserve my overall instruction",
      segmentEndMs: 8_000,
      segmentStartMs: 2_000,
    }

    const sameDuration = reconcileWidgetDraftForDuration(draft, 10_000)
    expect(sameDuration).toMatchObject({
      currentTimeMs: 4_000,
      prompt: draft.prompt,
      segmentEndMs: 8_000,
      segmentStartMs: 2_000,
    })
    expect(sameDuration.annotations).toEqual(draft.annotations)

    const shorterDuration = reconcileWidgetDraftForDuration(draft, 5_000)
    expect(shorterDuration).toMatchObject({
      currentTimeMs: 4_000,
      prompt: draft.prompt,
      segmentEndMs: 5_000,
      segmentStartMs: 2_000,
    })
    expect(shorterDuration.annotations).toEqual([draft.annotations[0]])
  })

  it("merges edits made during media reload while restoring only the saved playhead", () => {
    const beforeLoad = {
      annotations: [
        { at_ms: 2_000, instruction: "Old note", region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
      ],
      currentTimeMs: 4_500,
      prompt: "Old prompt",
      segmentEndMs: 8_000,
      segmentStartMs: 1_000,
    }
    const liveDraft = {
      annotations: [
        { at_ms: 3_000, instruction: "Live note", region: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 } },
      ],
      currentTimeMs: 0,
      prompt: "Edited while the signed URL reloaded",
      segmentEndMs: 9_000,
      segmentStartMs: 2_000,
    }

    expect(mergeWidgetDraftForMediaRefresh(beforeLoad, liveDraft)).toEqual({
      ...liveDraft,
      currentTimeMs: 4_500,
    })
  })

  it("compares only the edit payload when deciding whether a retry key remains valid", () => {
    const originalAnnotation = {
      at_ms: 2_500,
      id: "client-only-one",
      instruction: "Keep this",
      region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    }
    const original = {
      annotations: [originalAnnotation],
      currentTimeMs: 4_000,
      prompt: "Same payload",
      segmentEndMs: 8_000,
      segmentStartMs: 2_000,
    }
    const samePayload = {
      ...original,
      annotations: [{ ...originalAnnotation, id: "different-client-id" }],
      currentTimeMs: 7_500,
    }
    const clampedPayload = reconcileWidgetDraftForDuration(original, 5_000)

    expect(widgetDraftPayloadEquals(original, samePayload)).toBe(true)
    expect(widgetDraftPayloadEquals(original, clampedPayload)).toBe(false)
  })

  it("supports creating, moving, resizing, and clearing an ROI from the keyboard", () => {
    const created = adjustWidgetRegionFromKey(undefined, "Enter", false)
    expect(created).toEqual({ handled: true, region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } })

    const moved = adjustWidgetRegionFromKey(created.region, "ArrowRight", false)
    expect(moved).toMatchObject({ handled: true, region: { x: 0.27, y: 0.25, width: 0.5, height: 0.5 } })

    const resized = adjustWidgetRegionFromKey(moved.region, "ArrowDown", true)
    expect(resized).toMatchObject({ handled: true, region: { x: 0.27, y: 0.25, width: 0.5, height: 0.52 } })
    expect(adjustWidgetRegionFromKey(resized.region, "Escape", false)).toEqual({ handled: true })
    expect(adjustWidgetRegionFromKey(undefined, "ArrowLeft", false)).toEqual({ handled: false })
  })

  it("keeps keyboard ROI geometry within normalized bounds at narrow edges", () => {
    const edgeRegion = { x: 0.98, y: 0.98, width: 0.02, height: 0.02 }
    expect(adjustWidgetRegionFromKey(edgeRegion, "ArrowLeft", true).region).toEqual({
      x: 0.98,
      y: 0.98,
      width: 0.01,
      height: 0.02,
    })
    expect(adjustWidgetRegionFromKey(edgeRegion, "ArrowUp", true).region).toEqual({
      x: 0.98,
      y: 0.98,
      width: 0.02,
      height: 0.01,
    })

    let seed = 0x5eed1234
    const randomUnit = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      return seed / 0x1_0000_0000
    }
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]
    for (let sample = 0; sample < 200; sample += 1) {
      const x = randomUnit() * 0.99
      const y = randomUnit() * 0.99
      const width = 0.01 + randomUnit() * (1 - x - 0.01)
      const height = 0.01 + randomUnit() * (1 - y - 0.01)
      for (const key of keys) {
        for (const shiftKey of [false, true]) {
          const result = adjustWidgetRegionFromKey({ x, y, width, height }, key, shiftKey)
          expect(result.handled).toBe(true)
          expect(result.region).toBeDefined()
          const region = result.region!
          expect(region.x).toBeGreaterThanOrEqual(0)
          expect(region.y).toBeGreaterThanOrEqual(0)
          expect(region.width).toBeGreaterThanOrEqual(0.01)
          expect(region.height).toBeGreaterThanOrEqual(0.01)
          expect(region.x + region.width).toBeLessThanOrEqual(1.000_001)
          expect(region.y + region.height).toBeLessThanOrEqual(1.000_001)
        }
      }
    }
  })
})
