#!/bin/sh

set -eu

if [ -n "${PIPPIT_NODE_PATH:-}" ]; then
  if [ ! -x "$PIPPIT_NODE_PATH" ]; then
    printf '%s\n' 'PIPPIT_NODE_PATH must point to an executable Node.js binary.' >&2
    exit 127
  fi
  exec "$PIPPIT_NODE_PATH" ./plugin-entry.mjs
fi

# Codex Desktop is a GUI application on macOS, so it does not necessarily
# inherit the user's interactive-shell PATH. Prefer its bundled Node runtime
# when present, then fall back to ordinary system and version-manager paths.
for node_path in \
  '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node' \
  '/opt/homebrew/bin/node' \
  '/usr/local/bin/node' \
  "$HOME/.volta/bin/node"
do
  if [ -x "$node_path" ]; then
    exec "$node_path" ./plugin-entry.mjs
  fi
done

if node_path="$(command -v node 2>/dev/null)" && [ -x "$node_path" ]; then
  exec "$node_path" ./plugin-entry.mjs
fi

for node_path in \
  "$HOME"/.nvm/versions/node/*/bin/node \
  "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
  "$HOME"/Library/Application\ Support/fnm/node-versions/*/installation/bin/node
do
  if [ -x "$node_path" ]; then
    exec "$node_path" ./plugin-entry.mjs
  fi
done

printf '%s\n' 'Pippit MCP server requires Node.js, but no executable Node.js runtime was found.' >&2
exit 127
