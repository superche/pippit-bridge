export const WIDGET_STYLES_EDITOR = String.raw`      display: grid;
      min-height: 268px;
      place-content: center;
      justify-items: center;
      overflow: hidden;
      padding: 32px;
      background: var(--error-surface);
      color: var(--error-foreground);
      text-align: center;
    }
    :root[data-theme="dark"] .terminal-view {
      --error-surface: #1d1d1f;
      --error-foreground: #f5f5f7;
      color-scheme: dark;
    }
    :root[data-widget-view="terminal"],
    :root[data-widget-view="terminal"] body {
      min-height: 100%;
      background: #ffffff;
    }
    :root[data-widget-view="terminal"] body { padding: 0; }
    :root[data-widget-view="terminal"] main {
      width: 100%;
      max-width: none;
      min-height: 100vh;
      margin: 0;
      gap: 0;
    }
    :root[data-widget-view="terminal"] .terminal-view { min-height: max(268px, 100vh); }
    :root[data-theme="dark"][data-widget-view="terminal"],
    :root[data-theme="dark"][data-widget-view="terminal"] body {
      background: #1d1d1f;
    }
    :root[data-widget-view="editor"] body { padding: 0; }
    :root[data-widget-view="editor"] main {
      width: 100%;
      max-width: none;
      gap: 0;
    }
    :root[data-widget-view="editor"] .editor {
      gap: 16px;
      padding: 0 16px 16px;
    }
    :root[data-widget-view="editor"] .viewer-card {
      margin-inline: -16px;
      border-block-start: 0;
      border-inline: 0;
      border-radius: 0 0 18px 18px;
    }
    .error-lockup {
      display: grid;
      justify-items: center;
      gap: 24px;
    }
    .error-word {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: clamp(7px, 1.5vw, 12px);
      margin: 0;
    }
    .error-matrix {
      display: grid;
      grid-template-columns: repeat(5, clamp(4px, .75vw, 7px));
      grid-auto-rows: clamp(4px, .75vw, 7px);
      gap: clamp(2px, .42vw, 4px);
    }
    .error-mark {
      grid-template-columns: repeat(7, 7px);
      grid-auto-rows: 7px;
      gap: 4px;
    }
    .error-dot {
      border-radius: 50%;
      background: currentColor;
      opacity: .07;
      transform-origin: center;
    }
    .error-dot.is-active { opacity: .94; }
    .terminal-view.is-entering .error-dot.is-active {
      animation: error-dot-entry 560ms steps(2, end) both;
      animation-delay: var(--error-dot-delay);
    }
    @keyframes error-dot-entry {
      0%, 22% { opacity: .07; transform: scale(.72); }
      36% { opacity: .94; transform: scale(1); }
      49% { opacity: .18; transform: scale(.82); }
      64%, 100% { opacity: .94; transform: scale(1); }
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme]) .terminal-view {
        --error-surface: #1d1d1f;
        --error-foreground: #f5f5f7;
        --error-border: #3a3a3c;
        color-scheme: dark;
      }
    }
    .viewer-card { position: relative; }
    .video-stage { border-radius: 0; }
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

    :root[data-theme="dark"] button:hover:not(:disabled) { background: rgb(255 255 255 / 8%); }
    :root[data-theme="dark"] .primary {
      border-color: #2997ff;
      background: #2997ff;
      color: #ffffff;
    }
    :root[data-theme="dark"] .primary:hover:not(:disabled) { background: #409cff; }
    :root[data-theme="dark"] .eyebrow,
    :root[data-theme="dark"] dt,
    :root[data-theme="dark"] .message,
    :root[data-theme="dark"] .hint,
    :root[data-theme="dark"] .range-field,
    :root[data-theme="dark"] .trim-time,
    :root[data-theme="dark"] .trim-help { color: #a1a1a6; }
    :root[data-theme="dark"] .status,
    :root[data-theme="dark"] .summary,
    :root[data-theme="dark"] .utility-card,
    :root[data-theme="dark"] .trim-panel {
      border-color: #3a3a3c;
      background: #2c2c2e;
    }
    :root[data-theme="dark"] .status { color: #a1a1a6; }
    :root[data-theme="dark"] .status.completed {
      border-color: #2997ff;
      background: #2997ff;
      color: #ffffff;
    }
    :root[data-theme="dark"] .status.failed,
    :root[data-theme="dark"] .status.cancelled,
    :root[data-theme="dark"] .status.expired { border-color: #a1a1a6; color: #f5f5f7; }
    :root[data-theme="dark"] .error { border-color: #2997ff; color: #f5f5f7; }
    :root[data-theme="dark"] .timeline {
      border-color: #3a3a3c;
      background: #1d1d1f;
    }
    :root[data-theme="dark"] .timeline-shade { background: #3a3a3c; }
    :root[data-theme="dark"] .comment-input input,
    :root[data-theme="dark"] textarea,
    :root[data-theme="dark"] .annotation-popover {
      border-color: #48484a;
      background: #2c2c2e;
      color: #f5f5f7;
    }
    :root[data-theme="dark"] input::placeholder,
    :root[data-theme="dark"] textarea::placeholder { color: #a1a1a6; }
    :root[data-theme="dark"] .annotation-chip {
      border-color: #48484a;
      background: #3a3a3c;
    }

    @media (max-width: 640px) {
      .loading-view { min-height: 240px; }
      .terminal-view { min-height: 236px; padding: 24px 16px; }
      :root[data-widget-view="editor"] .editor { padding: 0 12px 12px; }
      :root[data-widget-view="editor"] .viewer-card { margin-inline: -12px; }
      .trim-panel { padding: 14px; }
      .trim-timeline { margin-inline: 18px; }
      .trim-header { align-items: flex-start; flex-direction: column; gap: 2px; }
      .annotation-popover { width: calc(100% - 24px); }
    }

    @media (max-width: 480px) {
      :root[data-widget-view="editor"] .editor { padding: 0 8px 8px; }
      :root[data-widget-view="editor"] .viewer-card { margin-inline: -8px; }
    }

    @media (prefers-reduced-motion: reduce) {
      .infinity-dot { transition: none; }
      .terminal-view.is-entering .error-dot.is-active { animation: none; }
    }
  </style>`
