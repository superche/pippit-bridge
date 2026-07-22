export const WIDGET_SCRIPT_CONTROLLER = String.raw`          resolveLatestBootstrap();
        }, latestResolutionRetryMs);
        latestResolutionRetryMs = Math.min(10000, Math.max(3000, Math.round(latestResolutionRetryMs * 1.6)));
      }

      function resolveLatestBootstrap() {
        if (
          destroyed ||
          latestResolutionComplete ||
          latestResolutionInFlight ||
          !bootstrapResult ||
          !rootJobId ||
          !widgetToolTransportAvailable()
        ) return;
        latestResolutionInFlight = true;
        showLoading("pending");
        statusElement.textContent = "Loading the latest video…";
        void widgetController.callTool("pippit_resolve_latest_video", { anchor_job_id: rootJobId }).then(function (latestResult) {
          if (destroyed) return;
          latestResolutionInFlight = false;
          var latestJob = latestResult && !latestResult.isError
            ? findJob(latestResult.structuredContent, 0)
            : undefined;
          if (!latestJob) {
            retryLatestResolution();
            return;
          }
          void widgetController.persistActiveJobId(latestJob.id).catch(function () {});
          render(latestResult, true);
        }).catch(function () {
          if (destroyed) return;
          retryLatestResolution();
        });
      }

      function renderBootstrapResult(result) {
        if (!result || typeof result !== "object") return;
        if (
          result.structuredContent &&
          result.structuredContent.pippit_dev_preview === "error"
        ) {
          latestResolutionComplete = true;
          showTerminal();
          return;
        }
        var bootstrapJob = findJob(result.structuredContent, 0);
        if (!bootstrapJob) return;
        if (!rootJobId) rootJobId = bootstrapJob.id;
        if (bootstrapJob.id === rootJobId) bootstrapResult = result;
        if (
          latestResolutionComplete &&
          bootstrapJob.id === rootJobId &&
          activeJobId &&
          activeJobId !== rootJobId
        ) return;
        var bootstrapModel = resolveWidgetModel(activeModel, bootstrapJob.model);
        dispatchWidgetEvent({
          activeJobId: bootstrapJob.id,
          activeModel: bootstrapModel,
          awaitingPreview: false,
          status: bootstrapJob.status || "pending",
          type: "job-received"
        });
        if (latestResolutionComplete) {
          if (restoringJobId) return;
          render(result);
          return;
        }
        showLoading("pending");
        statusElement.textContent = "Loading the latest video…";
        resolveLatestBootstrap();
      }

      async function refresh(automatic) {
        if (!activeJobId || pollInFlightEpoch === generationEpoch) return;
        var requestedJobId = activeJobId;
        var requestedEpoch = generationEpoch;
        var epochTicket = createWidgetEpochTicket("generation", requestedEpoch, requestedJobId);
        clearPollTimer();
        try {
          var result = await widgetController.poll(requestedJobId, requestedEpoch);
          if (!isWidgetEpochTicketCurrent(epochTicket, generationEpoch, activeJobId, destroyed)) return;
          pollDelayMs = 2000;
          if (result) render(result);
        } catch (_error) {
          if (!isWidgetEpochTicketCurrent(epochTicket, generationEpoch, activeJobId, destroyed)) return;
          pollDelayMs = Math.min(10000, Math.max(3000, Math.round(pollDelayMs * 1.6)));
          if (automatic && (jobIsRunning(activeStatus) || awaitingPreview)) {
            showLoading(activeStatus);
            statusElement.textContent = "Reconnecting…";
          } else {
            mediaMessageElement.textContent = "The local preview could not be refreshed. Retrying…";
            mediaMessageElement.hidden = false;
          }
        } finally {
          if (isWidgetEpochTicketCurrent(epochTicket, generationEpoch, activeJobId, destroyed)) {
            schedulePoll(pollDelayMs);
          }
        }
      }

      function toolErrorText(result) {
        var text = textContent(result);
        return text || "Pippit could not start the regenerated video.";
      }

      async function submitEdit() {
        if (submitting || !sourceJobId || !activeModel) return;
        var instruction = instructionElement.value.trim();
        if (instruction === "") return;
        var annotation = annotations[0] || {
          at_ms: annotationAtCurrentTime(),
          instruction: instruction,
          region: { x: 0, y: 0, width: 1, height: 1 }
        };
        var payload = buildWidgetEditPayload({
          annotation: Object.assign({}, annotation, { instruction: instruction }),
          model: activeModel,
          segmentEndMs: segmentEndMs,
          segmentStartMs: segmentStartMs,
          sourceIndex: sourceIndex,
          sourceJobId: sourceJobId
        });
        submitting = true;
        dispatchWidgetEvent({ type: "begin-generation" });
        clearPollTimer();
        setEditError("");
        updateSubmitState();
        submitEditElement.textContent = "Preparing reference…";
        showLoading("pending");
        statusElement.textContent = "Starting regenerated video…";
        try {
          if (!editIdempotencyKey) editIdempotencyKey = await stableEditIdempotencyKey(payload, editIdempotencyAttempt);
          var args = Object.assign({}, payload, { idempotency_key: editIdempotencyKey });
          var editRequest = widgetController.callTool("pippit_edit_video_segment", args);
          void requestDisplayMode("inline");
          var result = await editRequest;
          if (!result || result.isError) {
            if (result && editFailureIsDefinitive(result)) {
              editIdempotencyAttempt += 1;
              editIdempotencyKey = undefined;
            }
            showEditor();
            setEditError(toolErrorText(result));
            return;
          }
          var regeneratedJob = findJob(result.structuredContent, 0);
          if (!regeneratedJob) {
            showEditor();
            setEditError("Pippit returned an invalid regeneration result.");
            return;
          }
          annotations = [];
          instructionElement.value = "";
          editIdempotencyAttempt = 0;
          editIdempotencyKey = undefined;
          setAnnotationMode(false);
          renderAnnotations();
          void widgetController.persistActiveJobId(regeneratedJob.id).catch(function () {});
          render(result, true);
        } catch (error) {
          showEditor();
          setEditError(error instanceof Error ? error.message : String(error));
        } finally {
          submitting = false;
          submitEditElement.textContent = "Regenerate video";
          updateSubmitState();
        }
      }

      async function requestDisplayMode(mode) {
        var selectedMode = await widgetController.requestDisplayMode(mode, protocolReady);
        if (selectedMode) hostContext.displayMode = selectedMode;
      }

      function requestFullscreen() {
        return requestDisplayMode("fullscreen");
      }

      function useOpenAiInitialResult() {
        applyWidgetTheme();
        var bootstrap = readOpenAiWidgetBootstrap(window.openai);
        if (bootstrap) renderBootstrapResult(bootstrap);
      }

      function teardown() {
        var effects = dispatchWidgetEvent({ type: "destroy" });
        previewLoader.teardown(function (url) { URL.revokeObjectURL(url); });
        applyWidgetEffects(effects);
        if (resizeObserver) resizeObserver.disconnect();
        if (themeMediaQuery && typeof themeMediaQuery.removeEventListener === "function") {
          themeMediaQuery.removeEventListener("change", handleSystemThemeChange);
        }
        window.clearTimeout(terminalEntryTimer);
        window.clearTimeout(fallbackTimer);
        clearPollTimer();
        clearPreviewRenewal();
        window.clearTimeout(previewRetryTimer);
        window.clearTimeout(latestResolutionRetryTimer);
        window.clearTimeout(latestRestoreTimer);
        stopInfinityLoader();
        filmstripGeneration += 1;
        requestManager.cancelAll(new Error("Widget was closed."));
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
        if (message.id !== undefined && requestManager.settle(
          message.id,
          message.result,
          message.error ? message.error.message || "Host request failed" : undefined
        )) return;
        if (message.method === "ui/notifications/host-context-changed") {
          var nextHostContext = message.params && typeof message.params === "object" ? message.params : {};
          hostContext = Object.assign({}, hostContext, nextHostContext);
          applyWidgetTheme();
          return;
        }
        if (message.method === "ui/notifications/tool-result") renderBootstrapResult(message.params);
      });

      for (var loaderIndex = 0; loaderIndex < 25; loaderIndex += 1) {
        var loaderDot = document.createElement("span");
        loaderDot.className = "infinity-dot";
        infinityLoaderElement.appendChild(loaderDot);
        loaderDots.push(loaderDot);
      }
      var errorDotIndex = 0;
      document.querySelectorAll(".error-matrix").forEach(function (matrix) {
        var pattern = matrix.getAttribute("data-pattern");
        if (!pattern) return;
        pattern.replaceAll("/", "").split("").forEach(function (value) {
          var dot = document.createElement("span");
          dot.className = "error-dot" + (value === "1" ? " is-active" : "");
          dot.style.setProperty("--error-dot-delay", String((errorDotIndex % 19) * 12) + "ms");
          matrix.appendChild(dot);
          errorDotIndex += 1;
        });
      });
      applyWidgetTheme();
      if (themeMediaQuery && typeof themeMediaQuery.addEventListener === "function") {
        themeMediaQuery.addEventListener("change", handleSystemThemeChange);
      }
      startInfinityLoader();

      window.addEventListener("openai:set_globals", useOpenAiInitialResult, { passive: true });
      videoElement.addEventListener("loadedmetadata", handleLoadedMetadata);
      videoElement.addEventListener("error", function () {
        if (activePreviewMedia && typeof activePreviewMedia.resource_uri === "string") {
          localPreviewFailed();
          return;
        }
        dispatchWidgetEvent({ type: "preview-failed" });
        previewLoadKind = undefined;
        draftBeforeMediaRefresh = undefined;
        clearPreviewRenewal();
        if (activeJobId && activePreviewMedia && typeof activePreviewMedia.url === "string" && previewRetryCount < 1) {
          previewRetryCount += 1;
          mediaMessageElement.textContent = "Retrying the local video…";
          mediaMessageElement.hidden = false;
          window.clearTimeout(previewRetryTimer);
          previewRetryTimer = window.setTimeout(function () {
            previewRetryTimer = undefined;
            if (destroyed || !activePreviewMedia || typeof activePreviewMedia.url !== "string") return;
            videoElement.src = activePreviewMedia.url;
            videoElement.load();
          }, 500);
        } else {
          mediaMessageElement.textContent = "The video preview could not be loaded.";
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
          clearAnnotationRegion();
          return;
        }
        videoElement.pause();
        pendingRegion = result.region;
        selectAnnotationRegion(pendingRegion);
      });
      instructionElement.addEventListener("input", updateAnnotationInstruction);
      submitEditElement.addEventListener("click", function () { void submitEdit(); });
      window.addEventListener("resize", function () {
        if (pendingRegion) showRegion(pendingRegion);
      });
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) {
          clearPollTimer();
          window.clearTimeout(previewRenewTimer);
          previewRenewTimer = undefined;
        } else if (Number.isFinite(previewExpiresAtMs) && previewExpiresAtMs <= Date.now() + 30000) {
          dispatchWidgetEvent({
            activeJobId: activeJobId,
            activeModel: activeModel,
            awaitingPreview: true,
            status: activeStatus,
            type: "job-received"
          });
          if (protocolReady || window.openai) void refresh(false);
          else pendingPreviewRetry = true;
        } else {
          schedulePreviewRenewal(previewExpiresAtMs);
          schedulePoll(0);`
