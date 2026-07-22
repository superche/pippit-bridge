export type PreviewUpdateKind = "new-source" | "renewed-url" | "unchanged"

export interface WidgetRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface WidgetDraftAnnotation {
  at_ms: number
  instruction: string
  region: WidgetRegion
  id?: string
}

export interface WidgetDraftState {
  annotations: WidgetDraftAnnotation[]
  currentTimeMs: number
  prompt: string
  segmentEndMs: number
  segmentStartMs: number
}

export interface WidgetRegionKeyResult {
  handled: boolean
  region?: WidgetRegion
}

export type WidgetTheme = "dark" | "light"

export function resolveWidgetTheme(
  hostTheme: unknown,
  legacyTheme: unknown,
  prefersDark: boolean,
): WidgetTheme {
  if (hostTheme === "dark" || hostTheme === "light") return hostTheme
  if (legacyTheme === "dark" || legacyTheme === "light") return legacyTheme
  return prefersDark ? "dark" : "light"
}

export function classifyPreviewUpdate(
  currentJobId: string | undefined,
  currentIndex: number,
  currentUrl: string | undefined,
  hasInitializedDraft: boolean,
  nextJobId: string,
  nextIndex: number,
  nextUrl: string,
): PreviewUpdateKind {
  if (!currentJobId || currentJobId !== nextJobId || currentIndex !== nextIndex) return "new-source"
  if (currentUrl === nextUrl) return "unchanged"
  return hasInitializedDraft ? "renewed-url" : "new-source"
}

export function shouldAcceptWidgetJobResult(
  activeJobId: string | undefined,
  incomingJobId: string,
  regenerationPending: boolean,
  authoritativeTransition = false,
): boolean {
  if (authoritativeTransition) return true
  if (regenerationPending) return false
  return activeJobId === undefined || activeJobId === incomingJobId
}

export function resolveWidgetModel(
  currentModel: string | undefined,
  incomingModel: unknown,
): string | undefined {
  return typeof incomingModel === "string" && incomingModel.trim() !== ""
    ? incomingModel
    : currentModel
}

export function reconcileWidgetDraftForDuration(
  draft: WidgetDraftState,
  nextDurationMs: number,
  maxSegmentMs = 30_000,
): WidgetDraftState {
  const durationMs = Number.isFinite(nextDurationMs) ? Math.max(0, Math.floor(nextDurationMs)) : 0
  if (durationMs === 0) {
    return {
      ...draft,
      annotations: [],
      currentTimeMs: 0,
      segmentEndMs: 0,
      segmentStartMs: 0,
    }
  }

  const minimumGap = Math.min(100, durationMs)
  let segmentStartMs = Math.min(Math.max(0, draft.segmentStartMs), Math.max(0, durationMs - minimumGap))
  let segmentEndMs = Math.min(Math.max(minimumGap, draft.segmentEndMs), durationMs)
  if (segmentEndMs <= segmentStartMs) segmentEndMs = Math.min(durationMs, segmentStartMs + minimumGap)
  if (segmentEndMs - segmentStartMs > maxSegmentMs) {
    segmentEndMs = Math.min(durationMs, segmentStartMs + maxSegmentMs)
  }

  return {
    ...draft,
    annotations: draft.annotations.filter(
      annotation => annotation.at_ms >= segmentStartMs && annotation.at_ms <= segmentEndMs,
    ),
    currentTimeMs: Math.min(Math.max(0, draft.currentTimeMs), durationMs),
    segmentEndMs: Math.round(segmentEndMs),
    segmentStartMs: Math.round(segmentStartMs),
  }
}

export function mergeWidgetDraftForMediaRefresh(
  beforeLoad: WidgetDraftState,
  liveDraft: WidgetDraftState,
): WidgetDraftState {
  return { ...liveDraft, currentTimeMs: beforeLoad.currentTimeMs }
}

export function widgetDraftPayloadEquals(left: WidgetDraftState, right: WidgetDraftState): boolean {
  if (
    left.prompt !== right.prompt ||
    left.segmentStartMs !== right.segmentStartMs ||
    left.segmentEndMs !== right.segmentEndMs ||
    left.annotations.length !== right.annotations.length
  ) {
    return false
  }

  return left.annotations.every((annotation, index) => {
    const candidate = right.annotations[index]
    return (
      candidate !== undefined &&
      annotation.at_ms === candidate.at_ms &&
      annotation.instruction === candidate.instruction &&
      annotation.region.x === candidate.region.x &&
      annotation.region.y === candidate.region.y &&
      annotation.region.width === candidate.region.width &&
      annotation.region.height === candidate.region.height
    )
  })
}

export function adjustWidgetRegionFromKey(
  region: WidgetRegion | undefined,
  key: string,
  shiftKey: boolean,
  step = 0.02,
): WidgetRegionKeyResult {
  if (key === "Escape") return { handled: true }
  if (key === "Enter" || key === " ") {
    return { handled: true, region: region ?? { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }
  }
  if (!region || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) {
    return { handled: false }
  }

  const next = { ...region }
  if (shiftKey) {
    if (key === "ArrowLeft") next.width = Math.max(0.01, next.width - step)
    if (key === "ArrowRight") next.width = Math.min(1 - next.x, next.width + step)
    if (key === "ArrowUp") next.height = Math.max(0.01, next.height - step)
    if (key === "ArrowDown") next.height = Math.min(1 - next.y, next.height + step)
  } else {
    if (key === "ArrowLeft") next.x = Math.max(0, next.x - step)
    if (key === "ArrowRight") next.x = Math.min(1 - next.width, next.x + step)
    if (key === "ArrowUp") next.y = Math.max(0, next.y - step)
    if (key === "ArrowDown") next.y = Math.min(1 - next.height, next.y + step)
  }

  next.x = Math.min(0.99, Math.max(0, Number(next.x.toFixed(6))))
  next.y = Math.min(0.99, Math.max(0, Number(next.y.toFixed(6))))
  next.width = Math.min(1 - next.x, Math.max(0.01, Number(next.width.toFixed(6))))
  next.height = Math.min(1 - next.y, Math.max(0.01, Number(next.height.toFixed(6))))
  next.width = Number(next.width.toFixed(6))
  next.height = Number(next.height.toFixed(6))
  return { handled: true, region: next }
}
