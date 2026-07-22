export const WIDGET_SCRIPT_EDITOR = String.raw`          function done() {
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
          id: newAnnotationId(),
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
        var nextIdentity = mediaIdentity(media);
        if (!nextIdentity) return;
        var expiresAtMs = previewExpirationMs(media);
        if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now() + 5000) {
          clearPreviewRenewal();
          dispatchWidgetEvent({
            activeJobId: activeJobId,
            activeModel: activeModel,
            awaitingPreview: true,
            status: activeStatus,
            type: "job-received"
          });
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
          nextIdentity
        );
        dispatchWidgetEvent({ type: "preview-ready" });
        clearPollTimer();
        showEditor();
        setEditError("");
        if (updateKind === "unchanged") {
          var resourceReady = typeof media.resource_uri === "string" && previewLoader.hasObjectUrl();
          var networkReady = typeof media.url === "string" && videoElement.getAttribute("src") === media.url;
          if (resourceReady || networkReady) return;
          updateKind = initializedSourceDraft ? "renewed-url" : "new-source";
        }

        draftBeforeMediaRefresh = updateKind === "renewed-url" ? draftSnapshot() : undefined;
        sourceJobId = job.id;
        sourceIndex = nextIndex;
        activePreviewMedia = media;
        previewUrl = nextIdentity;
        previewLoadKind = updateKind;
        if (updateKind === "new-source") {
          if (changedSource) previewRetryCount = 0;
          initializedSourceDraft = false;
          clearDraftForNewSource();
        }
        dispatchWidgetEvent({ identity: nextIdentity, type: "begin-preview" });
        var previewTicket = previewLoader.begin();
        var epochTicket = createWidgetEpochTicket("preview", previewLoadGeneration, activeJobId);
        if (typeof media.resource_uri === "string") {
          clearPreviewRenewal();
          videoElement.pause();
          videoElement.removeAttribute("src");
          videoElement.load();
          revokePreviewObjectUrl();
          mediaMessageElement.textContent = "Loading the saved local video…";
          mediaMessageElement.hidden = false;
          if (!localPreviewTransportAvailable()) {
            pendingPreviewRetry = true;
            showLoading("completed");
          } else {
            void loadLocalResourcePreview(media, previewTicket, epochTicket).catch(function () {
              if (isWidgetEpochTicketCurrent(epochTicket, previewLoadGeneration, activeJobId, destroyed)) {
                localPreviewFailed();
              }
            });
          }
        } else {
          revokePreviewObjectUrl();
          videoElement.src = media.url;
          videoElement.load();
          schedulePreviewRenewal(expiresAtMs);
          filmstripGeneration += 1;
          void renderFilmstrip(media.url, filmstripGeneration);
        }
        updateSubmitState();
      }

      function render(result, authoritativeTransition) {
        if (!result || typeof result !== "object") return;
        var job = findJob(result.structuredContent, 0);
        if (!job) return;
        if (!shouldAcceptWidgetJobResult(activeJobId, job.id, submitting, authoritativeTransition === true)) return;
        if (authoritativeTransition === true) {
          latestResolutionComplete = true;
          latestResolutionInFlight = false;
          latestResolutionRetryMs = 2000;
          restoringJobId = undefined;
          window.clearTimeout(latestResolutionRetryTimer);
          latestResolutionRetryTimer = undefined;
          window.clearTimeout(latestRestoreTimer);
          latestRestoreTimer = undefined;
        }
        var meta = result._meta && typeof result._meta === "object" ? result._meta : {};
        var media = Array.isArray(meta["pippit/media"]) ? meta["pippit/media"] : [];
        var nextModel = resolveWidgetModel(activeModel, job.model);
        var nextStatus = typeof job.status === "string" ? job.status : "pending";
        var preview = media.find(function (item) {
          return item && item.kind === "video" && (
            typeof item.resource_uri === "string" || typeof item.url === "string"
          );
        });
        dispatchWidgetEvent({
          activeJobId: job.id,
          activeModel: nextModel,
          awaitingPreview: nextStatus === "completed" && !preview,
          status: nextStatus,
          type: "job-received"
        });
        var presentation = planWidgetPresentation(activeStatus, Boolean(preview), awaitingPreview);
        if (presentation.clearPreviewRenewal) clearPreviewRenewal();
        if (presentation.clearPoll) clearPollTimer();
        if (presentation.view === "loading") {
          showLoading(activeStatus);
          if (presentation.schedulePoll) schedulePoll(pollDelayMs);
        } else if (presentation.view === "terminal") {
          showTerminal();
        } else if (presentation.view === "editor" && preview) {
          setPreview(job, preview);
        }
        updateSubmitState();
      }

      function storedActiveJobId(bootstrapJobId) {
        var state = window.openai && window.openai.widgetState;
        if (!state || typeof state !== "object" || state.pippit_video_state_version !== 1) return;
        if (state.root_job_id !== bootstrapJobId || typeof state.active_job_id !== "string") return;
        return state.active_job_id;
      }

      function widgetToolTransportAvailable() {
        return serverToolsAvailable || openAiWidgetToolAvailable(window.openai);
      }

      function retryStoredJob(result, storedJobId) {
        restoringJobId = storedJobId;
        statusElement.textContent = "Reconnecting to the latest regenerated video…";
        window.clearTimeout(latestRestoreTimer);
        latestRestoreTimer = window.setTimeout(function () {
          latestRestoreTimer = undefined;
          if (destroyed || restoringJobId !== storedJobId) return;
          restoringJobId = undefined;
          renderBootstrapFallback(result);
        }, pollDelayMs);
      }

      function renderBootstrapFallback(result) {
        if (!result || typeof result !== "object" || !rootJobId) return;
        var storedJobId = storedActiveJobId(rootJobId);
        if (!storedJobId || storedJobId === rootJobId) {
          render(result);
          return;
        }
        if (activeJobId === storedJobId || restoringJobId === storedJobId) return;
        restoringJobId = storedJobId;
        showLoading("pending");
        statusElement.textContent = "Loading the latest regenerated video…";
        void widgetController.callTool("pippit_get_video", { job_id: storedJobId }).then(function (latestResult) {
          if (destroyed || restoringJobId !== storedJobId) return;
          restoringJobId = undefined;
          var latestJob = latestResult && !latestResult.isError
            ? findJob(latestResult.structuredContent, 0)
            : undefined;
          if (!latestJob || latestJob.id !== storedJobId) {
            retryStoredJob(result, storedJobId);
            return;
          }
          render(latestResult, true);
        }).catch(function () {
          if (destroyed || restoringJobId !== storedJobId) return;
          retryStoredJob(result, storedJobId);
        });
      }

      function retryLatestResolution() {
        latestResolutionInFlight = false;
        showLoading("pending");
        statusElement.textContent = "Reconnecting to the latest video…";
        window.clearTimeout(latestResolutionRetryTimer);
        latestResolutionRetryTimer = window.setTimeout(function () {
          latestResolutionRetryTimer = undefined;
          if (destroyed || latestResolutionComplete) return;`
