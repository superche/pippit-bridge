#!/bin/sh
set -eu

if [ -n "${PIPPIT_NODE_PATH:-}" ]; then
  exec "$PIPPIT_NODE_PATH" ./dist/dev-gateway-stdio.mjs
fi

for node_path in '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node' '/opt/homebrew/bin/node' '/usr/local/bin/node' "$HOME/.volta/bin/node"; do
  if [ -x "$node_path" ]; then exec "$node_path" ./dist/dev-gateway-stdio.mjs; fi
done

if node_path="$(command -v node 2>/dev/null)" && [ -x "$node_path" ]; then
  exec "$node_path" ./dist/dev-gateway-stdio.mjs
fi

printf '%s\n' 'Pippit dev gateway requires a compatible Node.js executable; direct npm does not bundle Node.js.' >&2
exit 127
