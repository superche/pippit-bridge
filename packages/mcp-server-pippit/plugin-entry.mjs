#!/usr/bin/env node

import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const distEntry = new URL("./dist/stdio.js", import.meta.url)
const sourceEntry = new URL("./src/stdio.ts", import.meta.url)
const runtimeEntry = existsSync(fileURLToPath(distEntry)) ? distEntry : sourceEntry

try {
  const runtime = await import(runtimeEntry.href)
  await runtime.runPippitStdioServer()
} catch {
  process.stderr.write("Pippit MCP server could not start. Check the plugin package and facade environment configuration.\n")
  process.exitCode = 1
}
