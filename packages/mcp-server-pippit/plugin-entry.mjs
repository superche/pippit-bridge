#!/usr/bin/env node

import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const distEntry = new URL("./dist/plugin-stdio.mjs", import.meta.url)
const bundledDaemon = new URL("./dist/local-facade-daemon.mjs", import.meta.url)

async function runPublishedPackage() {
  const packageMetadata = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  const packageSpec = `@pippit-bridge/mcp-server@${packageMetadata.version}`
  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx"
  const child = spawn(npxCommand, ["--yes", "--package", packageSpec, "pippit-mcp"], {
    env: process.env,
    stdio: "inherit",
  })

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })

  if (result.signal) {
    process.kill(process.pid, result.signal)
    return
  }
  process.exitCode = result.code ?? 1
}

try {
  if (
    existsSync(fileURLToPath(distEntry)) &&
    existsSync(fileURLToPath(bundledDaemon))
  ) {
    const runtime = await import(distEntry.href)
    await runtime.runPippitStdioServer()
  } else {
    await runPublishedPackage()
  }
} catch {
  process.stderr.write("Pippit MCP server could not start. Check Node.js/npm availability and the facade environment configuration.\n")
  process.exitCode = 1
}
