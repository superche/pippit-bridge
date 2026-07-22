#!/usr/bin/env node

import { isPippitStdioEntrypoint, runPippitStdioServer } from "./stdio/server.js"

export * from "./stdio/server.js"

if (isPippitStdioEntrypoint(process.argv[1], import.meta.url)) {
  void runPippitStdioServer().catch(() => {
    process.stderr.write("Pippit MCP server could not start. Check facade environment configuration.\n")
    process.exitCode = 1
  })
}
