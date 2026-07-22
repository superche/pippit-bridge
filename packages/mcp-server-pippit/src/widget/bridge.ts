export type WidgetToolTransport = "legacy" | "standard" | "unavailable"

export interface WidgetToolTransportPlan {
  fallback?: WidgetToolTransport
  primary: WidgetToolTransport
}

export interface WidgetToolTransportState {
  legacyAvailable: boolean
  protocolReady: boolean
  retrySafe: boolean
  serverToolsAvailable: boolean
  toolName: string
}

export function selectWidgetToolTransport(
  state: WidgetToolTransportState,
): WidgetToolTransportPlan {
  if (state.toolName === "pippit_read_video_chunk" && state.legacyAvailable) {
    return state.serverToolsAvailable
      ? { fallback: "standard", primary: "legacy" }
      : { primary: "legacy" }
  }
  if (!state.protocolReady && state.retrySafe && state.legacyAvailable) {
    return { primary: "legacy" }
  }
  if (state.serverToolsAvailable) {
    return state.retrySafe && state.legacyAvailable
      ? { fallback: "legacy", primary: "standard" }
      : { primary: "standard" }
  }
  return { primary: state.legacyAvailable ? "legacy" : "unavailable" }
}
