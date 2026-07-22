export const PIPPIT_IMAGE_WIDGET_URI = "ui://widget/pippit-image-result-v4.html"

export const PIPPIT_IMAGE_WIDGET_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px; background: transparent; color: CanvasText; }
    main { display: grid; gap: 12px; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding-inline: 32px; }
    h1 { margin: 0; font-size: 14px; font-weight: 650; }
    #summary { color: color-mix(in srgb, CanvasText 62%, transparent); font-size: 12px; }
    #gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 12px; }
    figure { margin: 0; overflow: hidden; border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 14px; background: color-mix(in srgb, Canvas 94%, CanvasText 6%); }
    img { display: block; width: 100%; height: auto; max-height: 72vh; object-fit: contain; background: color-mix(in srgb, Canvas 88%, CanvasText 12%); }
    figcaption { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; }
    .filename { min-width: 0; overflow: hidden; color: color-mix(in srgb, CanvasText 65%, transparent); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    button, a { flex: none; min-height: 36px; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 9px; padding: 7px 12px; background: CanvasText; color: Canvas; cursor: pointer; font: inherit; font-size: 12px; font-weight: 650; text-decoration: none; }
    button:disabled { cursor: default; opacity: .58; }
    [hidden] { display: none !important; }
    #empty { margin: 0; padding: 18px; border: 1px dashed color-mix(in srgb, CanvasText 20%, transparent); border-radius: 12px; color: color-mix(in srgb, CanvasText 65%, transparent); text-align: center; }
    .loading-view { display: grid; min-height: 300px; place-content: center; justify-items: center; gap: 22px; text-align: center; }
    .loading-status { margin: 0; color: color-mix(in srgb, CanvasText 62%, transparent); font-size: 14px; font-weight: 500; letter-spacing: -.01em; line-height: 20px; }
    .infinity-loader { display: grid; grid-template-columns: repeat(5, 8px); grid-template-rows: repeat(5, 8px); gap: 6px; width: 64px; height: 64px; place-content: center; color: CanvasText; }
    .infinity-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .08; transition: opacity 40ms linear; }
    @media (max-width: 640px) { header { padding-inline: 4px; } .loading-view { min-height: 240px; } }
    @media (prefers-reduced-motion: reduce) { .infinity-dot { transition: none; } }
  </style>
</head>
<body>
  <main>
    <section id="loading-view" class="loading-view" role="status" aria-live="polite">
      <div id="infinity-loader" class="infinity-loader" aria-hidden="true"></div>
      <p id="loading-status" class="loading-status">Preparing the local image preview…</p>
    </section>
    <header id="result-header" hidden><h1>Pippit image result</h1><span id="summary"></span></header>
    <section id="gallery" aria-live="polite" hidden></section>
    <p id="empty" hidden>The saved local image could not be loaded.</p>
  </main>
  <script>
    (function () {
      "use strict";
      var DEFAULT_REQUEST_TIMEOUT_MS = 15000;
      var protocolVersion = "2026-01-26";
      var nextId = 1;
      var pending = new Map();
      var objectUrls = [];
      var protocolReady = false;
      var serverResourcesAvailable = false;
      var serverToolsAvailable = false;
      var bootstrapResult;
      var renderGeneration = 0;
      var destroyed = false;
      var pollTimer;
      var loaderStep = 0;
      var loaderTimer;
      var loadingView = document.getElementById("loading-view");
      var loadingStatus = document.getElementById("loading-status");
      var infinityLoader = document.getElementById("infinity-loader");
      var resultHeader = document.getElementById("result-header");
      var summary = document.getElementById("summary");
      var gallery = document.getElementById("gallery");
      var empty = document.getElementById("empty");
      var loaderDots = [];

      for (var dotIndex = 0; dotIndex < 25; dotIndex += 1) {
        var dot = document.createElement("span");
        dot.className = "infinity-dot";
        infinityLoader.append(dot);
        loaderDots.push(dot);
      }

      function post(message) {
        if (!destroyed) window.parent.postMessage(message, "*");
      }
      function request(method, params) {
        return new Promise(function (resolve, reject) {
          var id = nextId++;
          var timer = window.setTimeout(function () {
            pending.delete(id);
            reject(new Error(method + " timed out"));
          }, DEFAULT_REQUEST_TIMEOUT_MS);
          pending.set(id, {
            resolve: function (value) { window.clearTimeout(timer); resolve(value); },
            reject: function (error) { window.clearTimeout(timer); reject(error); }
          });
          post({ jsonrpc: "2.0", id: id, method: method, params: params });
        });
      }
      function reportSize() {
        post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: {
          height: Math.ceil(document.documentElement.scrollHeight),
          width: Math.ceil(document.documentElement.scrollWidth)
        } });
      }
      function releaseUrls() {
        objectUrls.forEach(function (url) { URL.revokeObjectURL(url); });
        objectUrls = [];
      }
      function clearPollTimer() {
        window.clearTimeout(pollTimer);
        pollTimer = undefined;
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
        if (loaderTimer || loadingView.hidden) return;
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
        loadingView.hidden = false;
        resultHeader.hidden = true;
        gallery.hidden = true;
        empty.hidden = true;
        loadingStatus.textContent = status === "in_progress"
          ? "Generating your image…"
          : "Preparing the local image preview…";
        startInfinityLoader();
        reportSize();
      }
      function showResults(count) {
        stopInfinityLoader();
        loadingView.hidden = true;
        resultHeader.hidden = false;
        gallery.hidden = false;
        empty.hidden = true;
        summary.textContent = count === 1 ? "1 image" : String(count) + " images";
        reportSize();
      }
      function showTerminal(message) {
        stopInfinityLoader();
        loadingView.hidden = true;
        resultHeader.hidden = true;
        gallery.hidden = true;
        empty.textContent = message;
        empty.hidden = false;
        reportSize();
      }
      function imageBlob(data, mimeType) {
        var decoded = window.atob(data);
        var bytes = new Uint8Array(decoded.length);
        for (var index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
        return new Blob([bytes], { type: mimeType });
      }
      function imageExtension(mimeType) {
        if (mimeType === "image/jpeg") return "jpg";
        if (mimeType === "image/webp") return "webp";
        return "png";
      }
      function normalizeImage(value, index) {
        if (!value || typeof value !== "object") return undefined;
        var mimeType = value.mime_type || value.media_type || value.mimeType;
        if (!/^(?:image\/png|image\/jpeg|image\/webp)$/.test(mimeType)) return undefined;
        if (typeof value.resource_uri !== "string" && typeof value.data !== "string") return undefined;
        return {
          data: value.data,
          filename: typeof value.filename === "string" ? value.filename : "pippit-image-" + String(index + 1) + "." + imageExtension(mimeType),
          mime_type: mimeType,
          resource_uri: value.resource_uri
        };
      }
      function parseJsonValue(value) {
        if (typeof value !== "string") return value;
        try { return JSON.parse(value); } catch (_error) { return value; }
      }
      function normalizeResult(value) {
        var current = parseJsonValue(value);
        for (var depth = 0; depth < 3; depth += 1) {
          if (!current || typeof current !== "object") break;
          if (Array.isArray(current)) return { content: current };
          var nested = parseJsonValue(
            current.mcp_tool_result || current.mcpToolResult || current.call_tool_result ||
            current.callToolResult || current.toolResult || current.result
          );
          if (nested && typeof nested === "object") current = nested;
          else break;
        }
        return current && typeof current === "object" ? current : {};
      }
      function imageJob(rawResult) {
        var result = normalizeResult(rawResult);
        var structured = result.structuredContent && typeof result.structuredContent === "object"
          ? result.structuredContent
          : result;
        if (typeof structured.image_job_id !== "string" || typeof structured.status !== "string") return undefined;
        return { id: structured.image_job_id, status: structured.status };
      }
      function openAiToolResult(globals) {
        var source = globals && typeof globals === "object" ? globals : window.openai;
        if (!source) return undefined;
        var output = parseJsonValue(source.toolOutput);
        var metadata = parseJsonValue(source.toolResponseMetadata);
        var metadataResult = normalizeResult(metadata);
        var hasEnvelope = metadataResult && typeof metadataResult === "object" && (
          metadataResult.structuredContent !== undefined || Array.isArray(metadataResult.content) ||
          metadataResult._meta !== undefined
        );
        if (output === undefined && !hasEnvelope) return undefined;
        return {
          content: hasEnvelope && Array.isArray(metadataResult.content) ? metadataResult.content : [],
          structuredContent: output !== undefined ? output : metadataResult.structuredContent,
          _meta: hasEnvelope && metadataResult._meta && typeof metadataResult._meta === "object"
            ? metadataResult._meta
            : {}
        };
      }
      function resultImages(rawResult) {
        var result = normalizeResult(rawResult);
        var metadata = result._meta && typeof result._meta === "object" ? result._meta : {};
        var metadataImages = Array.isArray(metadata["pippit/images"]) ? metadata["pippit/images"] : [];
        var normalized = metadataImages.map(normalizeImage).filter(Boolean);
        if (normalized.length > 0) return normalized;
        var structured = result.structuredContent && typeof result.structuredContent === "object"
          ? result.structuredContent
          : result;
        var structuredImages = Array.isArray(structured.images) ? structured.images : [];
        normalized = structuredImages.map(normalizeImage).filter(Boolean);
        if (normalized.length > 0) return normalized;
        var contentImages = Array.isArray(result.content)
          ? result.content.filter(function (item) { return item && item.type === "image"; })
          : [];
        return contentImages.map(normalizeImage).filter(Boolean);
      }
      function resourceBlob(result, image) {
        var contents = result && Array.isArray(result.contents) ? result.contents : [];
        var content = contents.find(function (item) {
          return item && item.uri === image.resource_uri && item.mimeType === image.mime_type &&
            typeof item.blob === "string";
        });
        if (!content) throw new Error("The local image resource was invalid.");
        return content.blob;
      }
      function toolBlob(result, image) {
        var output = result && result.structuredContent && typeof result.structuredContent === "object"
          ? result.structuredContent
          : {};
        if (output.resource_uri !== image.resource_uri || output.mime_type !== image.mime_type ||
          typeof output.blob !== "string") {
          throw new Error("The local image tool result was invalid.");
        }
        return output.blob;
      }
      function callTool(name, args) {
        if (serverToolsAvailable) {
          return request("tools/call", { name: name, arguments: args });
        }
        if (window.openai && typeof window.openai.callTool === "function") {
          return Promise.resolve(window.openai.callTool(name, args));
        }
        return Promise.reject(new Error("The local Pippit image tool is unavailable."));
      }
      function callImageTool(image) {
        return callTool("pippit_read_image", { resource_uri: image.resource_uri });
      }
      function fileManagerLabel() {
        var nav = window.navigator || {};
        var platform = String(
          nav.userAgentData && nav.userAgentData.platform || nav.platform || nav.userAgent || ""
        ).toLowerCase();
        if (platform.includes("mac")) return "Show in Finder";
        if (platform.includes("win")) return "Show in Explorer";
        return "Show in folder";
      }
      function schedulePoll(jobId) {
        clearPollTimer();
        pollTimer = window.setTimeout(function () {
          callTool("pippit_get_image", { image_job_id: jobId })
            .then(function (result) { void render(result); })
            .catch(function () { schedulePoll(jobId); });
        }, 900);
      }
      async function imageData(image) {
        if (typeof image.resource_uri === "string") {
          if (serverResourcesAvailable) {
            try {
              return resourceBlob(await request("resources/read", { uri: image.resource_uri }), image);
            } catch (_error) {}
          }
          return toolBlob(await callImageTool(image), image);
        }
        return image.data;
      }
      async function loadFigure(image, index, generation) {
        var figure = document.createElement("figure");
        figure.hidden = true;
        var preview = document.createElement("img");
        preview.alt = "Generated Pippit image " + String(index + 1);
        preview.loading = index === 0 ? "eager" : "lazy";
        preview.hidden = true;
        var caption = document.createElement("figcaption");
        var filename = document.createElement("span");
        filename.className = "filename";
        filename.textContent = image.filename;
        var action = document.createElement(typeof image.resource_uri === "string" ? "button" : "a");
        action.hidden = true;
        if (typeof image.resource_uri === "string") {
          action.type = "button";
          action.textContent = fileManagerLabel();
        } else {
          action.download = image.filename;
          action.textContent = "Download original";
        }
        caption.append(filename, action);
        figure.append(preview, caption);
        gallery.append(figure);
        try {
          var data = await imageData(image);
          if (destroyed || generation !== renderGeneration) return false;
          var url = URL.createObjectURL(imageBlob(data, image.mime_type));
          objectUrls.push(url);
          if (typeof image.resource_uri === "string") {
            action.hidden = false;
            action.addEventListener("click", function () {
              var label = fileManagerLabel();
              action.disabled = true;
              action.textContent = "Opening…";
              callTool("pippit_reveal_image", { resource_uri: image.resource_uri })
                .then(function () { action.textContent = label === "Show in folder" ? "Shown in folder" : label.replace("Show", "Shown"); })
                .catch(function () {
                  action.disabled = false;
                  action.textContent = label;
                });
            });
          } else {
            action.href = url;
            action.hidden = false;
          }
          var loaded = await new Promise(function (resolve) {
            preview.addEventListener("load", function () { resolve(true); }, { once: true });
            preview.addEventListener("error", function () { resolve(false); }, { once: true });
            preview.src = url;
          });
          if (!loaded || destroyed || generation !== renderGeneration) return false;
          preview.hidden = false;
          figure.hidden = false;
          reportSize();
          return true;
        } catch (_error) {
          return false;
        }
      }
      async function render(rawResult) {
        var result = normalizeResult(rawResult);
        bootstrapResult = result;
        var generation = ++renderGeneration;
        clearPollTimer();
        releaseUrls();
        gallery.replaceChildren();
        var job = imageJob(result);
        showLoading(job && job.status);
        if (!protocolReady && !(window.openai && typeof window.openai.callTool === "function")) return;
        if (job && job.status === "in_progress") {
          schedulePoll(job.id);
          return;
        }
        if (result.isError === true || job && job.status === "failed") {
          showTerminal("The Pippit image generation could not be completed.");
          return;
        }
        var images = resultImages(result);
        if (images.length === 0) {
          showTerminal("The generated image result did not include a local preview.");
          return;
        }
        var loaded = await Promise.all(images.map(function (image, index) {
          return loadFigure(image, index, generation);
        }));
        if (destroyed || generation !== renderGeneration) return;
        var loadedCount = loaded.filter(Boolean).length;
        if (loadedCount === 0) showTerminal("The saved local image could not be loaded.");
        else showResults(loadedCount);
      }
      function useOpenAiResult(event) {
        var globals = event && event.detail && event.detail.globals;
        var result = openAiToolResult(globals);
        if (result !== undefined) void render(result);
      }

      window.addEventListener("message", function (event) {
        if (event.source !== window.parent || !event.data || event.data.jsonrpc !== "2.0") return;
        if (event.data.id !== undefined && pending.has(event.data.id)) {
          var state = pending.get(event.data.id);
          pending.delete(event.data.id);
          if (event.data.error) state.reject(new Error(event.data.error.message || "Host request failed"));
          else state.resolve(event.data.result);
          return;
        }
        if (event.data.method === "ui/notifications/tool-result") void render(event.data.params || {});
        if (event.data.method === "ui/resource-teardown") {
          if (event.data.id !== undefined) {
            window.parent.postMessage({ jsonrpc: "2.0", id: event.data.id, result: {} }, "*");
          }
          destroyed = true;
          renderGeneration += 1;
          clearPollTimer();
          stopInfinityLoader();
          releaseUrls();
          pending.forEach(function (state) { state.reject(new Error("Widget was closed.")); });
          pending.clear();
        }
      });
      window.addEventListener("openai:set_globals", useOpenAiResult, { passive: true });
      window.setTimeout(useOpenAiResult, 600);
      request("ui/initialize", {
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
        appInfo: { name: "pippit-image-result", title: "Pippit image result", version: "0.2.17" },
        protocolVersion: protocolVersion
      }).then(function (result) {
        protocolReady = true;
        var capabilities = result && result.hostCapabilities && typeof result.hostCapabilities === "object"
          ? result.hostCapabilities
          : {};
        serverResourcesAvailable = Boolean(capabilities.serverResources);
        serverToolsAvailable = Boolean(capabilities.serverTools);
        post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
        if (bootstrapResult) void render(bootstrapResult);
      }).catch(function () {
        protocolReady = false;
        useOpenAiResult();
      });
      startInfinityLoader();
    })();
  </script>
</body>
</html>`
