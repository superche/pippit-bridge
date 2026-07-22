export const WIDGET_MARKUP = String.raw`<body>
  <main>
    <section id="loading-view" class="loading-view" role="status" aria-live="polite">
      <div id="infinity-loader" class="infinity-loader" aria-hidden="true"></div>
      <p id="status" class="loading-status">Preparing your video…</p>
    </section>

    <section id="terminal-view" class="terminal-view" role="alert" aria-live="assertive" hidden>
      <div class="error-lockup">
        <div class="error-matrix error-mark" data-pattern="1000001/0100010/0010100/0001000/0010100/0100010/1000001" aria-hidden="true"></div>
        <h1 class="error-word">
          <span class="visually-hidden">Error</span>
          <span class="error-matrix" data-pattern="11111/10000/10000/11110/10000/10000/11111" aria-hidden="true"></span>
          <span class="error-matrix" data-pattern="11110/10001/10001/11110/10100/10010/10001" aria-hidden="true"></span>
          <span class="error-matrix" data-pattern="11110/10001/10001/11110/10100/10010/10001" aria-hidden="true"></span>
          <span class="error-matrix" data-pattern="01110/10001/10001/10001/10001/10001/01110" aria-hidden="true"></span>
          <span class="error-matrix" data-pattern="11110/10001/10001/11110/10100/10010/10001" aria-hidden="true"></span>
        </h1>
      </div>
    </section>

    <section id="editor" class="editor" aria-label="Regenerate from the generated video" hidden>
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

      <section class="edit-compose" aria-label="Regeneration direction">
        <label class="visually-hidden" for="prompt">Regeneration direction</label>
        <textarea id="prompt" maxlength="20000" aria-label="Regeneration direction" placeholder="Describe the regenerated video…"></textarea>
        <div class="submit-row">
          <div class="submit-copy">
            <p class="hint">The current video is the reference. The selected range and region annotations are added to the generation prompt.</p>
            <p id="edit-error" class="error" role="alert" hidden></p>
          </div>
          <button id="submit-edit" class="primary" type="button" disabled>Regenerate video</button>
        </div>
      </section>
    </section>
  </main>`
