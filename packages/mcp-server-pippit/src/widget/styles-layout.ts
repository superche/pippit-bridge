export const WIDGET_STYLES_LAYOUT = String.raw`  <style>
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
      --error-surface: #ffffff;
      --error-foreground: #1d1d1f;`
