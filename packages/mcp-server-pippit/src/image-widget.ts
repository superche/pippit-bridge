export const PIPPIT_IMAGE_WIDGET_URI = "ui://widget/pippit-image-result-v1.html"

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
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    h1 { margin: 0; font-size: 14px; font-weight: 650; }
    #summary { color: color-mix(in srgb, CanvasText 62%, transparent); font-size: 12px; }
    #gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 12px; }
    figure { margin: 0; overflow: hidden; border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 14px; background: color-mix(in srgb, Canvas 94%, CanvasText 6%); }
    img { display: block; width: 100%; height: auto; max-height: 72vh; object-fit: contain; background: color-mix(in srgb, Canvas 88%, CanvasText 12%); }
    figcaption { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; }
    .filename { min-width: 0; overflow: hidden; color: color-mix(in srgb, CanvasText 65%, transparent); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .loading { min-height: 180px; display: grid; place-items: center; color: color-mix(in srgb, CanvasText 62%, transparent); font-size: 12px; }
    a { flex: none; border-radius: 9px; padding: 7px 10px; background: CanvasText; color: Canvas; font-size: 12px; font-weight: 650; text-decoration: none; }
    [hidden] { display: none !important; }
    #empty { margin: 0; padding: 18px; border: 1px dashed color-mix(in srgb, CanvasText 20%, transparent); border-radius: 12px; color: color-mix(in srgb, CanvasText 65%, transparent); text-align: center; }
  </style>
</head>
<body>
  <main>
    <header><h1>Pippit image result</h1><span id="summary">Loading…</span></header>
    <section id="gallery" aria-live="polite"></section>
    <p id="empty" hidden>The generated image could not be displayed.</p>
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
      var summary = document.getElementById("summary");
      var gallery = document.getElementById("gallery");
      var empty = document.getElementById("empty");

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
      function imageBlob(data, mimeType) {
        var decoded = window.atob(data);
        var bytes = new Uint8Array(decoded.length);
        for (var index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
        return new Blob([bytes], { type: mimeType });
      }
      function validImage(value) {
        return value && typeof value === "object" &&
          (typeof value.resource_uri === "string" || typeof value.data === "string") &&
          typeof value.filename === "string" && /^(?:image\/png|image\/jpeg|image\/webp)$/.test(value.mime_type);
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
      function callImageTool(image) {
        var args = { resource_uri: image.resource_uri };
        if (serverToolsAvailable) {
          return request("tools/call", { name: "pippit_read_image", arguments: args });
        }
        if (window.openai && typeof window.openai.callTool === "function") {
          return Promise.resolve(window.openai.callTool("pippit_read_image", args));
        }
        return Promise.reject(new Error("The local image tool is unavailable."));
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
        var loading = document.createElement("div");
        loading.className = "loading";
        loading.textContent = "Loading local image…";
        var preview = document.createElement("img");
        preview.alt = "Generated Pippit image " + String(index + 1);
        preview.loading = index === 0 ? "eager" : "lazy";
        preview.hidden = true;
        var caption = document.createElement("figcaption");
        var filename = document.createElement("span");
        filename.className = "filename";
        filename.textContent = image.filename;
        var download = document.createElement("a");
        download.download = image.filename;
        download.textContent = "Download original";
        download.hidden = true;
        caption.append(filename, download);
        figure.append(loading, preview, caption);
        gallery.append(figure);
        try {
          var data = await imageData(image);
          if (destroyed || generation !== renderGeneration) return;
          var url = URL.createObjectURL(imageBlob(data, image.mime_type));
          objectUrls.push(url);
          preview.src = url;
          preview.hidden = false;
          download.href = url;
          download.hidden = false;
          loading.remove();
          preview.addEventListener("load", reportSize, { once: true });
        } catch (_error) {
          loading.textContent = "The saved local image could not be loaded.";
        }
        reportSize();
      }
      function render(result) {
        bootstrapResult = result;
        var generation = ++renderGeneration;
        releaseUrls();
        gallery.replaceChildren();
        var metadata = result && result._meta && typeof result._meta === "object" ? result._meta : {};
        var images = Array.isArray(metadata["pippit/images"])
          ? metadata["pippit/images"].filter(validImage)
          : [];
        summary.textContent = images.length === 1 ? "1 image" : String(images.length) + " images";
        empty.hidden = images.length !== 0;
        images.forEach(function (image, index) {
          void loadFigure(image, index, generation);
        });
        reportSize();
      }
      function useOpenAiResult() {
        if (!window.openai) return;
        render({
          _meta: window.openai.toolResponseMetadata || {},
          structuredContent: window.openai.toolOutput
        });
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
        if (event.data.method === "ui/notifications/tool-result") render(event.data.params || {});
        if (event.data.method === "ui/resource-teardown") {
          if (event.data.id !== undefined) {
            window.parent.postMessage({ jsonrpc: "2.0", id: event.data.id, result: {} }, "*");
          }
          destroyed = true;
          renderGeneration += 1;
          releaseUrls();
          pending.forEach(function (state) { state.reject(new Error("Widget was closed.")); });
          pending.clear();
        }
      });
      window.addEventListener("openai:set_globals", useOpenAiResult, { passive: true });
      window.setTimeout(useOpenAiResult, 600);
      request("ui/initialize", {
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
        appInfo: { name: "pippit-image-result", title: "Pippit image result", version: "0.2.13" },
        protocolVersion: protocolVersion
      }).then(function (result) {
        protocolReady = true;
        var capabilities = result && result.hostCapabilities && typeof result.hostCapabilities === "object"
          ? result.hostCapabilities
          : {};
        serverResourcesAvailable = Boolean(capabilities.serverResources);
        serverToolsAvailable = Boolean(capabilities.serverTools);
        post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
        if (bootstrapResult) render(bootstrapResult);
      }).catch(function () {
        protocolReady = false;
        useOpenAiResult();
      });
    })();
  </script>
</body>
</html>`
