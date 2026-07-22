import { selectWidgetToolTransport } from "./bridge.ts"
import { PIPPIT_WIDGET_VIDEO_TOOL_TIMEOUT_MS } from "./contract.ts"
import { createWidgetEpochTicket, isWidgetEpochTicketCurrent, WidgetController } from "./controller.ts"
import { buildWidgetEditPayload } from "./editor.ts"
import { WidgetRequestManager } from "./host/request-manager.ts"
import {
  openAiWidgetToolAvailable,
  readOpenAiWidgetBootstrap,
  requestOpenAiWidgetDisplayMode,
} from "./host/openai-compat.ts"
import {
  planWidgetPreviewChunks,
  validateWidgetPreviewChunk,
  WidgetPreviewLoader,
} from "./preview-loader.ts"
import { createInitialWidgetState, reduceWidgetState } from "./reducer.ts"
import { planWidgetPresentation, resolveWidgetRenderModel, resolveWidgetRenderView, widgetLoadingCopy } from "./render.ts"
import { renderWidgetView } from "./view/dom-renderer.ts"
import {
  adjustWidgetRegionFromKey,
  classifyPreviewUpdate,
  mergeWidgetDraftForMediaRefresh,
  normalizeWidgetPoint,
  reconcileWidgetDraftForDuration,
  resolveWidgetModel,
  resolveWidgetTheme,
  shouldAcceptWidgetJobResult,
  widgetDraftPayloadEquals,
} from "./state.ts"
import { findWidgetJob, widgetTextContent } from "./result-parser.ts"
export const WIDGET_SCRIPT_BRIDGE_PREVIEW = String.raw`  <script>
    (function () {
      "use strict";

      var classifyPreviewUpdate = ${classifyPreviewUpdate.toString()};
      var shouldAcceptWidgetJobResult = ${shouldAcceptWidgetJobResult.toString()};
      var resolveWidgetModel = ${resolveWidgetModel.toString()};
      var reconcileWidgetDraftForDuration = ${reconcileWidgetDraftForDuration.toString()};
      var mergeWidgetDraftForMediaRefresh = ${mergeWidgetDraftForMediaRefresh.toString()};
      var normalizeWidgetPoint = ${normalizeWidgetPoint.toString()};
      var widgetDraftPayloadEquals = ${widgetDraftPayloadEquals.toString()};
      var adjustWidgetRegionFromKey = ${adjustWidgetRegionFromKey.toString()};
      var resolveWidgetTheme = ${resolveWidgetTheme.toString()};
      var selectWidgetToolTransport = ${selectWidgetToolTransport.toString()};
      var createWidgetEpochTicket = ${createWidgetEpochTicket.toString()};
      var isWidgetEpochTicketCurrent = ${isWidgetEpochTicketCurrent.toString()};
      var WidgetController = ${WidgetController.toString()};
      var buildWidgetEditPayload = ${buildWidgetEditPayload.toString()};
      var WidgetRequestManager = ${WidgetRequestManager.toString()};
      var openAiWidgetToolAvailable = ${openAiWidgetToolAvailable.toString()};
      var readOpenAiWidgetBootstrap = ${readOpenAiWidgetBootstrap.toString()};
      var requestOpenAiWidgetDisplayMode = ${requestOpenAiWidgetDisplayMode.toString()};
      var planWidgetPreviewChunks = ${planWidgetPreviewChunks.toString()};
      var validateWidgetPreviewChunk = ${validateWidgetPreviewChunk.toString()};
      var WidgetPreviewLoader = ${WidgetPreviewLoader.toString()};
      var createInitialWidgetState = ${createInitialWidgetState.toString()};
      var reduceWidgetState = ${reduceWidgetState.toString()};
      var resolveWidgetRenderView = ${resolveWidgetRenderView.toString()};
      var planWidgetPresentation = ${planWidgetPresentation.toString()};
      var widgetLoadingCopy = ${widgetLoadingCopy.toString()};
      var resolveWidgetRenderModel = ${resolveWidgetRenderModel.toString()};
      var renderWidgetView = ${renderWidgetView.toString()};
      var findJob = ${findWidgetJob.toString()};
      var textContent = ${widgetTextContent.toString()};

      var MAX_LOCAL_PREVIEW_BYTES = 256 * 1024 * 1024;
      var LOCAL_PREVIEW_CHUNK_BYTES = 1024 * 1024;
      var LOCAL_RESOURCE_REQUEST_TIMEOUT_MS = 5000;
      var MAX_SEGMENT_MS = 30000;
      var DEFAULT_REQUEST_TIMEOUT_MS = 15000;
      var VIDEO_TOOL_REQUEST_TIMEOUT_MS = ${PIPPIT_WIDGET_VIDEO_TOOL_TIMEOUT_MS};
      var VIDEO_TOOL_NAMES = new Set([
        "pippit_generate_video",
        "pippit_get_video",
        "pippit_download_video",
        "pippit_edit_video_segment",
        "pippit_resolve_latest_video"
      ]);
      var RETRY_SAFE_TOOL_NAMES = new Set([
        "pippit_get_video",
        "pippit_read_video_chunk",
        "pippit_resolve_latest_video"
      ]);
      var protocolVersion = "2026-01-26";
      var nextId = 1;
      var requestManager = new WidgetRequestManager({
        clearTimeout: function (timer) { window.clearTimeout(timer); },
        setTimeout: function (callback, timeoutMs) { return window.setTimeout(callback, timeoutMs); }
      });
      var protocolReady = false;
      var serverResourcesAvailable = false;
      var serverToolsAvailable = false;
      var resourceBridgeDemoted = false;
      var hostContext = {};
      var rootJobId;
      var restoringJobId;
      var bootstrapResult;
      var latestResolutionInFlight = false;
      var latestResolutionComplete = false;
      var latestResolutionRetryMs = 2000;
      var latestResolutionRetryTimer;
      var latestRestoreTimer;
      var activeJobId;
      var activeModel;
      var activeStatus = "pending";
      var sourceJobId;
      var sourceIndex = 0;
      var activePreviewMedia;
      var previewUrl;
      var previewLoadGeneration = 0;
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
      var submitting = false;
      var editIdempotencyAttempt = 0;
      var editIdempotencyKey;
      var awaitingPreview = false;
      var pollTimer;
      var pollInFlightEpoch;
      var pollDelayMs = 2000;
      var generationEpoch = 0;
      var loaderTimer;
      var loaderStep = 0;
      var terminalEntryTimer;
      var filmstripGeneration = 0;
      var trimDragKind;
      var fallbackTimer;
      var resizeObserver;
      var destroyed = false;
      var widgetMachineState = createInitialWidgetState();
      var previewLoader = new WidgetPreviewLoader();

      function dispatchWidgetEvent(event) {
        var transition = reduceWidgetState(widgetMachineState, event);
        widgetMachineState = transition.state;
        activeJobId = widgetMachineState.activeJobId;
        activeModel = widgetMachineState.activeModel;
        activeStatus = widgetMachineState.status;
        awaitingPreview = widgetMachineState.awaitingPreview;
        destroyed = widgetMachineState.destroyed;
        generationEpoch = widgetMachineState.generationEpoch;
        pollInFlightEpoch = widgetMachineState.pollInFlightEpoch;
        previewLoadGeneration = widgetMachineState.previewGeneration;
        previewLoading = widgetMachineState.previewLoading;
        previewExpiresAtMs = widgetMachineState.previewRenewalAtMs;
        protocolReady = widgetMachineState.protocolReady;
        resourceBridgeDemoted = widgetMachineState.resourceBridgeDemoted;
        return transition.effects;
      }

      var widgetController = new WidgetController({
        callTool: function (name, args) { return callTool(name, args); },
        dispatch: function (event) { dispatchWidgetEvent(event); },
        persistActiveJobId: function (jobId) {
          if (!rootJobId || !window.openai || typeof window.openai.setWidgetState !== "function") return;
          return Promise.resolve(window.openai.setWidgetState({
            active_job_id: jobId,
            pippit_video_state_version: 1,
            root_job_id: rootJobId
          }));
        },
        requestLegacyDisplayMode: function (mode) {
          if (!window.openai) return Promise.resolve(undefined);
          return requestOpenAiWidgetDisplayMode(window.openai, mode);
        },
        requestStandardDisplayMode: async function (mode) {
          var result = await request("ui/request-display-mode", { mode: mode });
          return result && typeof result.mode === "string" ? result.mode : undefined;
        }
      });

      var statusElement = document.getElementById("status");
      var loadingViewElement = document.getElementById("loading-view");
      var infinityLoaderElement = document.getElementById("infinity-loader");
      var terminalViewElement = document.getElementById("terminal-view");
      var editorElement = document.getElementById("editor");
      var stageElement = document.getElementById("video-stage");
      var videoElement = document.getElementById("video");
      var mediaMessageElement = document.getElementById("media-message");
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
      var annotationSummaryElement = document.getElementById("annotation-summary");
      var areaStatusElement = document.getElementById("area-status");
      var instructionElement = document.getElementById("instruction");
      var rangeDurationElement = document.getElementById("range-duration");
      var submitEditElement = document.getElementById("submit-edit");
      var editErrorElement = document.getElementById("edit-error");
      var loaderDots = [];
      var themeMediaQuery = typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : undefined;
      var reducedMotionMediaQuery = typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : undefined;

      function applyWidgetTheme() {
        var legacyTheme = window.openai && window.openai.theme;
        var theme = resolveWidgetTheme(hostContext.theme, legacyTheme, Boolean(themeMediaQuery && themeMediaQuery.matches));
        document.documentElement.dataset.theme = theme;
      }

      function handleSystemThemeChange() {
        if (hostContext.theme === "dark" || hostContext.theme === "light") return;
        if (window.openai && (window.openai.theme === "dark" || window.openai.theme === "light")) return;
        applyWidgetTheme();
      }

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

      function request(method, params, timeoutMs) {
        return requestManager.request(
          nextId++,
          method,
          params,
          timeoutMs === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : timeoutMs,
          post
        );
      }

      function withClientTimeout(task, timeoutMs) {
        return requestManager.runClient(task, timeoutMs);
      }

      function callTool(name, args) {
        var timeoutMs = VIDEO_TOOL_NAMES.has(name)
          ? VIDEO_TOOL_REQUEST_TIMEOUT_MS
          : DEFAULT_REQUEST_TIMEOUT_MS;
        var legacyAvailable = openAiWidgetToolAvailable(window.openai);
        function callLegacy() {
          return withClientTimeout(function () {
            return window.openai.callTool(name, args);
          }, timeoutMs);
        }
        var plan = selectWidgetToolTransport({
          legacyAvailable: legacyAvailable,
          protocolReady: protocolReady,
          retrySafe: RETRY_SAFE_TOOL_NAMES.has(name),
          serverToolsAvailable: serverToolsAvailable,
          toolName: name
        });
        function execute(transport) {
          if (transport === "legacy") return callLegacy();
          return request("tools/call", { name: name, arguments: args }, timeoutMs);
        }
        if (plan.primary !== "unavailable") {
          return execute(plan.primary).catch(function (error) {
            if (plan.fallback) return execute(plan.fallback);
            throw error;
          });
        }
        return Promise.reject(new Error("This host cannot call Pippit tools from the widget."));
      }

      function mediaIdentity(media) {
        if (media && typeof media.resource_uri === "string") return media.resource_uri;
        return media && typeof media.url === "string" ? media.url : undefined;
      }

      function resourceChunkUri(resourceUri, offset, length) {
        var url = new URL(resourceUri);
        url.search = "";
        url.searchParams.set("length", String(length));
        url.searchParams.set("offset", String(offset));
        return url.toString();
      }

      function decodeResourceChunk(value) {
        if (typeof value !== "string" || value === "") throw new Error("The local video chunk is missing.");
        var binary = window.atob(value);
        var bytes = new Uint8Array(binary.length);
        for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
      }

      function localPreviewTransportAvailable() {
        return (
          (protocolReady && (serverResourcesAvailable || serverToolsAvailable)) ||
          openAiWidgetToolAvailable(window.openai)
        );
      }

      function appChunkContent(result, resourceUri, offset, expectedBytes, totalBytes) {
        var value = result && result.structuredContent && typeof result.structuredContent === "object"
          ? result.structuredContent
          : undefined;
        if (
          !value ||
          value.resource_uri !== resourceUri ||
          value.offset !== offset ||
          value.bytes !== expectedBytes ||
          value.total_bytes !== totalBytes ||
          typeof value.blob !== "string"
        ) {
          throw new Error("The local video tool response is invalid.");
        }
        return {
          _meta: {
            "pippit/chunk": {
              bytes: value.bytes,
              complete: value.complete,
              offset: value.offset,
              total_bytes: value.total_bytes
            }
          },
          blob: value.blob,
          mimeType: "video/mp4",
          uri: resourceChunkUri(resourceUri, offset, expectedBytes)
        };
      }

      async function readLocalPreviewChunk(resourceUri, offset, expectedBytes, totalBytes) {
        var uri = resourceChunkUri(resourceUri, offset, expectedBytes);
        if (protocolReady && serverResourcesAvailable && !resourceBridgeDemoted) {
          try {
            var resourceResult = await request(
              "resources/read",
              { uri: uri },
              LOCAL_RESOURCE_REQUEST_TIMEOUT_MS
            );
            var resourceContent = resourceResult && Array.isArray(resourceResult.contents)
              ? resourceResult.contents[0]
              : undefined;
            var resourceMeta = resourceContent && resourceContent._meta && typeof resourceContent._meta === "object"
              ? resourceContent._meta["pippit/chunk"]
              : undefined;
            if (
              resourceContent &&
              resourceContent.uri === uri &&
              resourceContent.mimeType === "video/mp4" &&
              resourceMeta &&
              resourceMeta.offset === offset &&
              resourceMeta.bytes === expectedBytes &&
              resourceMeta.total_bytes === totalBytes &&
              resourceMeta.complete === (offset + expectedBytes === totalBytes) &&
              typeof resourceContent.blob === "string"
            ) return resourceContent;
          } catch (_error) {}
          dispatchWidgetEvent({ type: "resource-bridge-demoted" });
        }
        var toolResult = await widgetController.callTool("pippit_read_video_chunk", {
          length: expectedBytes,
          offset: offset,
          resource_uri: resourceUri
        });
        if (!toolResult || toolResult.isError) {
          throw new Error("The saved local video could not be reopened.");
        }
        return appChunkContent(toolResult, resourceUri, offset, expectedBytes, totalBytes);
      }

      function revokePreviewObjectUrl() {
        previewLoader.revokeObjectUrl(function (url) { URL.revokeObjectURL(url); });
      }

      async function loadLocalResourcePreview(media, ticket, epochTicket) {
        var totalBytes = Number(media.bytes);
        var plans = planWidgetPreviewChunks(totalBytes, LOCAL_PREVIEW_CHUNK_BYTES, MAX_LOCAL_PREVIEW_BYTES);
        var chunks = [];
        for (var planIndex = 0; planIndex < plans.length; planIndex += 1) {
          if (
            !previewLoader.current(ticket) ||
            !isWidgetEpochTicketCurrent(epochTicket, previewLoadGeneration, activeJobId, destroyed)
          ) return;
          var chunkPlan = plans[planIndex];
          var uri = resourceChunkUri(media.resource_uri, chunkPlan.offset, chunkPlan.bytes);
          var content = await readLocalPreviewChunk(
            media.resource_uri,
            chunkPlan.offset,
            chunkPlan.bytes,
            totalBytes
          );
          if (!content || content.uri !== uri || content.mimeType !== "video/mp4") {
            throw new Error("The local video resource response is invalid.");
          }
          var chunkMeta = content._meta && typeof content._meta === "object"
            ? content._meta["pippit/chunk"]
            : undefined;
          if (!validateWidgetPreviewChunk(chunkMeta, chunkPlan, totalBytes)) {
            throw new Error("The local video resource metadata is invalid.");
          }
          var bytes = decodeResourceChunk(content.blob);
          if (bytes.byteLength !== chunkPlan.bytes) {
            throw new Error("The local video resource was truncated.");
          }
          chunks.push(bytes);
        }
        if (
          !previewLoader.current(ticket) ||
          !isWidgetEpochTicketCurrent(epochTicket, previewLoadGeneration, activeJobId, destroyed)
        ) return;
        var objectUrl = previewLoader.createObjectUrl(
          chunks,
          "video/mp4",
          function (blob) { return URL.createObjectURL(blob); },
          function (url) { URL.revokeObjectURL(url); }
        );
        videoElement.src = objectUrl;
        videoElement.load();
        filmstripGeneration += 1;
        void renderFilmstrip(objectUrl, filmstripGeneration);
      }

      function retryLocalPreview() {
        if (
          !activeJobId ||
          !activePreviewMedia ||
          typeof activePreviewMedia.resource_uri !== "string" ||
          !localPreviewTransportAvailable() ||
          previewRetryCount >= 1
        ) return false;
        previewRetryCount += 1;
        mediaMessageElement.textContent = "Reconnecting to the local video…";
        mediaMessageElement.hidden = false;
        window.clearTimeout(previewRetryTimer);
        previewRetryTimer = window.setTimeout(function () {
          previewRetryTimer = undefined;
          if (destroyed) return;
          setPreview({ id: activeJobId }, activePreviewMedia);
        }, 500);
        return true;
      }

      function localPreviewFailed() {
        dispatchWidgetEvent({ type: "preview-failed" });
        previewLoadKind = undefined;
        draftBeforeMediaRefresh = undefined;
        clearPreviewRenewal();
        revokePreviewObjectUrl();
        showEditor();`
