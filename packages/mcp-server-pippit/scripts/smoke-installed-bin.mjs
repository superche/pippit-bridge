import { spawn } from "node:child_process"
import { isAbsolute, join, resolve } from "node:path"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

const EXPECTED_PLUGIN_VERSION = "0.2.17"
const launcherArgument = process.argv[2]
if (launcherArgument === undefined || !isAbsolute(launcherArgument)) {
  throw new Error("Usage: node smoke-installed-bin.mjs /absolute/path/to/pippit-mcp")
}
const launcherPath = resolve(launcherArgument)
const dataRoot = await mkdtemp(join(tmpdir(), "pippit-installed-bin-"))
await rm(dataRoot, { force: true, recursive: true })

function request(id, method, params = {}) {
  return { id, jsonrpc: "2.0", method, params }
}

async function waitForExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
    } catch {
      return
    }
  }
  throw new Error("The installed-bin local Facade did not stop in time.")
}

let daemonPid
try {
  const protocol = [
    request(1, "initialize", {
      capabilities: {},
      clientInfo: { name: "installed-bin-smoke", version: "1" },
      protocolVersion: "2025-11-25",
    }),
    request(2, "tools/list"),
    request(3, "resources/read", { uri: "ui://widget/pippit-video-job-v15.html" }),
    request(4, "tools/call", { arguments: {}, name: "pippit_list_access_keys" }),
  ]
  const run = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [launcherPath], {
      env: { ...process.env, PIPPIT_BRIDGE_HOME: dataRoot },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stderr = ""
    let stdout = ""
    let inputClosed = false
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      rejectRun(new Error("The installed pippit-mcp bin timed out."))
    }, 20_000)
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk })
    child.stdout.setEncoding("utf8").on("data", chunk => {
      stdout += chunk
      if (!inputClosed && stdout.split("\n").filter(Boolean).length >= protocol.length) {
        inputClosed = true
        child.stdin.end()
      }
    })
    child.once("error", error => {
      clearTimeout(timeout)
      rejectRun(error)
    })
    child.once("close", code => {
      clearTimeout(timeout)
      resolveRun({ code, stderr, stdout })
    })
    child.stdin.write(`${protocol.map(message => JSON.stringify(message)).join("\n")}\n`)
  })

  if (run.code !== 0 || run.stderr !== "") {
    throw new Error(`The installed pippit-mcp bin did not exit cleanly (code=${run.code}, stderr=${JSON.stringify(run.stderr)}).`)
  }
  const responses = run.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line))
  const initialized = responses.find(response => response.id === 1)?.result
  const tools = responses.find(response => response.id === 2)?.result?.tools ?? []
  const widget = responses.find(response => response.id === 3)?.result?.contents?.[0]
  const accountCall = responses.find(response => response.id === 4)?.result
  if (
    initialized?.serverInfo?.version !== EXPECTED_PLUGIN_VERSION ||
    tools.length !== 16 ||
    widget?.mimeType !== "text/html;profile=mcp-app" ||
    !widget?.text?.includes("pippit-video-editor") ||
    accountCall?.isError === true
  ) {
    throw new Error(`The installed pippit-mcp bin surface is invalid: ${JSON.stringify({ initialized, toolCount: tools.length, widget, accountCall })}`)
  }
  const descriptor = JSON.parse(await readFile(join(dataRoot, "facade-ready.json"), "utf8"))
  daemonPid = descriptor.pid
  process.stdout.write(`${JSON.stringify({
    account_count: accountCall?.structuredContent?.data?.length ?? 0,
    launcher: "pippit-mcp",
    server_version: EXPECTED_PLUGIN_VERSION,
    tool_count: tools.length,
    widget_resource: true,
  })}\n`)
} finally {
  if (typeof daemonPid === "number") {
    try {
      process.kill(daemonPid, "SIGTERM")
      await waitForExit(daemonPid)
    } catch {
      // The isolated daemon may already have exited.
    }
  }
  await rm(dataRoot, { force: true, recursive: true })
}
