import { WIDGET_MARKUP } from "./markup.ts"
import { WIDGET_SCRIPT_BOOTSTRAP } from "./script-bootstrap.ts"
import { WIDGET_SCRIPT_BRIDGE_PREVIEW } from "./script-bridge-preview.ts"
import { WIDGET_SCRIPT_CONTROLLER } from "./script-controller.ts"
import { WIDGET_SCRIPT_EDITOR } from "./script-editor.ts"
import { WIDGET_SCRIPT_VIEW } from "./script-view.ts"
import { WIDGET_STYLES_EDITOR } from "./styles-editor.ts"
import { WIDGET_STYLES_LAYOUT } from "./styles-layout.ts"

export const PIPPIT_WIDGET_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pippit video regeneration</title>
${WIDGET_STYLES_LAYOUT}${WIDGET_STYLES_EDITOR}
</head>
${WIDGET_MARKUP}
${WIDGET_SCRIPT_BRIDGE_PREVIEW}${WIDGET_SCRIPT_VIEW}${WIDGET_SCRIPT_EDITOR}${WIDGET_SCRIPT_CONTROLLER}${WIDGET_SCRIPT_BOOTSTRAP}
</body>
</html>`
