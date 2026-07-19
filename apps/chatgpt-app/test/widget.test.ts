import { describe, expect, it } from "vitest"

import {
  adjustWidgetRegionFromKey,
  classifyPreviewUpdate,
  mergeWidgetDraftForMediaRefresh,
  PIPPIT_WIDGET_HTML,
  PIPPIT_WIDGET_URI,
  reconcileWidgetDraftForDuration,
  widgetDraftPayloadEquals,
} from "@pippit-bridge/mcp-server"

describe("Pippit MCP App widget", () => {
  it("uses the stable MCP App resource contract", () => {
    expect(PIPPIT_WIDGET_URI).toBe("ui://widget/pippit-video-job-v10.html")
    expect(PIPPIT_WIDGET_HTML).toContain("ui/initialize")
    expect(PIPPIT_WIDGET_HTML).toContain("ui/notifications/initialized")
    expect(PIPPIT_WIDGET_HTML).toContain("ui/notifications/tool-result")
    expect(PIPPIT_WIDGET_HTML).toContain("ui/notifications/size-changed")
    expect(PIPPIT_WIDGET_HTML).toContain("ui/resource-teardown")
    expect(PIPPIT_WIDGET_HTML).toContain('request("tools/call"')
    expect(PIPPIT_WIDGET_HTML).toContain("Boolean(capabilities.serverTools)")
    expect(PIPPIT_WIDGET_HTML).toContain("Boolean(capabilities.serverResources)")
    expect(PIPPIT_WIDGET_HTML).toContain("modes.includes(mode)")
    expect(PIPPIT_WIDGET_HTML).toContain('request("ui/request-display-mode"')
    expect(PIPPIT_WIDGET_HTML).toContain('requestDisplayMode("inline")')
    expect(PIPPIT_WIDGET_HTML).toContain("window.openai.requestDisplayMode")
  })

  it("gates standard tool calls and keeps window.openai as a compatibility fallback", () => {
    expect(PIPPIT_WIDGET_HTML).toContain("if (serverToolsAvailable)")
    expect(PIPPIT_WIDGET_HTML).toContain("DEFAULT_REQUEST_TIMEOUT_MS = 15000")
    expect(PIPPIT_WIDGET_HTML).toContain("VIDEO_TOOL_REQUEST_TIMEOUT_MS = 43200000")
    for (const name of [
      "pippit_generate_video",
      "pippit_get_video",
      "pippit_download_video",
      "pippit_edit_video_segment",
    ]) {
      expect(PIPPIT_WIDGET_HTML).toContain(`"${name}"`)
    }
    expect(PIPPIT_WIDGET_HTML).toContain("VIDEO_TOOL_NAMES.has(name)")
    expect(PIPPIT_WIDGET_HTML).toContain('request("tools/call", { name: name, arguments: args }, timeoutMs)')
    expect(PIPPIT_WIDGET_HTML).toContain("window.openai.toolOutput")
    expect(PIPPIT_WIDGET_HTML).toContain("window.openai.callTool")
  })

  it("renders only metadata-provided HTTPS or local MCP resource previews", () => {
    expect(PIPPIT_WIDGET_HTML).toContain('meta["pippit/media"]')
    expect(PIPPIT_WIDGET_HTML).toContain("typeof item.resource_uri")
    expect(PIPPIT_WIDGET_HTML).toContain('request("resources/read"')
    expect(PIPPIT_WIDGET_HTML).not.toContain("unsigned_urls")
  })

  it("implements a bounded timeline and intrinsic-video ROI annotations", () => {
    expect(PIPPIT_WIDGET_HTML).toContain("MAX_SEGMENT_MS = 30000")
    expect(PIPPIT_WIDGET_HTML).toContain("MAX_ANNOTATIONS = 20")
    expect(PIPPIT_WIDGET_HTML).toContain("end - start > MAX_SEGMENT_MS")
    expect(PIPPIT_WIDGET_HTML).toContain("function videoContentRect()")
    expect(PIPPIT_WIDGET_HTML).toContain("videoElement.videoWidth")
    expect(PIPPIT_WIDGET_HTML).toContain("normalizedPoint(event)")
    expect(PIPPIT_WIDGET_HTML).toContain('commentElement.addEventListener("compositionstart"')
    expect(PIPPIT_WIDGET_HTML).toContain('commentElement.addEventListener("compositionend"')
    expect(PIPPIT_WIDGET_HTML).toContain('commentElement.value.trim() === ""')
    expect(PIPPIT_WIDGET_HTML).toContain('id="comment" maxlength="2000"')
    expect(PIPPIT_WIDGET_HTML).toContain('id="annotation-popover" class="annotation-popover" hidden')
    expect(PIPPIT_WIDGET_HTML).toContain("openAnnotationPopover();")
    expect(PIPPIT_WIDGET_HTML).toContain("Delete annotation")
    expect(PIPPIT_WIDGET_HTML).toContain("annotations.length >= MAX_ANNOTATIONS")
    expect(PIPPIT_WIDGET_HTML).toContain("Math.min(pendingRegion.width, 1 - x)")
    expect(PIPPIT_WIDGET_HTML).toContain("Math.min(pendingRegion.height, 1 - y)")
    expect(PIPPIT_WIDGET_HTML).toContain("The current video is the reference.")
    expect(PIPPIT_WIDGET_HTML).toContain("region annotations are added to the generation prompt.")
    expect(PIPPIT_WIDGET_HTML).not.toContain("only sends")
    expect(PIPPIT_WIDGET_HTML).not.toContain("white frame")
  })

  it("uses the Apple-inspired utility-card visual language without decorative effects", () => {
    expect(PIPPIT_WIDGET_HTML).toContain("#0066cc")
    expect(PIPPIT_WIDGET_HTML).toContain("#0071e3")
    expect(PIPPIT_WIDGET_HTML).toContain("#2997ff")
    expect(PIPPIT_WIDGET_HTML).toContain("#f5f5f7")
    expect(PIPPIT_WIDGET_HTML).toContain("#fafafc")
    expect(PIPPIT_WIDGET_HTML).toContain("#1d1d1f")
    expect(PIPPIT_WIDGET_HTML).toContain("#6e6e73")
    expect(PIPPIT_WIDGET_HTML).not.toContain("#7a7a7a")
    expect(PIPPIT_WIDGET_HTML).toContain("border-radius: 18px")
    expect(PIPPIT_WIDGET_HTML).toContain("min-height: 44px")
    expect(PIPPIT_WIDGET_HTML).toContain("transform: scale(.95)")
    expect(PIPPIT_WIDGET_HTML).toContain("outline: 2px solid #0071e3")
    expect(PIPPIT_WIDGET_HTML).toContain("@media (max-width: 640px)")
    expect(PIPPIT_WIDGET_HTML).toContain("@media (max-width: 480px)")
    expect(PIPPIT_WIDGET_HTML).toContain("@media (prefers-reduced-motion: reduce)")
    expect(PIPPIT_WIDGET_HTML).not.toContain("gradient(")
    expect(PIPPIT_WIDGET_HTML).not.toContain("box-shadow")
  })

  it("keeps touch and accessibility states aligned with annotation mode", () => {
    expect(PIPPIT_WIDGET_HTML).toContain('id="loading-view" class="loading-view" role="status" aria-live="polite"')
    expect(PIPPIT_WIDGET_HTML).toContain('id="status" class="loading-status"')
    expect(PIPPIT_WIDGET_HTML).toContain('id="media-message" class="viewer-message" aria-live="polite"')
    expect(PIPPIT_WIDGET_HTML).toContain('id="annotate" class="annotation-trigger" type="button" aria-pressed="false"')
    expect(PIPPIT_WIDGET_HTML).toContain('aria-label="Regional edit instruction"')
    expect(PIPPIT_WIDGET_HTML).toContain('annotateElement.setAttribute("aria-pressed", String(enabled))')
    expect(PIPPIT_WIDGET_HTML).toContain('stageElement.classList.toggle("annotating", enabled)')
    expect(PIPPIT_WIDGET_HTML).toContain(".video-stage.annotating { touch-action: none; }")
    expect(PIPPIT_WIDGET_HTML).toContain('role="group"')
    expect(PIPPIT_WIDGET_HTML).toContain('tabindex="-1"')
    expect(PIPPIT_WIDGET_HTML).toContain('aria-disabled="true"')
    expect(PIPPIT_WIDGET_HTML).toContain('roiLayerElement.addEventListener("keydown"')
    expect(PIPPIT_WIDGET_HTML).not.toContain('role="application"')
  })

  it("uses native video controls, an Apple-style filmstrip trim, and a flat edit composer", () => {
    expect(PIPPIT_WIDGET_HTML).toContain('<video id="video" controls crossorigin="anonymous"')
    expect(PIPPIT_WIDGET_HTML).not.toContain('id="play"')
    expect(PIPPIT_WIDGET_HTML).not.toContain('id="playhead"')
    expect(PIPPIT_WIDGET_HTML).not.toContain('id="fullscreen"')
    expect(PIPPIT_WIDGET_HTML).toContain('id="filmstrip" class="filmstrip"')
    expect(PIPPIT_WIDGET_HTML).toContain('class="trim-handle" type="button" role="slider"')
    expect(PIPPIT_WIDGET_HTML).toContain("#ffd60a")
    expect(PIPPIT_WIDGET_HTML).toContain('class="edit-compose" aria-label="Regeneration direction"')
    expect(PIPPIT_WIDGET_HTML).toContain(">Regenerate video</button>")
    expect(PIPPIT_WIDGET_HTML).not.toContain("Saved locally: ")
    expect(PIPPIT_WIDGET_HTML).not.toContain("media.local_path")
    expect(PIPPIT_WIDGET_HTML).not.toContain('id="local-file"')
    expect(PIPPIT_WIDGET_HTML).not.toContain("Frame detail")
    expect(PIPPIT_WIDGET_HTML).not.toContain('<p class="eyebrow">Edit direction</p>')
  })

  it("shows only a dot-matrix status while automatically polling non-terminal jobs", () => {
    expect(PIPPIT_WIDGET_HTML).toContain('id="infinity-loader" class="infinity-loader"')
    expect(PIPPIT_WIDGET_HTML).toContain("loaderIndex < 25")
    expect(PIPPIT_WIDGET_HTML).toContain("jobIsRunning(activeStatus) || awaitingPreview")
    expect(PIPPIT_WIDGET_HTML).toContain('callTool("pippit_get_video", { job_id: requestedJobId })')
    expect(PIPPIT_WIDGET_HTML).toContain("schedulePoll(pollDelayMs)")
    expect(PIPPIT_WIDGET_HTML).toContain("clearPollTimer();")
    expect(PIPPIT_WIDGET_HTML).not.toContain('<dt>Job</dt>')
    expect(PIPPIT_WIDGET_HTML).not.toContain('<dt>Model</dt>')
    expect(PIPPIT_WIDGET_HTML).not.toContain("Refresh status")
    expect(PIPPIT_WIDGET_HTML).not.toContain("job.error")
  })

  it("classifies preview refreshes without reloading an unchanged source", () => {
    expect(classifyPreviewUpdate(undefined, 0, undefined, false, "job-1", 0, "https://media/one")).toBe(
      "new-source",
    )
    expect(
      classifyPreviewUpdate("job-1", 0, "https://media/one", true, "job-1", 0, "https://media/one"),
    ).toBe("unchanged")
    expect(
      classifyPreviewUpdate("job-1", 0, "https://media/one", true, "job-1", 0, "https://media/two"),
    ).toBe("renewed-url")
    expect(
      classifyPreviewUpdate("job-1", 0, "https://media/one", false, "job-1", 0, "https://media/two"),
    ).toBe("new-source")
    expect(
      classifyPreviewUpdate("job-1", 0, "https://media/one", true, "job-1", 1, "https://media/one"),
    ).toBe("new-source")
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
    expect(PIPPIT_WIDGET_HTML).toContain('updateKind = initializedSourceDraft ? "renewed-url" : "new-source";')
    expect(PIPPIT_WIDGET_HTML).toContain('updateKind === "renewed-url" ? draftSnapshot() : undefined')
    expect(PIPPIT_WIDGET_HTML).toContain("restoreDraftAfterMediaRefresh(savedDraft)")
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
    expect(PIPPIT_WIDGET_HTML).toContain("mergeWidgetDraftForMediaRefresh(beforeLoad, liveDraft)")
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
    expect(PIPPIT_WIDGET_HTML).toContain(
      "if (!widgetDraftPayloadEquals(mergedDraft, restored)) editIdempotencyKey = undefined;",
    )
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

  it("declares the standard MCP tool capability state exactly once", () => {
    expect(PIPPIT_WIDGET_HTML.match(/var serverToolsAvailable = false;/g)).toHaveLength(1)
    expect(PIPPIT_WIDGET_HTML.match(/var serverResourcesAvailable = false;/g)).toHaveLength(1)
  })

  it("submits edit instructions through the shared MCP tool without preview URLs", () => {
    const start = PIPPIT_WIDGET_HTML.indexOf("async function submitEdit()")
    const end = PIPPIT_WIDGET_HTML.indexOf("async function requestDisplayMode(mode)")
    const submitSource = PIPPIT_WIDGET_HTML.slice(start, end)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(submitSource).toContain('callTool("pippit_edit_video_segment", args)')
    expect(submitSource).toContain("source_job_id: sourceJobId")
    expect(submitSource).toContain("source_index: sourceIndex")
    expect(submitSource).toContain("segment: { start_ms: segmentStartMs, end_ms: segmentEndMs }")
    expect(submitSource).toContain("instruction: annotation.instruction")
    expect(submitSource).not.toContain("media.url")
    expect(submitSource).not.toContain("videoElement.src")
    expect(submitSource).toContain("if (submitting")
    expect(submitSource).toContain("if (!editIdempotencyKey)")
    expect(submitSource).toContain("setEditError(toolErrorText(result))")
    expect(submitSource).toContain('showLoading("pending")')
    expect(submitSource).toContain('requestDisplayMode("inline")')
    expect(submitSource).toContain("showEditor()")
    expect(submitSource).toContain("generationEpoch += 1")
    expect(submitSource).toContain("clearPollTimer()")
    expect(submitSource.indexOf('showLoading("pending")')).toBeLessThan(
      submitSource.indexOf('callTool("pippit_edit_video_segment", args)'),
    )
    expect(submitSource.indexOf('requestDisplayMode("inline")')).toBeLessThan(
      submitSource.indexOf('callTool("pippit_edit_video_segment", args)'),
    )
    expect(submitSource.indexOf("render(result)")).toBeGreaterThan(
      submitSource.indexOf('callTool("pippit_edit_video_segment", args)'),
    )
  })

  it("cleans up pending requests and media on teardown", () => {
    expect(PIPPIT_WIDGET_HTML).toContain("pending.forEach")
    expect(PIPPIT_WIDGET_HTML).toContain("pending.clear()")
    expect(PIPPIT_WIDGET_HTML).toContain("clientRequests.clear()")
    expect(PIPPIT_WIDGET_HTML).toContain('state.cancel(new Error("Widget was closed."))')
    expect(PIPPIT_WIDGET_HTML).toContain("resizeObserver.disconnect()")
    expect(PIPPIT_WIDGET_HTML).toContain('videoElement.removeAttribute("src")')
    expect(PIPPIT_WIDGET_HTML).toContain("URL.revokeObjectURL(previewObjectUrl)")
  })
})
