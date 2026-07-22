import { readFile } from "node:fs/promises"
import { describe, expect, it, vi } from "vitest"

import {
  buildWidgetEditPayload,
  createInitialWidgetState,
  createWidgetEpochTicket,
  isWidgetEpochTicketCurrent,
  planWidgetPreviewChunks,
  planWidgetPresentation,
  reduceWidgetState,
  resolveWidgetRenderView,
  selectWidgetToolTransport,
  validateWidgetPreviewChunk,
  WidgetController,
  WidgetPreviewLoader,
  WidgetRequestManager,
} from "../src/widget.ts"

interface FrozenV14Scenario {
  awaitingPreview: boolean
  clearPoll: boolean
  clearPreviewRenewal: boolean
  hasPreview: boolean
  schedulePoll: boolean
  status: string
  view: "editor" | "loading" | "terminal"
}

const frozenV14 = JSON.parse(await readFile(
  new URL("./fixtures/widget-v14-presentation.json", import.meta.url),
  "utf8",
)) as {
  scenarios: FrozenV14Scenario[]
  source: { baselineCommit: string; widgetBlob: string }
}

describe("Widget v15 state machine", () => {
  it.each(frozenV14.scenarios)("matches frozen v14 presentation for $status", (scenario) => {
    expect(frozenV14.source).toEqual({
      baselineCommit: "e022f1117da8a7bef2b80a796fcd9c1a0a556fa9",
      widgetBlob: "2edbb29ba6b9d46b63862d78409eb0c95ddf48e5",
    })
    expect(planWidgetPresentation(
      scenario.status,
      scenario.hasPreview,
      scenario.awaitingPreview,
    )).toEqual({
      clearPoll: scenario.clearPoll,
      clearPreviewRenewal: scenario.clearPreviewRenewal,
      schedulePoll: scenario.schedulePoll,
      view: scenario.view,
    })
    expect(resolveWidgetRenderView(
      scenario.status,
      scenario.hasPreview,
      scenario.awaitingPreview,
    )).toBe(scenario.view)
  })

  it("keeps failed, cancelled, and expired as distinct terminal statuses", () => {
    for (const status of ["failed", "cancelled", "expired"]) {
      const transition = reduceWidgetState(createInitialWidgetState(), {
        status,
        type: "show",
        view: "terminal",
      })
      expect(transition.state).toMatchObject({ status, view: "terminal" })
      expect(transition.effects).toEqual([{ type: "pause-video" }, { type: "stop-loader" }])
    }
  })

  it("fences generation and preview work and invalidates both on teardown", () => {
    let state = createInitialWidgetState()
    state = reduceWidgetState(state, { type: "begin-generation" }).state
    state = reduceWidgetState(state, { type: "begin-preview" }).state
    const generation = createWidgetEpochTicket("generation", state.generationEpoch, "job-1")
    const preview = createWidgetEpochTicket("preview", state.previewGeneration, "job-1")

    expect(isWidgetEpochTicketCurrent(generation, state.generationEpoch, "job-1", state.destroyed)).toBe(true)
    expect(isWidgetEpochTicketCurrent(preview, state.previewGeneration, "job-1", state.destroyed)).toBe(true)
    expect(isWidgetEpochTicketCurrent(generation, state.generationEpoch, "job-2", state.destroyed)).toBe(false)

    const destroyed = reduceWidgetState(state, { type: "destroy" })
    expect(destroyed.state).toMatchObject({
      destroyed: true,
      generationEpoch: state.generationEpoch + 1,
      previewGeneration: state.previewGeneration + 1,
    })
    expect(destroyed.effects.map(effect => effect.type)).toEqual([
      "cancel-async",
      "pause-video",
      "stop-loader",
    ])
    expect(isWidgetEpochTicketCurrent(
      generation,
      destroyed.state.generationEpoch,
      "job-1",
      destroyed.state.destroyed,
    )).toBe(false)
    expect(reduceWidgetState(destroyed.state, { type: "begin-generation" }).state).toBe(destroyed.state)
  })

  it("keeps job, draft, preview, poll, fallback, and display state in the typed reducer", () => {
    let state = createInitialWidgetState()
    state = reduceWidgetState(state, {
      activeJobId: "job-typed",
      activeModel: "pippit/seedance",
      awaitingPreview: true,
      status: "completed",
      type: "job-received",
    }).state
    state = reduceWidgetState(state, {
      draft: { hasAnnotation: true, instruction: "change", segmentEndMs: 2_000, segmentStartMs: 1_000 },
      type: "draft-changed",
    }).state
    state = reduceWidgetState(state, { identity: "preview-1", type: "begin-preview" }).state
    state = reduceWidgetState(state, { epoch: state.generationEpoch, type: "poll-started" }).state
    state = reduceWidgetState(state, { type: "resource-bridge-demoted" }).state
    state = reduceWidgetState(state, { mode: "fullscreen", type: "display-mode" }).state
    expect(state).toMatchObject({
      activeJobId: "job-typed",
      activeModel: "pippit/seedance",
      awaitingPreview: true,
      displayMode: "fullscreen",
      draft: { hasAnnotation: true, instruction: "change", segmentEndMs: 2_000, segmentStartMs: 1_000 },
      pollInFlightEpoch: state.generationEpoch,
      previewIdentity: "preview-1",
      previewLoading: true,
      resourceBridgeDemoted: true,
      status: "completed",
    })
    state = reduceWidgetState(state, { epoch: state.generationEpoch, type: "poll-finished" }).state
    state = reduceWidgetState(state, { type: "preview-ready" }).state
    expect(state.pollInFlightEpoch).toBeUndefined()
    expect(state).toMatchObject({ awaitingPreview: false, previewLoading: false })
  })

  it("executes polling, persistence, and display-mode fallback through the typed controller", async () => {
    const events: Record<string, unknown>[] = []
    const callTool = vi.fn(async () => ({ structuredContent: { id: "job-controller", status: "pending" } }))
    const persistActiveJobId = vi.fn(async () => undefined)
    const requestStandardDisplayMode = vi.fn(async () => "inline")
    const requestLegacyDisplayMode = vi.fn(async () => "fullscreen")
    const controller = new WidgetController({
      callTool,
      dispatch(event) { events.push(event) },
      persistActiveJobId,
      requestLegacyDisplayMode,
      requestStandardDisplayMode,
    })
    await expect(controller.poll("job-controller", 3)).resolves.toMatchObject({
      structuredContent: { id: "job-controller" },
    })
    expect(callTool).toHaveBeenCalledWith("pippit_get_video", { job_id: "job-controller" })
    expect(events.slice(0, 2)).toEqual([
      { epoch: 3, type: "poll-started" },
      { epoch: 3, type: "poll-finished" },
    ])
    await controller.persistActiveJobId("job-controller")
    expect(persistActiveJobId).toHaveBeenCalledWith("job-controller")
    expect(events).toContainEqual({ activeJobId: "job-controller", type: "state-persisted" })
    await expect(controller.requestDisplayMode("fullscreen", true)).resolves.toBe("fullscreen")
    expect(requestStandardDisplayMode).toHaveBeenCalledWith("fullscreen")
    expect(requestLegacyDisplayMode).toHaveBeenCalledWith("fullscreen")
    expect(events).toContainEqual({ mode: "fullscreen", type: "display-mode" })
    expect(controller.previewRenewalDelay(Number.NaN, 0)).toBeUndefined()
    expect(events).toContainEqual({ type: "preview-renewal-scheduled" })
  })

  it("chooses standard and legacy tool bridges without retrying paid writes", () => {
    expect(selectWidgetToolTransport({
      legacyAvailable: true,
      protocolReady: true,
      retrySafe: true,
      serverToolsAvailable: true,
      toolName: "pippit_get_video",
    })).toEqual({ fallback: "legacy", primary: "standard" })
    expect(selectWidgetToolTransport({
      legacyAvailable: true,
      protocolReady: false,
      retrySafe: true,
      serverToolsAvailable: false,
      toolName: "pippit_get_video",
    })).toEqual({ primary: "legacy" })
    expect(selectWidgetToolTransport({
      legacyAvailable: true,
      protocolReady: true,
      retrySafe: false,
      serverToolsAvailable: true,
      toolName: "pippit_edit_video_segment",
    })).toEqual({ primary: "standard" })
    expect(selectWidgetToolTransport({
      legacyAvailable: false,
      protocolReady: false,
      retrySafe: false,
      serverToolsAvailable: false,
      toolName: "pippit_edit_video_segment",
    })).toEqual({ primary: "unavailable" })
  })

  it("plans, validates, supersedes, and tears down local preview loads", () => {
    const plans = planWidgetPreviewChunks(10, 4, 12)
    expect(plans).toEqual([
      { bytes: 4, complete: false, offset: 0 },
      { bytes: 4, complete: false, offset: 4 },
      { bytes: 2, complete: true, offset: 8 },
    ])
    expect(validateWidgetPreviewChunk(
      { ...plans[2]!, total_bytes: 10 },
      plans[2]!,
      10,
    )).toBe(true)
    expect(validateWidgetPreviewChunk(
      { ...plans[2]!, complete: false, total_bytes: 10 },
      plans[2]!,
      10,
    )).toBe(false)

    const loader = new WidgetPreviewLoader()
    const first = loader.begin()
    const second = loader.begin()
    expect(first.signal.aborted).toBe(true)
    expect(loader.current(first)).toBe(false)
    expect(loader.current(second)).toBe(true)

    const revoke = vi.fn()
    expect(loader.createObjectUrl(
      [new Uint8Array([1])],
      "video/mp4",
      () => "blob:first",
      revoke,
    )).toBe("blob:first")
    expect(loader.hasObjectUrl()).toBe(true)
    loader.teardown(revoke)
    expect(second.signal.aborted).toBe(true)
    expect(revoke).toHaveBeenCalledWith("blob:first")
    expect(loader.hasObjectUrl()).toBe(false)
  })

  it("builds one annotation payload without leaking UI ids or an overall prompt", () => {
    expect(buildWidgetEditPayload({
      annotation: {
        at_ms: 1000,
        id: "ui-only",
        instruction: "  replace logo  ",
        region: { height: 0.4, width: 0.3, x: 0.1, y: 0.2 },
      },
      model: "pippit/seedance",
      segmentEndMs: 5000,
      segmentStartMs: 1000,
      sourceIndex: 2,
      sourceJobId: "job-source",
    })).toEqual({
      annotations: [{
        at_ms: 1000,
        instruction: "replace logo",
        region: { height: 0.4, width: 0.3, x: 0.1, y: 0.2 },
      }],
      model: "pippit/seedance",
      segment: { end_ms: 5000, start_ms: 1000 },
      source_index: 2,
      source_job_id: "job-source",
    })
    expect(() => buildWidgetEditPayload({
      annotation: {
        at_ms: 1000,
        instruction: "   ",
        region: { height: 0.4, width: 0.3, x: 0.1, y: 0.2 },
      },
      model: "pippit/seedance",
      segmentEndMs: 5000,
      segmentStartMs: 1000,
      sourceIndex: 2,
      sourceJobId: "job-source",
    })).toThrow("Annotation instruction is required")
  })

  it("times out standard and legacy bridge calls and cancels both during teardown", async () => {
    vi.useFakeTimers()
    const manager = new WidgetRequestManager({
      clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
      setTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
    })
    const standard = manager.request(1, "tools/call", {}, 50, vi.fn())
    const legacy = manager.runClient(() => new Promise(() => undefined), 50)
    const standardTimeout = expect(standard).rejects.toThrow("tools/call timed out")
    const legacyTimeout = expect(legacy).rejects.toThrow("tools/call timed out")
    await vi.advanceTimersByTimeAsync(50)
    await standardTimeout
    await legacyTimeout

    const pendingStandard = manager.request(2, "resources/read", {}, 500, vi.fn())
    const pendingLegacy = manager.runClient(() => new Promise(() => undefined), 500)
    const standardClosed = expect(pendingStandard).rejects.toThrow("Widget was closed.")
    const legacyClosed = expect(pendingLegacy).rejects.toThrow("Widget was closed.")
    manager.cancelAll(new Error("Widget was closed."))
    await standardClosed
    await legacyClosed
    vi.useRealTimers()
  })
})
