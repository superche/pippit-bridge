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
            aria-label="Video region selector. The full frame is used by default. Press Enter or Space to create a centered region. Use arrow keys to move it, hold Shift with arrow keys to resize it, and press Escape to return to the full frame."
          >
            <div id="roi-box" class="roi-box"></div>
          </div>
          <button id="annotate" class="annotation-trigger" type="button" aria-pressed="false" aria-label="Select a video area" title="Select a video area">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4M12 8v8M8 12h8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8"/>
            </svg>
          </button>
        </div>
        <p id="media-message" class="viewer-message" aria-live="polite" hidden></p>
      </div>

      <details id="annotation-panel" class="annotation-panel" open>
        <summary>
          <span class="annotation-summary-line">
            <span class="annotation-title">Annotation</span>
            <output id="annotation-summary" class="annotation-summary">Full frame · Describe the change</output>
          </span>
          <svg class="annotation-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7"/></svg>
        </summary>
        <div class="annotation-composer">
          <div class="time-editor">
            <p class="range-impact"><span class="range-impact-icon" aria-hidden="true">i</span><span>Your annotation will affect <strong><output id="selection-label">00:00.0 — 00:00.0</output></strong>.</span></p>
            <div id="timeline" class="trim-timeline" aria-label="Annotation time range">
              <div id="filmstrip" class="filmstrip" aria-hidden="true">
                <span class="filmstrip-frame"></span><span class="filmstrip-frame"></span><span class="filmstrip-frame"></span><span class="filmstrip-frame"></span><span class="filmstrip-frame"></span>
                <span class="filmstrip-frame"></span><span class="filmstrip-frame"></span><span class="filmstrip-frame"></span><span class="filmstrip-frame"></span><span class="filmstrip-frame"></span>
              </div>
              <div id="shade-left" class="trim-shade"></div>
              <div id="selection" class="trim-selection"></div>
              <div id="shade-right" class="trim-shade"></div>
              <button id="segment-start" class="trim-handle" type="button" role="slider" aria-label="Annotation range start" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="00:00.0"></button>
              <button id="segment-end" class="trim-handle" type="button" role="slider" aria-label="Annotation range end" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="00:00.0"></button>
            </div>
            <p class="range-note"><span>Drag to choose the time range, up to 30 seconds</span><strong id="range-duration">0.0 sec</strong></p>
          </div>
          <div class="intent-editor">
            <div class="intent-label"><label for="instruction">Change instruction</label><span id="area-status" class="area-status">Full frame</span></div>
            <textarea id="instruction" maxlength="2000" aria-label="Annotation change instruction" placeholder="Describe what should change in the video…"></textarea>
          </div>
        </div>
        <footer class="annotation-footer">
          <div class="submit-copy">
            <p class="hint">This annotation becomes the edit prompt. The current video remains the reference.</p>
            <p id="edit-error" class="error" role="alert" hidden></p>
          </div>
          <button id="submit-edit" class="primary" type="button" disabled>Regenerate video</button>
        </footer>
      </details>
    </section>
  </main>`
