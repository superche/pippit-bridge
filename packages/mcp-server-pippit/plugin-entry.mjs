#!/usr/bin/env node

import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const distEntry = new URL("./dist/plugin-stdio.mjs", import.meta.url)
const bundledDaemon = new URL("./dist/local-facade-daemon.mjs", import.meta.url)
const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org"

function nodeVersionSupported(version) {
  const [major, minor, patch] = version.split(".").map(Number)
  if (![major, minor, patch].every(Number.isInteger)) return false
  if (major >= 26) return true
  if (major === 24) return minor > 15 || (minor === 15 && patch >= 0)
  return major === 22 && (minor > 22 || (minor === 22 && patch >= 2))
}

async function runPublishedPackage() {
  const packageMetadata = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  const packageSpec = `@pippit-bridge/mcp-server@${packageMetadata.version}`
  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx"
  const child = spawn(npxCommand, ["--yes", "--registry", OFFICIAL_NPM_REGISTRY, "--package", packageSpec, "pippit-mcp"], {
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
  if (!nodeVersionSupported(process.versions.node)) {
    throw new Error(`Unsupported Node.js ${process.versions.node}; requires ^22.22.2 || ^24.15.0 || >=26.0.0.`)
  }
  if (
    existsSync(fileURLToPath(distEntry)) &&
    existsSync(fileURLToPath(bundledDaemon))
  ) {
    const runtime = await import(distEntry.href)
    await runtime.runPippitStdioServer()
  } else {
    await runPublishedPackage()
  }
} catch (error) {
  const reason = error instanceof Error ? error.message : "unknown startup failure"
  process.stderr.write(`Pippit MCP server could not start: ${reason}\nDirect npm installs require a compatible Node.js executable; the package does not bundle Node.js.\n`)
  process.exitCode = 1
}
