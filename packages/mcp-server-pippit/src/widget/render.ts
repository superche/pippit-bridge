export type WidgetRenderView = "editor" | "loading" | "terminal"

export interface WidgetRenderModel {
  loadingText?: string
  view: WidgetRenderView
}

export interface WidgetPresentationPlan {
  clearPoll: boolean
  clearPreviewRenewal: boolean
  schedulePoll: boolean
  view?: WidgetRenderView
}

export function resolveWidgetRenderView(
  status: string,
  hasPreview: boolean,
  awaitingPreview: boolean,
): WidgetRenderView | undefined {
  if (status === "pending" || status === "in_progress" || awaitingPreview) return "loading"
  if (status === "failed" || status === "cancelled" || status === "expired") return "terminal"
  if (hasPreview) return "editor"
  return undefined
}

export function planWidgetPresentation(
  status: string,
  hasPreview: boolean,
  awaitingPreview: boolean,
): WidgetPresentationPlan {
  const view = resolveWidgetRenderView(status, hasPreview, awaitingPreview)
  return {
    clearPoll: view === "editor" || view === "terminal",
    clearPreviewRenewal: view === "loading" || view === "terminal",
    schedulePoll: view === "loading",
    ...(view === undefined ? {} : { view }),
  }
}

export function widgetLoadingCopy(status: string, awaitingPreview: boolean): string {
  if (status === "in_progress") return "Generating your video…"
  if (awaitingPreview) return "Preparing the local preview…"
  return "Preparing your video…"
}

export function resolveWidgetRenderModel(
  state: { awaitingPreview: boolean; status: string; view: WidgetRenderView },
): WidgetRenderModel {
  return state.view === "loading"
    ? { loadingText: widgetLoadingCopy(state.status, state.awaitingPreview), view: state.view }
    : { view: state.view }
}
