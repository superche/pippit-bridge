export type WidgetView = "editor" | "loading" | "terminal"

export interface WidgetMachineState {
  activeJobId?: string
  activeModel?: string
  awaitingPreview: boolean
  destroyed: boolean
  displayMode?: string
  draft: WidgetMachineDraft
  generationEpoch: number
  persistedActiveJobId?: string
  pollInFlightEpoch?: number
  previewGeneration: number
  previewIdentity?: string
  previewLoading: boolean
  previewRenewalAtMs?: number
  protocolReady: boolean
  resourceBridgeDemoted: boolean
  status: string
  view: WidgetView
}

export interface WidgetMachineDraft {
  annotationCount: number
  prompt: string
  segmentEndMs: number
  segmentStartMs: number
}

export type WidgetEvent =
  | { type: "begin-generation" }
  | { identity?: string; type: "begin-preview" }
  | { activeJobId: string; activeModel?: string; awaitingPreview: boolean; status: string; type: "job-received" }
  | { draft: WidgetMachineDraft; type: "draft-changed" }
  | { type: "destroy" }
  | { mode: string; type: "display-mode" }
  | { epoch: number; type: "poll-finished" }
  | { epoch: number; type: "poll-started" }
  | { type: "preview-failed" }
  | { type: "preview-ready" }
  | { expiresAtMs?: number; type: "preview-renewal-scheduled" }
  | { type: "resource-bridge-demoted" }
  | { activeJobId: string; type: "state-persisted" }
  | { type: "protocol-ready" }
  | { status?: string; type: "show"; view: WidgetView }

export type WidgetEffect =
  | { type: "cancel-async" }
  | { type: "pause-video" }
  | { type: "start-loader" }
  | { type: "stop-loader" }

export interface WidgetTransition {
  effects: WidgetEffect[]
  state: WidgetMachineState
}

export function createInitialWidgetState(): WidgetMachineState {
  return {
    destroyed: false,
    awaitingPreview: false,
    draft: { annotationCount: 0, prompt: "", segmentEndMs: 0, segmentStartMs: 0 },
    generationEpoch: 0,
    previewGeneration: 0,
    previewLoading: false,
    protocolReady: false,
    resourceBridgeDemoted: false,
    status: "pending",
    view: "loading",
  }
}

export function reduceWidgetState(
  state: WidgetMachineState,
  event: WidgetEvent,
): WidgetTransition {
  if (state.destroyed && event.type !== "destroy") return { effects: [], state }

  if (event.type === "begin-generation") {
    return {
      effects: [],
      state: { ...state, generationEpoch: state.generationEpoch + 1 },
    }
  }
  if (event.type === "begin-preview") {
    return {
      effects: [],
      state: {
        ...state,
        ...(event.identity === undefined ? {} : { previewIdentity: event.identity }),
        previewGeneration: state.previewGeneration + 1,
        previewLoading: true,
      },
    }
  }
  if (event.type === "job-received") {
    return {
      effects: [],
      state: {
        ...state,
        activeJobId: event.activeJobId,
        ...(event.activeModel === undefined ? {} : { activeModel: event.activeModel }),
        awaitingPreview: event.awaitingPreview,
        status: event.status,
      },
    }
  }
  if (event.type === "draft-changed") return { effects: [], state: { ...state, draft: event.draft } }
  if (event.type === "display-mode") return { effects: [], state: { ...state, displayMode: event.mode } }
  if (event.type === "poll-started") {
    return { effects: [], state: { ...state, pollInFlightEpoch: event.epoch } }
  }
  if (event.type === "poll-finished") {
    if (state.pollInFlightEpoch !== event.epoch) return { effects: [], state }
    const { pollInFlightEpoch: _finished, ...rest } = state
    return { effects: [], state: rest }
  }
  if (event.type === "preview-ready") {
    return { effects: [], state: { ...state, awaitingPreview: false, previewLoading: false } }
  }
  if (event.type === "preview-failed") {
    return { effects: [], state: { ...state, previewLoading: false } }
  }
  if (event.type === "preview-renewal-scheduled") {
    if (event.expiresAtMs === undefined) {
      const { previewRenewalAtMs: _cleared, ...rest } = state
      return { effects: [], state: rest }
    }
    return { effects: [], state: { ...state, previewRenewalAtMs: event.expiresAtMs } }
  }
  if (event.type === "resource-bridge-demoted") {
    return { effects: [], state: { ...state, resourceBridgeDemoted: true } }
  }
  if (event.type === "state-persisted") {
    return { effects: [], state: { ...state, persistedActiveJobId: event.activeJobId } }
  }
  if (event.type === "protocol-ready") {
    return { effects: [], state: { ...state, protocolReady: true } }
  }
  if (event.type === "destroy") {
    if (state.destroyed) return { effects: [], state }
    return {
      effects: [{ type: "cancel-async" }, { type: "pause-video" }, { type: "stop-loader" }],
      state: {
        ...state,
        destroyed: true,
        generationEpoch: state.generationEpoch + 1,
        previewGeneration: state.previewGeneration + 1,
      },
    }
  }

  const effects: WidgetEffect[] = event.view === "loading"
    ? [{ type: "pause-video" }, { type: "start-loader" }]
    : event.view === "terminal"
      ? [{ type: "pause-video" }, { type: "stop-loader" }]
      : [{ type: "stop-loader" }]
  return {
    effects,
    state: {
      ...state,
      status: event.status ?? state.status,
      view: event.view,
    },
  }
}
