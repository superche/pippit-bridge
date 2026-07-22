export const WIDGET_SCRIPT_VIEW = String.raw`        if (!retryLocalPreview()) {
          mediaMessageElement.textContent = "The player could not load this file, but the MP4 is saved locally.";
          mediaMessageElement.hidden = false;
        }
        updateSubmitState();
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

      function applyWidgetEffects(effects) {
        effects.forEach(function (effect) {
          if (effect.type === "pause-video") videoElement.pause();
          if (effect.type === "start-loader") startInfinityLoader();
          if (effect.type === "stop-loader") stopInfinityLoader();
        });
      }

      function showLoading(status) {
        var effects = dispatchWidgetEvent({ type: "show", view: "loading", status: status });
        renderWidgetView({
          documentElement: document.documentElement,
          editor: editorElement,
          loading: loadingViewElement,
          status: statusElement,
          terminal: terminalViewElement
        }, resolveWidgetRenderModel(widgetMachineState));
        applyWidgetEffects(effects);
      }

      function showEditor() {
        var effects = dispatchWidgetEvent({ type: "show", view: "editor", status: activeStatus });
        renderWidgetView({
          documentElement: document.documentElement,
          editor: editorElement,
          loading: loadingViewElement,
          status: statusElement,
          terminal: terminalViewElement
        }, resolveWidgetRenderModel(widgetMachineState));
        applyWidgetEffects(effects);
      }

      function showTerminal() {
        var effects = dispatchWidgetEvent({ type: "show", view: "terminal", status: activeStatus });
        renderWidgetView({
          documentElement: document.documentElement,
          editor: editorElement,
          loading: loadingViewElement,
          status: statusElement,
          terminal: terminalViewElement
        }, resolveWidgetRenderModel(widgetMachineState));
        applyWidgetEffects(effects);
        terminalViewElement.classList.remove("is-entering");
        if (!(reducedMotionMediaQuery && reducedMotionMediaQuery.matches)) {
          void terminalViewElement.offsetWidth;
          terminalViewElement.classList.add("is-entering");
          window.clearTimeout(terminalEntryTimer);
          terminalEntryTimer = window.setTimeout(function () {
            terminalViewElement.classList.remove("is-entering");
          }, 920);
        }
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
        dispatchWidgetEvent({ type: "preview-renewal-scheduled" });
      }

      function schedulePreviewRenewal(expiresAtMs) {
        window.clearTimeout(previewRenewTimer);
        previewRenewTimer = undefined;
        var delay = widgetController.previewRenewalDelay(expiresAtMs, Date.now());
        if (delay === undefined || destroyed || document.hidden || !activeJobId) return;
        previewRenewTimer = window.setTimeout(function () {
          previewRenewTimer = undefined;
          if (destroyed || document.hidden) return;
          dispatchWidgetEvent({
            activeJobId: activeJobId,
            activeModel: activeModel,
            awaitingPreview: true,
            status: activeStatus,
            type: "job-received"
          });
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

      function newAnnotationId() {
        if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
        return "annotation-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
      }

      function fallbackPayloadDigest(input) {
        var seeds = [2166136261, 2246822507, 3266489909, 668265263];
        for (var index = 0; index < input.length; index += 1) {
          var code = input.charCodeAt(index);
          for (var seedIndex = 0; seedIndex < seeds.length; seedIndex += 1) {
            seeds[seedIndex] = Math.imul(seeds[seedIndex] ^ code, 16777619 + seedIndex * 2) >>> 0;
          }
        }
        return seeds.map(function (value) { return value.toString(16).padStart(8, "0"); }).join("");
      }

      async function stableEditIdempotencyKey(payload) {
        var input = JSON.stringify(payload);
        if (
          window.crypto &&
          window.crypto.subtle &&
          typeof window.crypto.subtle.digest === "function" &&
          typeof TextEncoder === "function"
        ) {
          try {
            var digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
            var digestBytes = new Uint8Array(digest);
            var hex = Array.from(digestBytes).map(function (value) {
              return value.toString(16).padStart(2, "0");
            }).join("");
            return "widget-edit-v1-" + hex;
          } catch (_error) {}
        }
        return "widget-edit-v1-fallback-" + fallbackPayloadDigest(input);
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
        dispatchWidgetEvent({
          draft: {
            annotationCount: annotations.length,
            prompt: promptElement.value,
            segmentEndMs: segmentEndMs,
            segmentStartMs: segmentStartMs
          },
          type: "draft-changed"
        });
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
        previewRetryCount = 0;
        pendingPreviewRetry = false;
        dispatchWidgetEvent({ type: "preview-ready" });
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
          }`
