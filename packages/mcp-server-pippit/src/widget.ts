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

export const PIPPIT_WIDGET_URI = "ui://widget/pippit-video-job-v7.html"

/**
 * A dependency-free MCP App. Business actions always call the shared MCP
 * runtime; ChatGPT-specific globals are capability-detected fallbacks.
 */
export const PIPPIT_WIDGET_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pippit video editor</title>
  <style>
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", sans-serif;
      background: #f5f5f7;
      color: #1d1d1f;
      font-synthesis: none;
    }
    * { box-sizing: border-box; }
    body {
      min-width: 0;
      margin: 0;
      padding: 24px;
      background: #f5f5f7;
      color: #1d1d1f;
      font-size: 17px;
      letter-spacing: -.022em;
      line-height: 1.47;
      -webkit-font-smoothing: antialiased;
    }
    button, input, textarea { font: inherit; }
    button {
      min-width: 44px;
      min-height: 44px;
      border: 1px solid #0066cc;
      border-radius: 999px;
      padding: 11px 22px;
      background: transparent;
      color: #0066cc;
      cursor: pointer;
      font-size: 14px;
      font-weight: 400;
      line-height: 20px;
      transition: background-color 160ms ease, color 160ms ease, transform 120ms ease;
    }
    button:hover:not(:disabled) { background: #fafafc; }
    button:active:not(:disabled) { transform: scale(.95); }
    button:focus-visible, input:focus-visible, textarea:focus-visible {
      outline: 2px solid #0071e3;
      outline-offset: 2px;
    }
    button:disabled, input:disabled, textarea:disabled { cursor: default; opacity: .5; }
    input[type="range"] {
      min-height: 44px;
      margin: 0;
      accent-color: #0066cc;
      cursor: pointer;
    }
    main {
      display: grid;
      width: min(100%, 960px);
      margin: 0 auto;
      gap: 17px;
    }
    header, .toolbar, .playback, .annotation-toolbar, .submit-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .hero { padding: 8px 4px 4px; }
    .title-copy { display: grid; gap: 4px; }
    .eyebrow {
      margin: 0;
      color: #6e6e73;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: .04em;
      line-height: 16px;
      text-transform: uppercase;
    }
    h1, h2 { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif; }
    h1 {
      margin: 0;
      font-size: clamp(28px, 5vw, 40px);
      font-weight: 600;
      letter-spacing: -.025em;
      line-height: 1.08;
    }
    h2 { margin: 0; font-size: 21px; font-weight: 600; letter-spacing: -.012em; line-height: 1.2; }
    .status {
      max-width: 50%;
      overflow: hidden;
      border: 1px solid #e0e0e0;
      border-radius: 999px;
      padding: 8px 12px;
      background: #ffffff;
      color: #6e6e73;
      font-size: 12px;
      line-height: 16px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status.completed { border-color: #0066cc; background: #0066cc; color: #ffffff; }
    .status.failed, .status.cancelled, .status.expired { border-color: #1d1d1f; color: #1d1d1f; }
    .summary, .utility-card {
      border: 1px solid #e0e0e0;
      border-radius: 18px;
      background: #ffffff;
    }
    .summary { display: grid; gap: 12px; padding: 17px 24px; }
    dl { display: grid; grid-template-columns: minmax(62px, auto) 1fr; gap: 8px 12px; margin: 0; font-size: 12px; line-height: 17px; }
    dt { color: #6e6e73; }
    dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
    .message, .hint, .error { margin: 0; font-size: 12px; line-height: 1.47; }
    .message, .hint { color: #6e6e73; }
    .error { border-left: 2px solid #0066cc; padding-left: 8px; color: #1d1d1f; }
    .editor { display: grid; gap: 17px; }
    .viewer-card {
      overflow: hidden;
      border: 1px solid #272729;
      border-radius: 18px;
      background: #272729;
      color: #ffffff;
    }
    .video-stage {
      position: relative;
      overflow: hidden;
      width: 100%;
      aspect-ratio: 16 / 9;
      background: #000000;
      touch-action: auto;
    }
    .video-stage.annotating { touch-action: none; }
    video { display: block; width: 100%; height: 100%; object-fit: contain; background: #000000; }
    .roi-layer { position: absolute; inset: 0; pointer-events: none; }
    .roi-layer.active { pointer-events: auto; cursor: crosshair; }
    .roi-layer:focus-visible { outline: 2px solid #2997ff; outline-offset: -4px; }
    .roi-box {
      position: absolute;
      display: none;
      border: 2px solid #2997ff;
      border-radius: 5px;
      background: rgb(41 151 255 / 16%);
      pointer-events: none;
    }
    .playback { justify-content: flex-start; padding: 12px 17px; }
    .viewer-card button { border-color: #2997ff; color: #2997ff; }
    .viewer-card button:hover:not(:disabled) { background: rgb(255 255 255 / 8%); }
    .viewer-card input[type="range"] { accent-color: #2997ff; }
    .playback input[type="range"] { flex: 1 1 180px; min-width: 120px; }
    .time { min-width: 96px; color: #cccccc; font-variant-numeric: tabular-nums; font-size: 12px; }
    .utility-card { display: grid; gap: 17px; padding: 24px; }
    .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .section-title { display: grid; gap: 4px; }
    .timeline-wrap { display: grid; gap: 8px; }
    .timeline {
      position: relative;
      height: 64px;
      overflow: hidden;
      border: 1px solid #e0e0e0;
      border-radius: 11px;
      background: #fafafc;
    }
    .timeline-shade { position: absolute; inset-block: 0; background: #e0e0e0; }
    .timeline-selection {
      position: absolute;
      inset-block: 0;
      border: 2px solid #0066cc;
      border-radius: 8px;
      background: rgb(0 102 204 / 10%);
      pointer-events: none;
    }
    .timeline-selection::before, .timeline-selection::after {
      content: "";
      position: absolute;
      top: 16px;
      width: 2px;
      height: 28px;
      border-radius: 2px;
      background: #0066cc;
    }
    .timeline-selection::before { left: 8px; }
    .timeline-selection::after { right: 8px; }
    .range-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 17px; }
    .range-field { display: grid; gap: 4px; color: #6e6e73; font-size: 12px; line-height: 17px; }
    .range-field input { width: 100%; }
    .annotation-toolbar { align-items: stretch; }
    .comment-input { display: flex; flex: 1 1 280px; gap: 8px; }
    .comment-input input, textarea {
      width: 100%;
      border: 1px solid #e0e0e0;
      background: #ffffff;
      color: #1d1d1f;
      font-size: 14px;
      line-height: 20px;
    }
    .comment-input input { min-height: 44px; border-radius: 999px; padding: 11px 20px; }
    textarea { min-height: 112px; border-radius: 11px; padding: 14px 17px; resize: vertical; }
    input::placeholder, textarea::placeholder { color: #6e6e73; opacity: 1; }
    .annotation-list { display: flex; gap: 8px; flex-wrap: wrap; }
    .annotation-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 100%;
      min-height: 44px;
      border: 1px solid #e0e0e0;
      border-radius: 999px;
      padding: 0 4px 0 8px;
      background: #fafafc;
      font-size: 12px;
    }
    .annotation-chip > button { min-width: 44px; min-height: 44px; border: 0; padding: 0 8px; background: transparent; }
    .annotation-chip .chip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .primary { min-height: 44px; border-color: #0066cc; background: #0066cc; color: #ffffff; }
    .primary:hover:not(:disabled) { border-color: #0071e3; background: #0071e3; }
    .annotation-active { border-color: #0066cc; background: #0066cc; color: #ffffff; }
    .instruction-field { display: grid; gap: 8px; }
    .submit-row { align-items: flex-start; }
    .submit-copy { display: grid; gap: 4px; flex: 1 1 260px; }
    .toolbar { justify-content: flex-end; padding: 0 4px 8px; }
    [hidden] { display: none !important; }

    @media (max-width: 640px) {
      body { padding: 12px; }
      main, .editor { gap: 12px; }
      .hero { padding-inline: 4px; }
      .utility-card { gap: 12px; padding: 17px; }
      .summary { padding: 17px; }
      .annotation-toolbar { display: grid; }
      .comment-input { width: 100%; }
    }

    @media (max-width: 480px) {
      body { padding: 8px; }
      .hero { align-items: flex-start; }
      .status { max-width: 44%; }
      .range-grid { grid-template-columns: 1fr; }
      .comment-input { display: grid; }
      .comment-input button, .submit-row .primary { width: 100%; }
      .submit-row { display: grid; }
      .playback { display: grid; grid-template-columns: auto 1fr; }
      .playback input[type="range"] { grid-column: 1 / -1; grid-row: 1; width: 100%; }
      .playback .time { justify-self: end; }
    }

    @media (prefers-reduced-motion: reduce) {
      button { transition: none; }
      button:active:not(:disabled) { transform: none; }
    }

    .loading-view {
      display: grid;
      min-height: 300px;
      place-content: center;
      justify-items: center;
      gap: 22px;
      text-align: center;
    }
    .loading-status {
      margin: 0;
      color: #6e6e73;
      font-size: 14px;
      font-weight: 500;
      letter-spacing: -.01em;
      line-height: 20px;
    }
    .infinity-loader {
      display: grid;
      grid-template-columns: repeat(5, 8px);
      grid-template-rows: repeat(5, 8px);
      gap: 6px;
      width: 64px;
      height: 64px;
      place-content: center;
      color: #1d1d1f;
    }
    .infinity-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
      opacity: .08;
      transition: opacity 40ms linear;
    }
    .terminal-view {
      display: grid;
      min-height: 220px;
      place-content: center;
      justify-items: center;
      gap: 8px;
      padding: 32px;
      text-align: center;
    }
    .terminal-view h1 { font-size: 28px; }
    .terminal-view p { max-width: 440px; margin: 0; color: #6e6e73; font-size: 14px; }
    .viewer-card { position: relative; }
    .video-stage { border-radius: 17px; }
    video { position: relative; z-index: 0; }
    .roi-layer { z-index: 2; }
    .roi-box { border-color: #ffd60a; background: rgb(255 214 10 / 18%); }
    .viewer-card .annotation-trigger {
      position: absolute;
      top: 12px;
      right: 12px;
      z-index: 3;
      display: grid;
      width: 44px;
      min-width: 44px;
      height: 44px;
      min-height: 44px;
      place-items: center;
      border: 1px solid rgb(255 255 255 / 32%);
      padding: 0;
      background: rgb(29 29 31 / 78%);
      color: #ffffff;
    }
    .viewer-card .annotation-trigger:hover:not(:disabled) { background: rgb(29 29 31 / 92%); }
    .annotation-trigger svg { width: 20px; height: 20px; pointer-events: none; }
    .viewer-card .annotation-trigger.annotation-active { border-color: #ffd60a; background: #ffd60a; color: #1d1d1f; }
    .annotation-popover {
      position: absolute;
      z-index: 4;
      display: grid;
      width: min(340px, calc(100% - 24px));
      gap: 8px;
      border: 1px solid #d2d2d7;
      border-radius: 14px;
      padding: 12px;
      background: #ffffff;
      color: #1d1d1f;
    }
    .annotation-popover textarea { min-height: 74px; padding: 10px 12px; }
    .popover-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .popover-actions button { min-height: 36px; padding: 7px 14px; }
    .viewer-card .annotation-popover .primary { border-color: #0066cc; background: #0066cc; color: #ffffff; }
    .viewer-card .annotation-popover .primary:hover:not(:disabled) { background: #0071e3; }
    .viewer-message { margin: 0; padding: 10px 14px; color: #cccccc; font-size: 12px; }
    .local-file {
      margin: 0;
      overflow-wrap: anywhere;
      border-top: 1px solid rgb(255 255 255 / 10%);
      padding: 10px 14px;
      color: #cccccc;
      font-size: 12px;
      user-select: text;
    }
    .trim-panel {
      display: grid;
      gap: 12px;
      border: 1px solid #e0e0e0;
      border-radius: 18px;
      padding: 17px;
      background: #ffffff;
    }
    .trim-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .trim-header h2 { font-size: 17px; }
    .trim-time { color: #6e6e73; font-size: 12px; font-variant-numeric: tabular-nums; }
    .trim-timeline {
      position: relative;
      height: 78px;
      margin-inline: 22px;
      border-radius: 8px;
      background: #272729;
      touch-action: none;
      user-select: none;
    }
    .filmstrip {
      position: absolute;
      inset: 0;
      display: grid;
      overflow: hidden;
      grid-template-columns: repeat(10, minmax(0, 1fr));
      border-radius: 7px;
      background: #3a3a3c;
    }
    .filmstrip-frame {
      min-width: 0;
      border-right: 1px solid rgb(255 255 255 / 18%);
      background-color: #48484a;
      background-position: center;
      background-repeat: no-repeat;
      background-size: cover;
    }
    .filmstrip-frame:last-child { border-right: 0; }
    .trim-shade {
      position: absolute;
      z-index: 1;
      inset-block: 0;
      background: rgb(0 0 0 / 62%);
      pointer-events: none;
    }
    .trim-selection {
      position: absolute;
      z-index: 2;
      inset-block: 0;
      border-block: 3px solid #ffd60a;
      pointer-events: none;
    }
    .trim-handle {
      position: absolute;
      z-index: 3;
      top: -3px;
      width: 44px;
      min-width: 44px;
      height: 84px;
      min-height: 44px;
      border: 0;
      border-radius: 8px;
      padding: 0;
      background: transparent;
      color: #1d1d1f;
      cursor: ew-resize;
      transform: translateX(-50%);
    }
    .trim-handle:hover:not(:disabled), .trim-handle:active:not(:disabled) { background: transparent; transform: translateX(-50%); }
    .trim-handle::before {
      content: "";
      position: absolute;
      inset-block: 0;
      left: 13px;
      width: 18px;
      border-radius: 7px;
      background: #ffd60a;
    }
    .trim-handle::after {
      content: "";
      position: absolute;
      top: 34px;
      left: 20px;
      width: 4px;
      height: 16px;
      border-radius: 2px;
      background: #1d1d1f;
    }
    .trim-help { margin: 0; color: #6e6e73; font-size: 12px; }
    .annotation-list:empty { display: none; }
    .edit-compose { display: grid; gap: 12px; }
    .edit-compose textarea { min-height: 116px; }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      white-space: nowrap;
    }

    @media (max-width: 640px) {
      .loading-view { min-height: 240px; }
      .trim-panel { padding: 14px; }
      .trim-timeline { margin-inline: 18px; }
      .trim-header { align-items: flex-start; flex-direction: column; gap: 2px; }
      .annotation-popover { width: calc(100% - 24px); }
    }

    @media (prefers-reduced-motion: reduce) {
      .infinity-dot { transition: none; }
    }
  </style>
</head>
<body>
  <main>
    <section id="loading-view" class="loading-view" role="status" aria-live="polite">
      <div id="infinity-loader" class="infinity-loader" aria-hidden="true"></div>
      <p id="status" class="loading-status">Preparing your video…</p>
    </section>

    <section id="terminal-view" class="terminal-view" hidden>
      <h1 id="terminal-title">Video unavailable</h1>
      <p id="message">This video could not be completed. Please try again.</p>
    </section>

    <section id="editor" class="editor" aria-label="Edit generated video" hidden>
      <div class="viewer-card">
        <div id="video-stage" class="video-stage">
          <video id="video" controls crossorigin="anonymous" playsinline preload="metadata"></video>
          <div
            id="roi-layer"
            class="roi-layer"
            role="group"
            tabindex="-1"
            aria-disabled="true"
            aria-keyshortcuts="Enter Space ArrowUp ArrowDown ArrowLeft ArrowRight Escape"
            aria-label="Video region selector. Press Enter or Space to create a centered region. Use arrow keys to move it, hold Shift with arrow keys to resize it, and press Escape to clear it."
          >
            <div id="roi-box" class="roi-box"></div>
          </div>
          <button id="annotate" class="annotation-trigger" type="button" aria-pressed="false" aria-label="Annotate a video region" title="Annotate a video region">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4M12 8v8M8 12h8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8"/>
            </svg>
          </button>
          <div id="annotation-popover" class="annotation-popover" hidden>
            <label class="visually-hidden" for="comment">Regional edit instruction</label>
            <textarea id="comment" maxlength="2000" aria-label="Regional edit instruction" placeholder="Describe what should change in this area…" disabled></textarea>
            <div class="popover-actions">
              <button id="cancel-comment" type="button">Cancel</button>
              <button id="insert-comment" class="primary" type="button" disabled>Add annotation</button>
            </div>
          </div>
        </div>
        <p id="media-message" class="viewer-message" aria-live="polite" hidden></p>
        <p id="local-file" class="local-file" hidden></p>
      </div>

      <section class="trim-panel" aria-labelledby="trim-heading">
        <div class="trim-header">
          <h2 id="trim-heading">Trim</h2>
          <output id="selection-label" class="trim-time">00:00.0 — 00:00.0</output>
        </div>
        <div id="timeline" class="trim-timeline" aria-label="Video trim range">
          <div id="filmstrip" class="filmstrip" aria-hidden="true">
            <span class="filmstrip-frame"></span><span class="filmstrip-frame"></span><span class="filmstrip-frame"></span><span class="filmstrip-frame"></span><span class="filmstrip-frame"></span>
            <span class="filmstrip-frame"></span><span class="filmstrip-frame"></span><span class="filmstrip-frame"></span><span class="filmstrip-frame"></span><span class="filmstrip-frame"></span>
          </div>
          <div id="shade-left" class="trim-shade"></div>
          <div id="selection" class="trim-selection"></div>
          <div id="shade-right" class="trim-shade"></div>
          <button id="segment-start" class="trim-handle" type="button" role="slider" aria-label="Trim start" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="00:00.0"></button>
          <button id="segment-end" class="trim-handle" type="button" role="slider" aria-label="Trim end" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="00:00.0"></button>
        </div>
        <p class="trim-help">Drag the yellow handles to choose up to 30 seconds. Use arrow keys for precise trimming.</p>
      </section>

      <div id="annotations" class="annotation-list" aria-live="polite"></div>

      <section class="edit-compose" aria-label="Edit direction">
        <label class="visually-hidden" for="prompt">Edit direction</label>
        <textarea id="prompt" maxlength="20000" aria-label="Edit direction" placeholder="Describe how the selected time range should change…"></textarea>
        <div class="submit-row">
          <div class="submit-copy">
            <p class="hint">The selected range and any region annotations guide the edit.</p>
            <p id="edit-error" class="error" role="alert" hidden></p>
          </div>
          <button id="submit-edit" class="primary" type="button" disabled>Start edit</button>
        </div>
      </section>
    </section>
  </main>
  <script>
    (function () {
      "use strict";

      var classifyPreviewUpdate = ${classifyPreviewUpdate.toString()};
      var reconcileWidgetDraftForDuration = ${reconcileWidgetDraftForDuration.toString()};
      var mergeWidgetDraftForMediaRefresh = ${mergeWidgetDraftForMediaRefresh.toString()};
      var widgetDraftPayloadEquals = ${widgetDraftPayloadEquals.toString()};
      var adjustWidgetRegionFromKey = ${adjustWidgetRegionFromKey.toString()};

      var MAX_ANNOTATIONS = 20;
      var MAX_SEGMENT_MS = 30000;
      var protocolVersion = "2026-01-26";
      var nextId = 1;
      var pending = new Map();
      var protocolReady = false;
      var serverToolsAvailable = false;
      var hostContext = {};
      var activeJobId;
      var activeModel;
      var activeStatus = "pending";
      var sourceJobId;
      var sourceIndex = 0;
      var previewUrl;
      var previewLoading = false;
      var previewLoadKind;
      var previewRetryCount = 0;
      var pendingPreviewRetry = false;
      var previewExpiresAtMs;
      var previewRenewTimer;
      var previewRetryTimer;
      var initializedSourceDraft = false;
      var draftBeforeMediaRefresh;
      var durationMs = 0;
      var segmentStartMs = 0;
      var segmentEndMs = 0;
      var annotations = [];
      var pendingRegion;
      var dragStart;
      var annotationMode = false;
      var isComposing = false;
      var submitting = false;
      var editIdempotencyKey;
      var awaitingPreview = false;
      var pollTimer;
      var pollInFlight = false;
      var pollDelayMs = 2000;
      var loaderTimer;
      var loaderStep = 0;
      var filmstripGeneration = 0;
      var trimDragKind;
      var fallbackTimer;
      var resizeObserver;
      var destroyed = false;

      var statusElement = document.getElementById("status");
      var loadingViewElement = document.getElementById("loading-view");
      var infinityLoaderElement = document.getElementById("infinity-loader");
      var terminalViewElement = document.getElementById("terminal-view");
      var terminalTitleElement = document.getElementById("terminal-title");
      var messageElement = document.getElementById("message");
      var editorElement = document.getElementById("editor");
      var stageElement = document.getElementById("video-stage");
      var videoElement = document.getElementById("video");
      var mediaMessageElement = document.getElementById("media-message");
      var localFileElement = document.getElementById("local-file");
      var roiLayerElement = document.getElementById("roi-layer");
      var roiBoxElement = document.getElementById("roi-box");
      var startElement = document.getElementById("segment-start");
      var endElement = document.getElementById("segment-end");
      var timelineElement = document.getElementById("timeline");
      var filmstripElement = document.getElementById("filmstrip");
      var selectionElement = document.getElementById("selection");
      var shadeLeftElement = document.getElementById("shade-left");
      var shadeRightElement = document.getElementById("shade-right");
      var selectionLabelElement = document.getElementById("selection-label");
      var annotateElement = document.getElementById("annotate");
      var annotationPopoverElement = document.getElementById("annotation-popover");
      var commentElement = document.getElementById("comment");
      var cancelCommentElement = document.getElementById("cancel-comment");
      var insertCommentElement = document.getElementById("insert-comment");
      var annotationsElement = document.getElementById("annotations");
      var promptElement = document.getElementById("prompt");
      var submitEditElement = document.getElementById("submit-edit");
      var editErrorElement = document.getElementById("edit-error");
      var loaderDots = [];

      function post(message) {
        if (!destroyed) window.parent.postMessage(message, "*");
      }

      function reportSize() {
        post({
          jsonrpc: "2.0",
          method: "ui/notifications/size-changed",
          params: {
            height: Math.ceil(document.documentElement.scrollHeight),
            width: Math.ceil(document.documentElement.scrollWidth)
          }
        });
      }

      function request(method, params) {
        return new Promise(function (resolve, reject) {
          var id = nextId++;
          var timer = window.setTimeout(function () {
            pending.delete(id);
            reject(new Error(method + " timed out"));
          }, 15000);
          pending.set(id, {
            timer: timer,
            resolve: function (value) { window.clearTimeout(timer); resolve(value); },
            reject: function (error) { window.clearTimeout(timer); reject(error); }
          });
          post({ jsonrpc: "2.0", id: id, method: method, params: params });
        });
      }

      function callTool(name, args) {
        if (serverToolsAvailable) {
          return request("tools/call", { name: name, arguments: args });
        }
        if (window.openai && typeof window.openai.callTool === "function") {
          return window.openai.callTool(name, args);
        }
        return Promise.reject(new Error("This host cannot call Pippit tools from the widget."));
      }

      function findJob(value, depth) {
        if (!value || typeof value !== "object" || depth > 5) return undefined;
        if (typeof value.id === "string" && typeof value.status === "string") return value;
        if (typeof value.job_id === "string" && typeof value.status === "string") {
          return Object.assign({}, value, { id: value.job_id });
        }
        var keys = Object.keys(value);
        for (var index = 0; index < keys.length; index += 1) {
          var nested = findJob(value[keys[index]], depth + 1);
          if (nested) return nested;
        }
        return undefined;
      }

      function textContent(result) {
        if (!result || !Array.isArray(result.content)) return undefined;
        var block = result.content.find(function (item) {
          return item && item.type === "text" && typeof item.text === "string";
        });
        return block && block.text;
      }

      function formatTime(milliseconds) {
        var seconds = Math.max(0, Math.floor(milliseconds / 1000));
        var minutes = Math.floor(seconds / 60);
        var remainder = seconds % 60;
        return String(minutes).padStart(2, "0") + ":" + String(remainder).padStart(2, "0");
      }

      function formatTrimTime(milliseconds) {
        var totalTenths = Math.max(0, Math.floor(milliseconds / 100));
        var minutes = Math.floor(totalTenths / 600);
        var seconds = Math.floor(totalTenths / 10) % 60;
        return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0") + "." + String(totalTenths % 10);
      }

      function jobIsRunning(status) {
        return status === "pending" || status === "in_progress";
      }

      function loadingCopy(status) {
        if (status === "in_progress") return "Generating your video…";
        if (awaitingPreview) return "Preparing the local preview…";
        return "Preparing your video…";
      }

      function infinityPoint(step) {
        var t = (step % 48) / 48 * Math.PI * 2;
        return { x: Math.sin(t), y: 0.58 * Math.sin(2 * t) };
      }

      function infinityInfluence(dot, head) {
        var dx = dot.x - head.x;
        var dy = dot.y - head.y;
        return Math.exp(-(dx * dx + dy * dy) / 0.19);
      }

      function paintInfinityLoader() {
        var reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        var headA = infinityPoint(loaderStep);
        var headB = infinityPoint(loaderStep + 24);
        var trailA = infinityPoint(loaderStep - 4);
        var trailB = infinityPoint(loaderStep + 20);
        loaderDots.forEach(function (dot, index) {
          var row = Math.floor(index / 5);
          var col = index % 5;
          var point = { x: (col - 2) / 2, y: (2 - row) / 2 };
          var lead = Math.max(infinityInfluence(point, headA), infinityInfluence(point, headB));
          var trail = Math.max(infinityInfluence(point, trailA), infinityInfluence(point, trailB));
          var center = Math.exp(-(point.x * point.x + point.y * point.y) / 0.05) * (0.45 + 0.55 * lead);
          dot.style.opacity = String(reduced ? Math.min(1, 0.1 + lead * 0.28) : Math.min(1, 0.08 + 0.32 * trail + 0.62 * lead + 0.16 * center));
        });
      }

      function startInfinityLoader() {
        if (loaderTimer || loadingViewElement.hidden) return;
        paintInfinityLoader();
        if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        loaderTimer = window.setInterval(function () {
          loaderStep = (loaderStep + 1) % 48;
          paintInfinityLoader();
        }, 36);
      }

      function stopInfinityLoader() {
        window.clearInterval(loaderTimer);
        loaderTimer = undefined;
      }

      function showLoading(status) {
        videoElement.pause();
        localFileElement.hidden = true;
        loadingViewElement.hidden = false;
        terminalViewElement.hidden = true;
        editorElement.hidden = true;
        statusElement.textContent = loadingCopy(status);
        startInfinityLoader();
      }

      function showTerminal(status) {
        videoElement.pause();
        localFileElement.hidden = true;
        stopInfinityLoader();
        loadingViewElement.hidden = true;
        editorElement.hidden = true;
        terminalViewElement.hidden = false;
        terminalTitleElement.textContent = status === "cancelled" ? "Video cancelled" : "Video unavailable";
        messageElement.textContent = status === "expired"
          ? "This video result is no longer available. Please generate it again."
          : "This video could not be completed. Please try again.";
      }

      function clearPollTimer() {
        window.clearTimeout(pollTimer);
        pollTimer = undefined;
      }

      function schedulePoll(delay) {
        clearPollTimer();
        if (destroyed || document.hidden || !activeJobId || (!jobIsRunning(activeStatus) && !awaitingPreview)) return;
        var canCall = serverToolsAvailable || Boolean(window.openai && typeof window.openai.callTool === "function");
        if (!canCall) return;
        pollTimer = window.setTimeout(function () { void refresh(true); }, delay);
      }

      function previewExpirationMs(media) {
        if (media && Number.isFinite(media.expires_at)) return Math.floor(media.expires_at * 1000);
        try {
          var token = new URL(media.url).searchParams.get("token");
          if (!token) return undefined;
          var encoded = token.split(".", 1)[0].replace(/-/g, "+").replace(/_/g, "/");
          while (encoded.length % 4) encoded += "=";
          var payload = JSON.parse(window.atob(encoded));
          var expiresAt = Number.isFinite(payload.expiresAt) ? payload.expiresAt : payload.e;
          return Number.isFinite(expiresAt) ? Math.floor(expiresAt * 1000) : undefined;
        } catch (_error) {
          return undefined;
        }
      }

      function clearPreviewRenewal() {
        window.clearTimeout(previewRenewTimer);
        previewRenewTimer = undefined;
        previewExpiresAtMs = undefined;
      }

      function schedulePreviewRenewal(expiresAtMs) {
        window.clearTimeout(previewRenewTimer);
        previewRenewTimer = undefined;
        previewExpiresAtMs = expiresAtMs;
        if (!Number.isFinite(expiresAtMs) || destroyed || document.hidden || !activeJobId) return;
        var delay = Math.max(0, expiresAtMs - Date.now() - 30000);
        previewRenewTimer = window.setTimeout(function () {
          previewRenewTimer = undefined;
          if (destroyed || document.hidden) return;
          awaitingPreview = true;
          if (protocolReady || window.openai) void refresh(false);
          else pendingPreviewRetry = true;
        }, delay);
      }

      function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
      }

      function roundedCoordinate(value) {
        return Number(value.toFixed(6));
      }

      function newIdempotencyKey() {
        if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
        return "widget-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
      }

      function markDraftChanged() {
        if (!submitting) editIdempotencyKey = undefined;
        updateSubmitState();
      }

      function setEditError(message) {
        editErrorElement.textContent = message || "";
        editErrorElement.hidden = !message;
      }

      function updateSubmitState() {
        var hasInstruction = promptElement.value.trim() !== "" || annotations.length > 0;
        submitEditElement.disabled = submitting || previewLoading || !sourceJobId || !activeModel || !hasInstruction || segmentEndMs <= segmentStartMs;
        insertCommentElement.disabled = annotations.length >= MAX_ANNOTATIONS || !pendingRegion || commentElement.value.trim() === "";
      }

      function updateTimeline() {
        var denominator = Math.max(1, durationMs);
        var startPercent = clamp(segmentStartMs / denominator * 100, 0, 100);
        var endPercent = clamp(segmentEndMs / denominator * 100, 0, 100);
        shadeLeftElement.style.left = "0";
        shadeLeftElement.style.width = startPercent + "%";
        selectionElement.style.left = startPercent + "%";
        selectionElement.style.width = Math.max(0, endPercent - startPercent) + "%";
        shadeRightElement.style.left = endPercent + "%";
        shadeRightElement.style.right = "0";
        startElement.style.left = startPercent + "%";
        endElement.style.left = endPercent + "%";
        startElement.setAttribute("aria-valuenow", String(segmentStartMs));
        startElement.setAttribute("aria-valuetext", formatTrimTime(segmentStartMs));
        endElement.setAttribute("aria-valuenow", String(segmentEndMs));
        endElement.setAttribute("aria-valuetext", formatTrimTime(segmentEndMs));
        selectionLabelElement.textContent = formatTrimTime(segmentStartMs) + " — " + formatTrimTime(segmentEndMs);
        updateSubmitState();
      }

      function keepAnnotationsInsideSegment() {
        annotations = annotations.filter(function (annotation) {
          return annotation.at_ms >= segmentStartMs && annotation.at_ms <= segmentEndMs;
        });
        renderAnnotations();
      }

      function changeSegment(changed, nextValue, seekToBoundary) {
        if (durationMs <= 0) return;
        var minimumGap = Math.min(100, durationMs);
        var start = segmentStartMs;
        var end = segmentEndMs;
        if (changed === "start") start = clamp(nextValue, 0, Math.max(0, durationMs - minimumGap));
        else end = clamp(nextValue, minimumGap, durationMs);
        if (changed === "start") {
          if (end <= start) end = Math.min(durationMs, start + minimumGap);
          if (end - start > MAX_SEGMENT_MS) end = Math.min(durationMs, start + MAX_SEGMENT_MS);
        } else {
          if (end <= start) start = Math.max(0, end - minimumGap);
          if (end - start > MAX_SEGMENT_MS) start = Math.max(0, end - MAX_SEGMENT_MS);
        }
        var roundedStart = Math.round(start);
        var roundedEnd = Math.round(end);
        var changedPayload = roundedStart !== segmentStartMs || roundedEnd !== segmentEndMs;
        segmentStartMs = roundedStart;
        segmentEndMs = roundedEnd;
        if (changedPayload) {
          keepAnnotationsInsideSegment();
          clearPendingRegion();
          markDraftChanged();
        }
        updateTimeline();
        if (seekToBoundary && Number.isFinite(videoElement.duration)) {
          videoElement.currentTime = (changed === "start" ? segmentStartMs : segmentEndMs) / 1000;
        }
      }

      function syncDurationControls() {
        var maximum = Math.max(1, durationMs);
        startElement.setAttribute("aria-valuemax", String(maximum));
        endElement.setAttribute("aria-valuemax", String(maximum));
      }

      function trimValueFromPointer(event) {
        var rect = timelineElement.getBoundingClientRect();
        if (rect.width <= 0) return 0;
        return clamp((event.clientX - rect.left) / rect.width * durationMs, 0, durationMs);
      }

      function beginTrimDrag(kind, event) {
        if (event.button !== 0 || durationMs <= 0) return;
        event.preventDefault();
        trimDragKind = kind;
        event.currentTarget.setPointerCapture(event.pointerId);
        changeSegment(kind, trimValueFromPointer(event), true);
      }

      function moveTrimDrag(event) {
        if (!trimDragKind) return;
        changeSegment(trimDragKind, trimValueFromPointer(event), true);
      }

      function endTrimDrag(event) {
        if (!trimDragKind) return;
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch (_error) {}
        trimDragKind = undefined;
      }

      function changeTrimFromKey(kind, event) {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        var current = kind === "start" ? segmentStartMs : segmentEndMs;
        var value;
        if (event.key === "Home") value = 0;
        else if (event.key === "End") value = durationMs;
        else value = current + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 1000 : 100);
        changeSegment(kind, value, true);
      }

      function draftSnapshot() {
        return {
          annotations: annotations.slice(),
          currentTimeMs: Number.isFinite(videoElement.currentTime) ? Math.round(videoElement.currentTime * 1000) : 0,
          prompt: promptElement.value,
          segmentEndMs: segmentEndMs,
          segmentStartMs: segmentStartMs
        };
      }

      function clearDraftForNewSource() {
        durationMs = 0;
        segmentStartMs = 0;
        segmentEndMs = 0;
        syncDurationControls();
        annotations = [];
        promptElement.value = "";
        commentElement.value = "";
        editIdempotencyKey = undefined;
        setAnnotationMode(false);
        renderAnnotations();
        clearPendingRegion();
        updateTimeline();
      }

      function resetSegment() {
        durationMs = Number.isFinite(videoElement.duration) ? Math.max(0, Math.floor(videoElement.duration * 1000)) : 0;
        segmentStartMs = 0;
        segmentEndMs = Math.min(durationMs, MAX_SEGMENT_MS);
        syncDurationControls();
        annotations = [];
        promptElement.value = "";
        editIdempotencyKey = undefined;
        renderAnnotations();
        clearPendingRegion();
        updateTimeline();
      }

      function restoreDraftAfterMediaRefresh(beforeLoad) {
        var nextDurationMs = Number.isFinite(videoElement.duration) ? Math.max(0, Math.floor(videoElement.duration * 1000)) : 0;
        var liveDraft = draftSnapshot();
        var mergedDraft = mergeWidgetDraftForMediaRefresh(beforeLoad, liveDraft);
        var restored = reconcileWidgetDraftForDuration(mergedDraft, nextDurationMs, MAX_SEGMENT_MS);
        if (!widgetDraftPayloadEquals(mergedDraft, restored)) editIdempotencyKey = undefined;
        durationMs = nextDurationMs;
        segmentStartMs = restored.segmentStartMs;
        segmentEndMs = restored.segmentEndMs;
        annotations = restored.annotations;
        promptElement.value = restored.prompt;
        syncDurationControls();
        videoElement.currentTime = restored.currentTimeMs / 1000;
        renderAnnotations();
        updateTimeline();
        if (pendingRegion) showRegion(pendingRegion);
      }

      function handleLoadedMetadata() {
        var loadKind = previewLoadKind;
        var savedDraft = draftBeforeMediaRefresh;
        previewLoadKind = undefined;
        draftBeforeMediaRefresh = undefined;
        previewLoading = false;
        previewRetryCount = 0;
        pendingPreviewRetry = false;
        if (loadKind === "renewed-url" && savedDraft) restoreDraftAfterMediaRefresh(savedDraft);
        else if (loadKind === "new-source") resetSegment();
        initializedSourceDraft = true;
        mediaMessageElement.hidden = true;
        updateSubmitState();
      }

      function waitForMediaEvent(media, eventName, generation) {
        return new Promise(function (resolve, reject) {
          var timer = window.setTimeout(function () {
            cleanup();
            reject(new Error("Media event timed out"));
          }, 5000);
          function cleanup() {
            window.clearTimeout(timer);
            media.removeEventListener(eventName, done);
            media.removeEventListener("error", failed);
          }
          function done() {
            cleanup();
            if (generation !== filmstripGeneration || destroyed) reject(new Error("Filmstrip superseded"));
            else resolve();
          }
          function failed() {
            cleanup();
            reject(new Error("Filmstrip media failed"));
          }
          media.addEventListener(eventName, done, { once: true });
          media.addEventListener("error", failed, { once: true });
        });
      }

      async function renderFilmstrip(url, generation) {
        var frames = Array.from(filmstripElement.children);
        frames.forEach(function (frame) { frame.style.backgroundImage = ""; });
        var thumbnailVideo = document.createElement("video");
        thumbnailVideo.crossOrigin = "anonymous";
        thumbnailVideo.muted = true;
        thumbnailVideo.playsInline = true;
        thumbnailVideo.preload = "auto";
        thumbnailVideo.src = url;
        try {
          thumbnailVideo.load();
          if (thumbnailVideo.readyState < 1) await waitForMediaEvent(thumbnailVideo, "loadedmetadata", generation);
          if (thumbnailVideo.readyState < 2) await waitForMediaEvent(thumbnailVideo, "loadeddata", generation);
          var sourceDuration = Number.isFinite(thumbnailVideo.duration) ? thumbnailVideo.duration : 0;
          if (sourceDuration <= 0) return;
          var canvas = document.createElement("canvas");
          canvas.width = 180;
          canvas.height = 102;
          var context = canvas.getContext("2d");
          if (!context) return;
          for (var index = 0; index < frames.length; index += 1) {
            if (generation !== filmstripGeneration || destroyed) return;
            var target = Math.min(Math.max(0, sourceDuration - 0.02), sourceDuration * (index + 0.5) / frames.length);
            if (Math.abs(thumbnailVideo.currentTime - target) > 0.02) {
              thumbnailVideo.currentTime = target;
              await waitForMediaEvent(thumbnailVideo, "seeked", generation);
            }
            context.drawImage(thumbnailVideo, 0, 0, canvas.width, canvas.height);
            frames[index].style.backgroundImage = "url(\"" + canvas.toDataURL("image/jpeg", 0.68) + "\")";
          }
        } catch (_error) {
          // The neutral frame cells remain usable when thumbnail extraction is unavailable.
        } finally {
          thumbnailVideo.removeAttribute("src");
          thumbnailVideo.load();
        }
      }

      function videoContentRect() {
        var stageRect = stageElement.getBoundingClientRect();
        if (!videoElement.videoWidth || !videoElement.videoHeight || stageRect.width <= 0 || stageRect.height <= 0) return undefined;
        var scale = Math.min(stageRect.width / videoElement.videoWidth, stageRect.height / videoElement.videoHeight);
        var width = videoElement.videoWidth * scale;
        var height = videoElement.videoHeight * scale;
        return {
          left: (stageRect.width - width) / 2,
          top: (stageRect.height - height) / 2,
          width: width,
          height: height,
          stageLeft: stageRect.left,
          stageTop: stageRect.top
        };
      }

      function normalizedPoint(event) {
        var rect = videoContentRect();
        if (!rect) return undefined;
        var localX = event.clientX - rect.stageLeft - rect.left;
        var localY = event.clientY - rect.stageTop - rect.top;
        if (localX < 0 || localY < 0 || localX > rect.width || localY > rect.height) return undefined;
        return { x: clamp(localX / rect.width, 0, 1), y: clamp(localY / rect.height, 0, 1) };
      }

      function showRegion(region) {
        var rect = videoContentRect();
        if (!rect || !region) {
          roiBoxElement.style.display = "none";
          return;
        }
        roiBoxElement.style.display = "block";
        roiBoxElement.style.left = rect.left + region.x * rect.width + "px";
        roiBoxElement.style.top = rect.top + region.y * rect.height + "px";
        roiBoxElement.style.width = region.width * rect.width + "px";
        roiBoxElement.style.height = region.height * rect.height + "px";
      }

      function positionAnnotationPopover() {
        var rect = videoContentRect();
        if (!rect || !pendingRegion || annotationPopoverElement.hidden) return;
        var stageRect = stageElement.getBoundingClientRect();
        var width = Math.min(340, Math.max(220, stageRect.width - 24));
        var left = rect.left + pendingRegion.x * rect.width;
        left = clamp(left, 12, Math.max(12, stageRect.width - width - 12));
        var below = rect.top + (pendingRegion.y + pendingRegion.height) * rect.height + 10;
        var above = rect.top + pendingRegion.y * rect.height - 132;
        var top = below + 122 <= stageRect.height ? below : Math.max(12, above);
        annotationPopoverElement.style.left = left + "px";
        annotationPopoverElement.style.top = top + "px";
      }

      function openAnnotationPopover() {
        if (!pendingRegion) return;
        commentElement.disabled = false;
        annotationPopoverElement.hidden = false;
        positionAnnotationPopover();
        commentElement.focus({ preventScroll: true });
        updateSubmitState();
      }

      function clearPendingRegion() {
        pendingRegion = undefined;
        dragStart = undefined;
        roiBoxElement.style.display = "none";
        annotationPopoverElement.hidden = true;
        commentElement.value = "";
        commentElement.disabled = true;
        updateSubmitState();
      }

      function finishRegion(event) {
        if (!dragStart) return;
        var point = normalizedPoint(event);
        dragStart = undefined;
        try { roiLayerElement.releasePointerCapture(event.pointerId); } catch (_error) {}
        if (!point || !pendingRegion || pendingRegion.width < 0.01 || pendingRegion.height < 0.01) {
          clearPendingRegion();
          return;
        }
        var x = roundedCoordinate(pendingRegion.x);
        var y = roundedCoordinate(pendingRegion.y);
        pendingRegion = {
          x: x,
          y: y,
          width: roundedCoordinate(Math.min(pendingRegion.width, 1 - x)),
          height: roundedCoordinate(Math.min(pendingRegion.height, 1 - y))
        };
        showRegion(pendingRegion);
        openAnnotationPopover();
      }

      function annotationAtCurrentTime() {
        var atMs = Math.round(videoElement.currentTime * 1000);
        return clamp(atMs, segmentStartMs, segmentEndMs);
      }

      function insertAnnotation() {
        var instruction = commentElement.value.trim();
        if (!pendingRegion || instruction === "") return;
        if (annotations.length >= MAX_ANNOTATIONS) {
          setEditError("At most 20 region annotations can be added to one edit.");
          return;
        }
        annotations.push({
          id: newIdempotencyKey(),
          at_ms: annotationAtCurrentTime(),
          instruction: instruction,
          region: pendingRegion
        });
        setEditError("");
        setAnnotationMode(false);
        renderAnnotations();
        markDraftChanged();
      }

      function renderAnnotations() {
        annotationsElement.replaceChildren();
        annotations.forEach(function (annotation) {
          var chip = document.createElement("span");
          chip.className = "annotation-chip";
          var timeButton = document.createElement("button");
          timeButton.type = "button";
          timeButton.textContent = formatTime(annotation.at_ms);
          timeButton.title = "Seek to annotation";
          timeButton.addEventListener("click", function () {
            videoElement.currentTime = annotation.at_ms / 1000;
            showRegion(annotation.region);
          });
          var text = document.createElement("span");
          text.className = "chip-text";
          text.textContent = annotation.instruction;
          var remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "×";
          remove.title = "Delete annotation";
          remove.setAttribute("aria-label", "Delete annotation at " + formatTime(annotation.at_ms));
          remove.addEventListener("click", function () {
            annotations = annotations.filter(function (candidate) { return candidate.id !== annotation.id; });
            renderAnnotations();
            markDraftChanged();
          });
          chip.append(timeButton, text, remove);
          annotationsElement.appendChild(chip);
        });
        updateSubmitState();
      }

      function setAnnotationMode(enabled) {
        annotationMode = enabled;
        annotateElement.classList.toggle("annotation-active", enabled);
        annotateElement.setAttribute("aria-pressed", String(enabled));
        annotateElement.setAttribute("aria-label", enabled ? "Stop annotating" : "Annotate a video region");
        annotateElement.title = enabled ? "Stop annotating" : "Annotate a video region";
        stageElement.classList.toggle("annotating", enabled);
        roiLayerElement.classList.toggle("active", enabled);
        roiLayerElement.tabIndex = enabled ? 0 : -1;
        roiLayerElement.setAttribute("aria-disabled", String(!enabled));
        if (enabled) {
          videoElement.pause();
          roiLayerElement.focus({ preventScroll: true });
        }
        if (!enabled) clearPendingRegion();
      }

      function setPreview(job, media) {
        var nextIndex = typeof media.index === "number" ? media.index : 0;
        var expiresAtMs = previewExpirationMs(media);
        if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now() + 5000) {
          clearPreviewRenewal();
          awaitingPreview = true;
          pendingPreviewRetry = true;
          showLoading("completed");
          schedulePoll(0);
          return;
        }
        var changedSource = sourceJobId !== job.id || sourceIndex !== nextIndex;
        var updateKind = classifyPreviewUpdate(
          sourceJobId,
          sourceIndex,
          previewUrl,
          initializedSourceDraft,
          job.id,
          nextIndex,
          media.url
        );
        awaitingPreview = false;
        clearPollTimer();
        stopInfinityLoader();
        loadingViewElement.hidden = true;
        terminalViewElement.hidden = true;
        editorElement.hidden = false;
        setEditError("");
        if (typeof media.local_path === "string" && media.local_path !== "") {
          localFileElement.textContent = "Saved locally: " + media.local_path;
          localFileElement.title = media.local_path;
          localFileElement.hidden = false;
        } else {
          localFileElement.textContent = "";
          localFileElement.removeAttribute("title");
          localFileElement.hidden = true;
        }
        if (updateKind === "unchanged") return;

        draftBeforeMediaRefresh = updateKind === "renewed-url" ? draftSnapshot() : undefined;
        sourceJobId = job.id;
        sourceIndex = nextIndex;
        previewUrl = media.url;
        previewLoadKind = updateKind;
        previewLoading = true;
        if (updateKind === "new-source") {
          if (changedSource) previewRetryCount = 0;
          initializedSourceDraft = false;
          clearDraftForNewSource();
        }
        videoElement.src = media.url;
        videoElement.load();
        schedulePreviewRenewal(expiresAtMs);
        filmstripGeneration += 1;
        void renderFilmstrip(media.url, filmstripGeneration);
        updateSubmitState();
      }

      function render(result) {
        if (!result || typeof result !== "object") return;
        var job = findJob(result.structuredContent, 0);
        var meta = result._meta && typeof result._meta === "object" ? result._meta : {};
        var media = Array.isArray(meta["pippit/media"]) ? meta["pippit/media"] : [];
        if (!job) return;
        activeJobId = job.id;
        activeModel = typeof job.model === "string" ? job.model : activeModel;
        activeStatus = typeof job.status === "string" ? job.status : "pending";
        var preview = media.find(function (item) {
          return item && item.kind === "video" && typeof item.url === "string";
        });
        awaitingPreview = activeStatus === "completed" && !preview;
        if (jobIsRunning(activeStatus) || awaitingPreview) {
          clearPreviewRenewal();
          showLoading(activeStatus);
          schedulePoll(pollDelayMs);
        } else if (activeStatus === "failed" || activeStatus === "cancelled" || activeStatus === "expired") {
          clearPreviewRenewal();
          clearPollTimer();
          showTerminal(activeStatus);
        } else if (preview) {
          setPreview(job, preview);
        }
        updateSubmitState();
      }

      async function refresh(automatic) {
        if (!activeJobId || pollInFlight) return;
        pollInFlight = true;
        clearPollTimer();
        try {
          var result = await callTool("pippit_get_video", { job_id: activeJobId });
          pollDelayMs = 2000;
          if (result) render(result);
        } catch (_error) {
          pollDelayMs = Math.min(10000, Math.max(3000, Math.round(pollDelayMs * 1.6)));
          if (automatic && (jobIsRunning(activeStatus) || awaitingPreview)) {
            showLoading(activeStatus);
            statusElement.textContent = "Reconnecting…";
          } else {
            mediaMessageElement.textContent = "The local preview could not be refreshed. Retrying…";
            mediaMessageElement.hidden = false;
          }
        } finally {
          pollInFlight = false;
          schedulePoll(pollDelayMs);
        }
      }

      function toolErrorText(result) {
        var text = textContent(result);
        return text || "Pippit could not start this edit.";
      }

      async function submitEdit() {
        if (submitting || !sourceJobId || !activeModel) return;
        var prompt = promptElement.value.trim();
        if (prompt === "" && annotations.length === 0) return;
        if (!editIdempotencyKey) editIdempotencyKey = newIdempotencyKey();
        var args = {
          source_job_id: sourceJobId,
          source_index: sourceIndex,
          segment: { start_ms: segmentStartMs, end_ms: segmentEndMs },
          annotations: annotations.map(function (annotation) {
            return {
              at_ms: annotation.at_ms,
              instruction: annotation.instruction,
              region: annotation.region
            };
          }),
          model: activeModel,
          idempotency_key: editIdempotencyKey
        };
        if (prompt !== "") args.prompt = prompt;
        submitting = true;
        setEditError("");
        updateSubmitState();
        submitEditElement.textContent = "Starting…";
        try {
          var result = await callTool("pippit_edit_video_segment", args);
          if (!result || result.isError) {
            setEditError(toolErrorText(result));
            return;
          }
          annotations = [];
          promptElement.value = "";
          editIdempotencyKey = undefined;
          setAnnotationMode(false);
          renderAnnotations();
          render(result);
        } catch (error) {
          setEditError(error instanceof Error ? error.message : String(error));
        } finally {
          submitting = false;
          submitEditElement.textContent = "Start edit";
          updateSubmitState();
        }
      }

      async function requestFullscreen() {
        var modes = Array.isArray(hostContext.availableDisplayModes) ? hostContext.availableDisplayModes : [];
        if (!protocolReady || !modes.includes("fullscreen")) return;
        try {
          var result = await request("ui/request-display-mode", { mode: "fullscreen" });
          if (result && typeof result.mode === "string") hostContext.displayMode = result.mode;
        } catch (_error) {}
      }

      function useOpenAiInitialResult() {
        if (!window.openai) return;
        var output = window.openai.toolOutput;
        var metadata = window.openai.toolResponseMetadata;
        if (output !== undefined || metadata !== undefined) {
          render({ structuredContent: output, _meta: metadata || {} });
        }
      }

      function teardown() {
        destroyed = true;
        if (resizeObserver) resizeObserver.disconnect();
        window.clearTimeout(fallbackTimer);
        clearPollTimer();
        clearPreviewRenewal();
        window.clearTimeout(previewRetryTimer);
        stopInfinityLoader();
        filmstripGeneration += 1;
        pending.forEach(function (state) {
          window.clearTimeout(state.timer);
          state.reject(new Error("Widget was closed."));
        });
        pending.clear();
        videoElement.pause();
        videoElement.removeAttribute("src");
        videoElement.load();
      }

      window.addEventListener("message", function (event) {
        if (event.source !== window.parent || !event.data || event.data.jsonrpc !== "2.0") return;
        var message = event.data;
        if (message.method === "ui/resource-teardown" && message.id !== undefined) {
          teardown();
          window.parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
          return;
        }
        if (message.id !== undefined && pending.has(message.id)) {
          var requestState = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) requestState.reject(new Error(message.error.message || "Host request failed"));
          else requestState.resolve(message.result);
          return;
        }
        if (message.method === "ui/notifications/tool-result") render(message.params);
      });

      for (var loaderIndex = 0; loaderIndex < 25; loaderIndex += 1) {
        var loaderDot = document.createElement("span");
        loaderDot.className = "infinity-dot";
        infinityLoaderElement.appendChild(loaderDot);
        loaderDots.push(loaderDot);
      }
      startInfinityLoader();

      window.addEventListener("openai:set_globals", useOpenAiInitialResult, { passive: true });
      videoElement.addEventListener("loadedmetadata", handleLoadedMetadata);
      videoElement.addEventListener("error", function () {
        previewLoading = false;
        previewLoadKind = undefined;
        draftBeforeMediaRefresh = undefined;
        clearPreviewRenewal();
        if (activeJobId && previewUrl && previewRetryCount < 1) {
          previewRetryCount += 1;
          mediaMessageElement.textContent = "Retrying the local video…";
          mediaMessageElement.hidden = false;
          window.clearTimeout(previewRetryTimer);
          previewRetryTimer = window.setTimeout(function () {
            previewRetryTimer = undefined;
            if (destroyed || !previewUrl) return;
            videoElement.src = previewUrl;
            videoElement.load();
          }, 500);
        } else {
          mediaMessageElement.textContent = localFileElement.hidden
            ? "The local video preview could not be loaded."
            : "The player could not load this file, but the MP4 is saved locally.";
          mediaMessageElement.hidden = false;
        }
        updateSubmitState();
      });
      startElement.addEventListener("pointerdown", function (event) { beginTrimDrag("start", event); });
      endElement.addEventListener("pointerdown", function (event) { beginTrimDrag("end", event); });
      startElement.addEventListener("pointermove", moveTrimDrag);
      endElement.addEventListener("pointermove", moveTrimDrag);
      startElement.addEventListener("pointerup", endTrimDrag);
      endElement.addEventListener("pointerup", endTrimDrag);
      startElement.addEventListener("pointercancel", endTrimDrag);
      endElement.addEventListener("pointercancel", endTrimDrag);
      startElement.addEventListener("keydown", function (event) { changeTrimFromKey("start", event); });
      endElement.addEventListener("keydown", function (event) { changeTrimFromKey("end", event); });
      timelineElement.addEventListener("pointerdown", function (event) {
        if (event.target === startElement || event.target === endElement || event.button !== 0 || durationMs <= 0) return;
        videoElement.currentTime = trimValueFromPointer(event) / 1000;
      });
      annotateElement.addEventListener("click", function () {
        setAnnotationMode(!annotationMode);
        if (annotationMode) void requestFullscreen();
      });
      roiLayerElement.addEventListener("pointerdown", function (event) {
        if (!annotationMode || event.button !== 0) return;
        var point = normalizedPoint(event);
        if (!point) return;
        videoElement.pause();
        dragStart = point;
        pendingRegion = { x: point.x, y: point.y, width: 0, height: 0 };
        roiLayerElement.setPointerCapture(event.pointerId);
        showRegion(pendingRegion);
      });
      roiLayerElement.addEventListener("pointermove", function (event) {
        if (!dragStart) return;
        var point = normalizedPoint(event);
        if (!point) return;
        pendingRegion = {
          x: Math.min(dragStart.x, point.x),
          y: Math.min(dragStart.y, point.y),
          width: Math.abs(point.x - dragStart.x),
          height: Math.abs(point.y - dragStart.y)
        };
        showRegion(pendingRegion);
      });
      roiLayerElement.addEventListener("pointerup", finishRegion);
      roiLayerElement.addEventListener("pointercancel", clearPendingRegion);
      roiLayerElement.addEventListener("keydown", function (event) {
        if (!annotationMode) return;
        var result = adjustWidgetRegionFromKey(pendingRegion, event.key, event.shiftKey);
        if (!result.handled) return;
        event.preventDefault();
        if (!result.region) {
          clearPendingRegion();
          return;
        }
        videoElement.pause();
        pendingRegion = result.region;
        showRegion(pendingRegion);
        openAnnotationPopover();
      });
      commentElement.addEventListener("compositionstart", function () { isComposing = true; });
      commentElement.addEventListener("compositionend", function () { isComposing = false; updateSubmitState(); });
      commentElement.addEventListener("input", updateSubmitState);
      commentElement.addEventListener("keydown", function (event) {
        if (event.key === "Enter" && !event.shiftKey && !isComposing) {
          event.preventDefault();
          insertAnnotation();
        }
      });
      cancelCommentElement.addEventListener("click", function () { setAnnotationMode(false); });
      insertCommentElement.addEventListener("click", insertAnnotation);
      promptElement.addEventListener("input", markDraftChanged);
      submitEditElement.addEventListener("click", function () { void submitEdit(); });
      window.addEventListener("resize", function () {
        if (pendingRegion) {
          showRegion(pendingRegion);
          positionAnnotationPopover();
        }
      });
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) {
          clearPollTimer();
          window.clearTimeout(previewRenewTimer);
          previewRenewTimer = undefined;
        } else if (Number.isFinite(previewExpiresAtMs) && previewExpiresAtMs <= Date.now() + 30000) {
          awaitingPreview = true;
          if (protocolReady || window.openai) void refresh(false);
          else pendingPreviewRetry = true;
        } else {
          schedulePreviewRenewal(previewExpiresAtMs);
          schedulePoll(0);
        }
      });

      fallbackTimer = window.setTimeout(useOpenAiInitialResult, 1200);
      request("ui/initialize", {
        protocolVersion: protocolVersion,
        appInfo: { name: "pippit-video-editor", title: "Pippit video editor", version: "0.2.6" },
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] }
      }).then(function (result) {
        protocolReady = true;
        window.clearTimeout(fallbackTimer);
        var capabilities = result && result.hostCapabilities && typeof result.hostCapabilities === "object"
          ? result.hostCapabilities
          : {};
        hostContext = result && result.hostContext && typeof result.hostContext === "object" ? result.hostContext : {};
        serverToolsAvailable = Boolean(capabilities.serverTools);
        post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
        if (pendingPreviewRetry) {
          pendingPreviewRetry = false;
          void refresh(false);
        }
        schedulePoll(0);
        if (typeof ResizeObserver === "function") {
          resizeObserver = new ResizeObserver(reportSize);
          resizeObserver.observe(document.body);
        }
        reportSize();
      }).catch(function () {
        useOpenAiInitialResult();
        schedulePoll(0);
      });
    }());
  </script>
</body>
</html>`
