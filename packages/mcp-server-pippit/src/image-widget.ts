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
    a { flex: none; border-radius: 9px; padding: 7px 10px; background: CanvasText; color: Canvas; font-size: 12px; font-weight: 650; text-decoration: none; }
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
      var objectUrls = [];
      var summary = document.getElementById("summary");
      var gallery = document.getElementById("gallery");
      var empty = document.getElementById("empty");

      function post(message) { window.parent.postMessage(message, "*"); }
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
        return value && typeof value === "object" && typeof value.data === "string" &&
          typeof value.filename === "string" && /^(?:image\/png|image\/jpeg|image\/webp)$/.test(value.mime_type);
      }
      function render(result) {
        releaseUrls();
        gallery.replaceChildren();
        var metadata = result && result._meta && typeof result._meta === "object" ? result._meta : {};
        var images = Array.isArray(metadata["pippit/images"])
          ? metadata["pippit/images"].filter(validImage)
          : [];
        summary.textContent = images.length === 1 ? "1 image" : String(images.length) + " images";
        empty.hidden = images.length !== 0;
        images.forEach(function (image, index) {
          try {
            var url = URL.createObjectURL(imageBlob(image.data, image.mime_type));
            objectUrls.push(url);
            var figure = document.createElement("figure");
            var preview = document.createElement("img");
            preview.alt = "Generated Pippit image " + String(index + 1);
            preview.loading = index === 0 ? "eager" : "lazy";
            preview.src = url;
            preview.addEventListener("load", reportSize, { once: true });
            var caption = document.createElement("figcaption");
            var filename = document.createElement("span");
            filename.className = "filename";
            filename.textContent = image.filename;
            var download = document.createElement("a");
            download.download = image.filename;
            download.href = url;
            download.textContent = "Download original";
            caption.append(filename, download);
            figure.append(preview, caption);
            gallery.append(figure);
          } catch (_error) {
            empty.hidden = false;
          }
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
        if (event.data.method === "ui/notifications/tool-result") render(event.data.params || {});
        if (event.data.method === "ui/resource-teardown") {
          releaseUrls();
          if (event.data.id !== undefined) post({ jsonrpc: "2.0", id: event.data.id, result: {} });
        }
      });
      window.addEventListener("openai:set_globals", useOpenAiResult, { passive: true });
      window.setTimeout(useOpenAiResult, 600);
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "ui/initialize",
        params: {
          appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
          appInfo: { name: "pippit-image-result", title: "Pippit image result", version: "0.2.13" },
          protocolVersion: "2025-06-18"
        }
      });
    })();
  </script>
</body>
</html>`
