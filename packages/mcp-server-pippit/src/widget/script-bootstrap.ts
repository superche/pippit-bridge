import { PIPPIT_PLUGIN_VERSION } from "../version.ts"
export const WIDGET_SCRIPT_BOOTSTRAP = String.raw`        }
      });

      fallbackTimer = window.setTimeout(useOpenAiInitialResult, 1200);
      request("ui/initialize", {
        protocolVersion: protocolVersion,
        appInfo: { name: "pippit-video-editor", title: "Pippit video regeneration", version: "${PIPPIT_PLUGIN_VERSION}" },
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] }
      }).then(function (result) {
        dispatchWidgetEvent({ type: "protocol-ready" });
        window.clearTimeout(fallbackTimer);
        var capabilities = result && result.hostCapabilities && typeof result.hostCapabilities === "object"
          ? result.hostCapabilities
          : {};
        hostContext = result && result.hostContext && typeof result.hostContext === "object" ? result.hostContext : {};
        applyWidgetTheme();
        serverResourcesAvailable = Boolean(capabilities.serverResources);
        serverToolsAvailable = Boolean(capabilities.serverTools);
        post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
        if (!widgetToolTransportAvailable() && bootstrapResult) {
          latestResolutionComplete = true;
          renderBootstrapFallback(bootstrapResult);
        } else {
          resolveLatestBootstrap();
        }
        if (pendingPreviewRetry) {
          pendingPreviewRetry = false;
          if (activeJobId && activePreviewMedia && typeof activePreviewMedia.resource_uri === "string") {
            setPreview({ id: activeJobId }, activePreviewMedia);
          } else {
            void refresh(false);
          }
        }
        schedulePoll(0);
        if (typeof ResizeObserver === "function") {
          resizeObserver = new ResizeObserver(reportSize);
          resizeObserver.observe(document.body);
        }
        reportSize();
      }).catch(function () {
        useOpenAiInitialResult();
        if (!widgetToolTransportAvailable() && bootstrapResult) {
          latestResolutionComplete = true;
          renderBootstrapFallback(bootstrapResult);
        } else {
          resolveLatestBootstrap();
        }
        if (pendingPreviewRetry) {
          pendingPreviewRetry = false;
          if (
            localPreviewTransportAvailable() &&
            activeJobId &&
            activePreviewMedia &&
            typeof activePreviewMedia.resource_uri === "string"
          ) {
            setPreview({ id: activeJobId }, activePreviewMedia);
          } else if (previewLoading) {
            localPreviewFailed();
          }
        }
        schedulePoll(0);
      });
    }());
  </script>`
