import { spawn } from "node:child_process"
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

const entryArgument = process.argv[2]
if (entryArgument === undefined) {
  throw new Error("Usage: node smoke-installed-plugin.mjs /absolute/path/to/plugin-entry.mjs")
}
if (!isAbsolute(entryArgument)) throw new Error("The plugin entry path must be absolute.")
const entryPath = resolve(entryArgument)
const pluginManifest = JSON.parse(await readFile(join(dirname(entryPath), ".codex-plugin", "plugin.json"), "utf8"))
if (pluginManifest.version !== "0.2.15") throw new Error("The packaged Codex plugin manifest version is unexpected.")

const dataRoot = await mkdtemp(join(tmpdir(), "pippit-packed-runtime-"))
await rm(dataRoot, { force: true, recursive: true })

function request(id, method, params = {}) {
  return { id, jsonrpc: "2.0", method, params }
}

async function waitForExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
    } catch {
      return
    }
  }
  throw new Error("The packaged local Facade did not stop in time.")
}

let daemonPid
try {
  const protocol = [
    request(1, "initialize", {
      capabilities: {},
      clientInfo: { name: "packed-smoke", version: "1" },
      protocolVersion: "2025-11-25",
    }),
    request(2, "tools/list"),
    request(3, "resources/list"),
    request(4, "resources/read", { uri: "ui://widget/pippit-video-job-v13.html" }),
    request(5, "tools/call", { arguments: {}, name: "pippit_list_access_keys" }),
    request(6, "resources/read", { uri: "ui://widget/pippit-image-result-v3.html" }),
    request(7, "resources/read", { uri: "ui://widget/pippit-image-result-v2.html" }),
  ]
  const run = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [entryPath], {
      env: { PIPPIT_BRIDGE_HOME: dataRoot },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stderr = ""
    let stdout = ""
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      rejectRun(new Error("The packaged MCP smoke test timed out."))
    }, 20_000)
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    let inputClosed = false
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk
      if (!inputClosed && stdout.split("\n").filter(Boolean).length >= protocol.length) {
        inputClosed = true
        child.stdin.end()
      }
    })
    child.once("error", (error) => {
      clearTimeout(timeout)
      rejectRun(error)
    })
    child.once("close", (code) => {
      clearTimeout(timeout)
      resolveRun({ code, stderr, stdout })
    })
    child.stdin.write(`${protocol.map((message) => JSON.stringify(message)).join("\n")}\n`)
  })

  if (run.code !== 0 || run.stderr !== "") {
    throw new Error("The packaged MCP entry did not exit cleanly.")
  }
  const responses = run.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const tools = responses.find((response) => response.id === 2)?.result?.tools ?? []
  const listedResources = responses.find((response) => response.id === 3)?.result?.resources ?? []
  const widgetResource = responses.find((response) => response.id === 4)?.result?.contents?.[0]
  const toolCall = responses.find((response) => response.id === 5)?.result
  const imageWidgetResource = responses.find((response) => response.id === 6)?.result?.contents?.[0]
  const legacyImageWidgetResource = responses.find((response) => response.id === 7)?.result?.contents?.[0]
  if (responses.find((response) => response.id === 1)?.result?.serverInfo?.version !== "0.2.15") {
    throw new Error("The packaged MCP server version is unexpected.")
  }
  const expectedTools = [
    "pippit_add_access_key",
    "pippit_generate_image",
    "pippit_generate_video",
    "pippit_read_image",
    "pippit_read_video_chunk",
    "pippit_resolve_latest_video",
  ]
  if (!expectedTools.every((name) => tools.some((tool) => tool.name === name))) {
    throw new Error("The packaged MCP tool surface is incomplete.")
  }
  const imageTool = tools.find((tool) => tool.name === "pippit_generate_image")
  const readImageTool = tools.find((tool) => tool.name === "pippit_read_image")
  const chunkTool = tools.find((tool) => tool.name === "pippit_read_video_chunk")
  const resolveLatestTool = tools.find((tool) => tool.name === "pippit_resolve_latest_video")
  if (
    JSON.stringify(readImageTool?._meta?.ui?.visibility) !== JSON.stringify(["app"]) ||
    readImageTool?._meta?.["openai/widgetAccessible"] !== true ||
    JSON.stringify(chunkTool?._meta?.ui?.visibility) !== JSON.stringify(["app"]) ||
    chunkTool?._meta?.["openai/widgetAccessible"] !== true
  ) {
    throw new Error("The packaged local media reader is not app-only.")
  }
  if (
    JSON.stringify(resolveLatestTool?._meta?.ui?.visibility) !== JSON.stringify(["app"]) ||
    resolveLatestTool?._meta?.["openai/widgetAccessible"] !== true
  ) {
    throw new Error("The packaged latest-video resolver is not app-only.")
  }
  const getVideo = tools.find((tool) => tool.name === "pippit_get_video")
  if (
    getVideo?._meta?.ui?.resourceUri !== "ui://widget/pippit-video-job-v13.html" ||
    getVideo?._meta?.["openai/outputTemplate"] !== "ui://widget/pippit-video-job-v13.html"
  ) {
    throw new Error("The packaged MCP tools do not bind the shared widget.")
  }
  if (
    !listedResources.some((resource) => resource.uri === "ui://widget/pippit-video-job-v13.html") ||
    !listedResources.some((resource) => resource.uri === "ui://widget/pippit-image-result-v3.html") ||
    widgetResource?.mimeType !== "text/html;profile=mcp-app" ||
    !widgetResource?.text?.includes("pippit-video-editor") ||
    !widgetResource?.text?.includes("function newAnnotationId()") ||
    !widgetResource?.text?.includes("function retryLatestResolution()") ||
    !widgetResource?.text?.includes("activeModel = resolveWidgetModel(activeModel, bootstrapJob.model)") ||
    widgetResource?.text?.includes("newIdempotencyKey()")
  ) {
    throw new Error("The packaged MCP widget resource is incomplete.")
  }
  if (
    imageTool?._meta?.ui?.resourceUri !== "ui://widget/pippit-image-result-v3.html" ||
    imageTool?._meta?.["openai/outputTemplate"] !== "ui://widget/pippit-image-result-v3.html" ||
    imageWidgetResource?.mimeType !== "text/html;profile=mcp-app" ||
    !imageWidgetResource?.text?.includes("function resultImages(rawResult)") ||
    !imageWidgetResource?.text?.includes("function infinityPoint(step)") ||
    !imageWidgetResource?.text?.includes("pippit_read_image") ||
    !imageWidgetResource?.text?.includes("current.mcp_tool_result") ||
    legacyImageWidgetResource?.uri !== "ui://widget/pippit-image-result-v2.html" ||
    legacyImageWidgetResource?.text !== imageWidgetResource.text
  ) {
    throw new Error("The packaged MCP image widget resource is incomplete.")
  }
  if (toolCall?.isError === true) {
    throw new Error(`The packaged MCP could not call its auto-bootstrapped local Facade: ${JSON.stringify(toolCall.structuredContent?.error ?? toolCall.content)}`)
  }

  const descriptor = JSON.parse(await readFile(join(dataRoot, "facade-ready.json"), "utf8"))
  const secrets = JSON.parse(await readFile(join(dataRoot, "runtime-secrets.json"), "utf8"))
  daemonPid = descriptor.pid
  const visibleProtocol = `${run.stderr}\n${run.stdout}`
  for (const secret of [secrets.facade_api_key, secrets.management_api_key]) {
    if (visibleProtocol.includes(secret)) throw new Error("An internal runtime key leaked into MCP output.")
  }

  if (process.platform !== "win32") {
    const directory = await lstat(dataRoot)
    const secretFile = await lstat(join(dataRoot, "runtime-secrets.json"))
    const readyFile = await lstat(join(dataRoot, "facade-ready.json"))
    const storeFile = await lstat(join(dataRoot, "byok", "credentials.json"))
    if ((directory.mode & 0o777) !== 0o700) throw new Error("The local runtime directory is not private.")
    for (const file of [secretFile, readyFile, storeFile]) {
      if ((file.mode & 0o777) !== 0o600) throw new Error("A local runtime state file is not private.")
    }
  }

  process.stdout.write(`${JSON.stringify({
    account_count: toolCall?.structuredContent?.data?.length ?? 0,
    server_version: "0.2.15",
    tool_count: tools.length,
    widget_resource: true,
  })}\n`)
} finally {
  if (typeof daemonPid === "number") {
    try {
      process.kill(daemonPid, "SIGTERM")
      await waitForExit(daemonPid)
    } catch {
      // The daemon may already have exited; the temporary root is still isolated.
    }
  }
  await rm(dataRoot, { force: true, recursive: true })
}
