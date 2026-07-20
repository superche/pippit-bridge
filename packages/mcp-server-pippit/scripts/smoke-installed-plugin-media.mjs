import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { once } from "node:events"

const [entryArgument, mediaArgument] = process.argv.slice(2)
if (entryArgument === undefined || mediaArgument === undefined) {
  throw new Error("Usage: node smoke-installed-plugin-media.mjs /absolute/plugin-entry.mjs /absolute/video.mp4")
}
if (!isAbsolute(entryArgument) || !isAbsolute(mediaArgument)) {
  throw new Error("The plugin entry and video fixture paths must be absolute.")
}

const entryPath = resolve(entryArgument)
const mediaPath = resolve(mediaArgument)
const mediaBytes = await readFile(mediaPath)
if (mediaBytes.byteLength < 1) throw new Error("The video fixture is empty.")
const mediaDigest = createHash("sha256").update(mediaBytes).digest("hex")
const outputRoot = await mkdtemp(join(tmpdir(), "pippit-installed-media-"))
const facadeApiKey = "installed-plugin-media-smoke-key"

function json(response, status, body) {
  const value = JSON.stringify(body)
  response.writeHead(status, {
    "content-length": Buffer.byteLength(value),
    "content-type": "application/json; charset=utf-8",
  })
  response.end(value)
}

const facade = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${facadeApiKey}`) {
    json(response, 401, { error: "unauthorized" })
    return
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  if (request.method === "GET" && url.pathname === "/api/v1/videos/job_installed_media") {
    json(response, 200, {
      id: "job_installed_media",
      model: "pippit/seedance-2.0-fast",
      polling_url: "/api/v1/videos/job_installed_media",
      status: "completed",
      unsigned_urls: ["/api/v1/videos/job_installed_media/content?index=0"],
    })
    return
  }
  if (request.method === "GET" && url.pathname === "/api/v1/videos/job_installed_media/content") {
    response.writeHead(200, {
      "content-length": mediaBytes.byteLength,
      "content-type": "video/mp4",
    })
    response.end(mediaBytes)
    return
  }
  json(response, 404, { error: "not found" })
})

await new Promise((resolveListen, rejectListen) => {
  facade.once("error", rejectListen)
  facade.listen(0, "127.0.0.1", () => {
    facade.removeListener("error", rejectListen)
    resolveListen()
  })
})
const facadeAddress = facade.address()
if (facadeAddress === null || typeof facadeAddress === "string") throw new Error("The fake Facade did not bind TCP.")
const facadeOrigin = `http://127.0.0.1:${facadeAddress.port}`

const pluginEnv = {
  PATH: process.env.PATH ?? "",
  PIPPIT_BRIDGE_HOME: join(outputRoot, "state"),
  PIPPIT_FACADE_API_KEY: facadeApiKey,
  PIPPIT_FACADE_BASE_URL: facadeOrigin,
  PIPPIT_MCP_OUTPUT_ROOT: outputRoot,
}
const child = spawn(process.execPath, [entryPath], {
  env: pluginEnv,
  stdio: ["pipe", "pipe", "pipe"],
})
const lines = createInterface({ input: child.stdout, terminal: false })
const pending = new Map()
let stderr = ""
let nextId = 1
child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
lines.on("line", (line) => {
  const response = JSON.parse(line)
  const waiter = pending.get(response.id)
  if (waiter === undefined) return
  pending.delete(response.id)
  if (response.error) waiter.reject(new Error(response.error.message ?? "MCP request failed"))
  else waiter.resolve(response.result)
})

function rpc(method, params = {}) {
  const id = nextId++
  return new Promise((resolveRpc, rejectRpc) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectRpc(new Error(`${method} timed out`))
    }, 15_000)
    pending.set(id, {
      reject(error) {
        clearTimeout(timer)
        rejectRpc(error)
      },
      resolve(value) {
        clearTimeout(timer)
        resolveRpc(value)
      },
    })
    child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`)
  })
}

async function closeServer(server) {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error === undefined ? resolveClose() : rejectClose(error))
    server.closeAllConnections()
  })
}

async function readMediaResource(resourceUri, totalBytes) {
  const chunks = []
  const chunkBytes = 1024 * 1024
  for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
    const expectedBytes = Math.min(chunkBytes, totalBytes - offset)
    const uri = new URL(resourceUri)
    uri.searchParams.set("length", String(expectedBytes))
    uri.searchParams.set("offset", String(offset))
    const result = await rpc("resources/read", { uri: uri.toString() })
    const content = result?.contents?.[0]
    const metadata = content?._meta?.["pippit/chunk"]
    if (
      content?.uri !== uri.toString() ||
      content?.mimeType !== "video/mp4" ||
      metadata?.offset !== offset ||
      metadata?.bytes !== expectedBytes ||
      metadata?.total_bytes !== totalBytes ||
      metadata?.complete !== (offset + expectedBytes === totalBytes) ||
      typeof content?.blob !== "string"
    ) {
      throw new Error("The installed plugin returned an invalid local media resource chunk.")
    }
    const chunk = Buffer.from(content.blob, "base64")
    if (chunk.byteLength !== expectedBytes) throw new Error("The installed plugin truncated a media resource chunk.")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readMediaThroughFreshAppTool(resourceUri, totalBytes) {
  const fresh = spawn(process.execPath, [entryPath], {
    env: pluginEnv,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const freshLines = createInterface({ input: fresh.stdout, terminal: false })
  const freshPending = new Map()
  let freshNextId = 1
  let freshStderr = ""
  fresh.stderr.setEncoding("utf8").on("data", (chunk) => { freshStderr += chunk })
  freshLines.on("line", (line) => {
    const response = JSON.parse(line)
    const waiter = freshPending.get(response.id)
    if (waiter === undefined) return
    freshPending.delete(response.id)
    if (response.error) waiter.reject(new Error(response.error.message ?? "MCP request failed"))
    else waiter.resolve(response.result)
  })
  const freshRpc = (method, params = {}) => {
    const id = freshNextId++
    return new Promise((resolveRpc, rejectRpc) => {
      const timer = setTimeout(() => {
        freshPending.delete(id)
        rejectRpc(new Error(`${method} timed out in the fresh plugin process`))
      }, 15_000)
      freshPending.set(id, {
        reject(error) { clearTimeout(timer); rejectRpc(error) },
        resolve(value) { clearTimeout(timer); resolveRpc(value) },
      })
      fresh.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`)
    })
  }
  let restored
  try {
    await freshRpc("initialize", {
      capabilities: {},
      clientInfo: { name: "installed-media-session-restore", version: "1" },
      protocolVersion: "2025-11-25",
    })
    const tools = (await freshRpc("tools/list"))?.tools ?? []
    const chunkTool = tools.find((tool) => tool.name === "pippit_read_video_chunk")
    if (
      JSON.stringify(chunkTool?._meta?.ui?.visibility) !== JSON.stringify(["app"]) ||
      chunkTool?._meta?.["openai/widgetAccessible"] !== true
    ) {
      throw new Error("The fresh plugin process did not expose an app-only media reader.")
    }
    const chunks = []
    const chunkBytes = 1024 * 1024
    for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
      const expectedBytes = Math.min(chunkBytes, totalBytes - offset)
      const result = await freshRpc("tools/call", {
        arguments: { length: expectedBytes, offset, resource_uri: resourceUri },
        name: "pippit_read_video_chunk",
      })
      const content = result?.structuredContent
      if (
        result?.isError === true ||
        content?.resource_uri !== resourceUri ||
        content?.offset !== offset ||
        content?.bytes !== expectedBytes ||
        content?.total_bytes !== totalBytes ||
        content?.complete !== (offset + expectedBytes === totalBytes) ||
        content?.mime_type !== "video/mp4" ||
        typeof content?.blob !== "string"
      ) {
        throw new Error("The fresh plugin process returned an invalid app-only media chunk.")
      }
      chunks.push(Buffer.from(content.blob, "base64"))
    }
    restored = Buffer.concat(chunks)
  } finally {
    fresh.stdin.end()
    await Promise.race([
      once(fresh, "close"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("The fresh plugin process did not stop.")), 5_000)),
    ])
    freshLines.close()
  }
  if (freshStderr !== "") throw new Error("The fresh plugin process wrote unexpected stderr output.")
  return restored
}

let localPath
let resourceUri
try {
  const initialized = await rpc("initialize", {
    capabilities: {},
    clientInfo: { name: "installed-media-smoke", version: "1" },
    protocolVersion: "2025-11-25",
  })
  if (initialized?.serverInfo?.version !== "0.2.15") throw new Error("Unexpected installed plugin version.")
  const resource = await rpc("resources/read", { uri: "ui://widget/pippit-video-job-v13.html" })
  if (!resource?.contents?.[0]?.text?.includes("pippit-video-editor")) throw new Error("Missing v13 widget resource.")
  const result = await rpc("tools/call", {
    arguments: { job_id: "job_installed_media" },
    name: "pippit_get_video",
  })
  const preview = result?._meta?.["pippit/media"]?.[0]
  if (result?.isError === true || preview === undefined) throw new Error("The installed plugin did not return local media.")
  if (JSON.stringify(result).includes("local_path") || JSON.stringify(result).includes(outputRoot)) {
    throw new Error("The installed plugin exposed its local output path.")
  }
  const latestResult = await rpc("tools/call", {
    arguments: { anchor_job_id: "job_installed_media" },
    name: "pippit_resolve_latest_video",
  })
  const latestPreview = latestResult?._meta?.["pippit/media"]?.[0]
  if (
    latestResult?.isError === true ||
    latestResult?.structuredContent?.id !== "job_installed_media" ||
    latestPreview?.resource_uri !== preview.resource_uri
  ) {
    throw new Error("The installed plugin latest-video resolver did not return the current local artifact.")
  }
  if (!/^pippit-video-[a-f0-9]{64}\.mp4$/u.test(preview.filename)) {
    throw new Error("The installed plugin returned an invalid opaque media filename.")
  }
  localPath = join(outputRoot, preview.filename)
  resourceUri = preview.resource_uri
  if (!/^pippit-video:\/\/artifact\/[a-f0-9]{64}$/u.test(resourceUri) || preview.url !== undefined) {
    throw new Error("The installed plugin did not return a stable local MCP media resource.")
  }
  if (!isAbsolute(localPath) || !localPath.startsWith(`${outputRoot}/`)) {
    throw new Error("The installed plugin did not publish beneath its output root.")
  }
  const localStats = await lstat(localPath)
  if (!localStats.isFile() || localStats.size !== mediaBytes.byteLength) throw new Error("The local MP4 is incomplete.")
  const localDigest = createHash("sha256").update(await readFile(localPath)).digest("hex")
  if (localDigest !== mediaDigest) throw new Error("The local MP4 differs from the completed output.")
  const bridgedBytes = await readMediaResource(resourceUri, mediaBytes.byteLength)
  const bridgedDigest = createHash("sha256").update(bridgedBytes).digest("hex")
  if (bridgedDigest !== mediaDigest) throw new Error("The MCP resource bridge changed the completed output.")

  process.stdout.write(`${JSON.stringify({
    event: "preview_ready",
    facade_port: facadeAddress.port,
    local_file_verified: true,
    media_bytes: mediaBytes.byteLength,
    plugin_pid: child.pid,
    transport: "mcp-resource",
  })}\n`)

  child.stdin.end()
  await Promise.race([
    once(child, "close"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("The installed plugin did not stop at EOF.")), 5_000)),
  ])
  if (stderr !== "") throw new Error("The installed plugin wrote unexpected stderr output.")
  const retained = await lstat(localPath)
  if (!retained.isFile() || retained.size !== mediaBytes.byteLength) throw new Error("The local MP4 disappeared at plugin EOF.")
  const restoredBytes = await readMediaThroughFreshAppTool(resourceUri, mediaBytes.byteLength)
  const restoredDigest = createHash("sha256").update(restoredBytes).digest("hex")
  if (restoredDigest !== mediaDigest) throw new Error("The fresh plugin process changed the persisted MP4.")
  process.stdout.write(`${JSON.stringify({
    app_tool_transport: true,
    event: "complete",
    file_retained: true,
    resource_transport: true,
    session_restore: true,
  })}\n`)
} finally {
  lines.close()
  if (child.exitCode === null) child.kill("SIGTERM")
  await closeServer(facade).catch(() => undefined)
  await rm(outputRoot, { force: true, recursive: true })
}
