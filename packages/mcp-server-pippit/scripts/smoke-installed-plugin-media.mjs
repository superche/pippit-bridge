import { spawn, execFile } from "node:child_process"
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

const child = spawn(process.execPath, [entryPath], {
  env: {
    PATH: process.env.PATH ?? "",
    PIPPIT_FACADE_API_KEY: facadeApiKey,
    PIPPIT_FACADE_BASE_URL: facadeOrigin,
    PIPPIT_MCP_OUTPUT_ROOT: outputRoot,
  },
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

function execFileAsync(command, args) {
  return new Promise((resolveExec, rejectExec) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout) => {
      if (error) rejectExec(error)
      else resolveExec(stdout)
    })
  })
}

async function closeServer(server) {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error === undefined ? resolveClose() : rejectClose(error))
    server.closeAllConnections()
  })
}

let localPath
let previewUrl
try {
  const initialized = await rpc("initialize", {
    capabilities: {},
    clientInfo: { name: "installed-media-smoke", version: "1" },
    protocolVersion: "2025-11-25",
  })
  if (initialized?.serverInfo?.version !== "0.2.6") throw new Error("Unexpected installed plugin version.")
  const resource = await rpc("resources/read", { uri: "ui://widget/pippit-video-job-v7.html" })
  if (!resource?.contents?.[0]?.text?.includes("pippit-video-editor")) throw new Error("Missing v7 widget resource.")
  const result = await rpc("tools/call", {
    arguments: { job_id: "job_installed_media" },
    name: "pippit_get_video",
  })
  const preview = result?._meta?.["pippit/media"]?.[0]
  if (result?.isError === true || preview === undefined) throw new Error("The installed plugin did not return local media.")
  localPath = preview.local_path
  previewUrl = preview.url
  const parsedPreview = new URL(previewUrl)
  if (parsedPreview.hostname !== "127.0.0.1" || Number(parsedPreview.port) === facadeAddress.port) {
    throw new Error("The preview is not owned by a distinct plugin loopback listener.")
  }
  if (!isAbsolute(localPath) || !localPath.startsWith(`${outputRoot}/`)) {
    throw new Error("The installed plugin did not publish beneath its output root.")
  }
  const localStats = await lstat(localPath)
  if (!localStats.isFile() || localStats.size !== mediaBytes.byteLength) throw new Error("The local MP4 is incomplete.")
  const localDigest = createHash("sha256").update(await readFile(localPath)).digest("hex")
  if (localDigest !== mediaDigest) throw new Error("The local MP4 differs from the completed output.")

  const previewPort = Number(parsedPreview.port)
  if (process.platform === "darwin") {
    const listeners = await execFileAsync("/usr/sbin/lsof", [
      "-nP",
      "-a",
      "-p",
      String(child.pid),
      `-iTCP:${previewPort}`,
      "-sTCP:LISTEN",
    ])
    if (!listeners.includes(String(child.pid))) throw new Error("The plugin process does not own the preview listener.")
  }

  const preflight = await fetch(previewUrl, {
    headers: {
      "access-control-request-headers": "range",
      "access-control-request-method": "GET",
      "access-control-request-private-network": "true",
      origin: "https://chatgpt.com",
    },
    method: "OPTIONS",
  })
  if (preflight.status !== 204 || preflight.headers.get("access-control-allow-private-network") !== "true") {
    throw new Error("The installed plugin did not authorize Private Network Access.")
  }
  const head = await fetch(previewUrl, { method: "HEAD" })
  if (head.status !== 200 || head.headers.get("content-length") !== String(mediaBytes.byteLength)) {
    throw new Error("The installed plugin did not serve a complete local HEAD response.")
  }
  const ranged = await fetch(previewUrl, { headers: { range: "bytes=0-31" } })
  if (ranged.status !== 206 || (await ranged.arrayBuffer()).byteLength !== Math.min(32, mediaBytes.byteLength)) {
    throw new Error("The installed plugin did not serve a local byte range.")
  }

  process.stdout.write(`${JSON.stringify({
    event: "preview_ready",
    facade_port: facadeAddress.port,
    local_path: localPath,
    media_bytes: mediaBytes.byteLength,
    plugin_pid: child.pid,
    preview_port: previewPort,
    preview_url: previewUrl,
  })}\n`)
  if (process.stdin.isTTY) {
    process.stdout.write("Press Enter after browser playback validation.\n")
    await once(process.stdin, "data")
    process.stdin.pause()
  }

  child.stdin.end()
  await Promise.race([
    once(child, "close"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("The installed plugin did not stop at EOF.")), 5_000)),
  ])
  if (stderr !== "") throw new Error("The installed plugin wrote unexpected stderr output.")
  await expectFetchFailure(previewUrl)
  const retained = await lstat(localPath)
  if (!retained.isFile() || retained.size !== mediaBytes.byteLength) throw new Error("The local MP4 disappeared at plugin EOF.")
  process.stdout.write(`${JSON.stringify({ event: "complete", file_retained: true, listener_closed: true })}\n`)
} finally {
  lines.close()
  if (child.exitCode === null) child.kill("SIGTERM")
  await closeServer(facade).catch(() => undefined)
  await rm(outputRoot, { force: true, recursive: true })
}

async function expectFetchFailure(url) {
  try {
    await fetch(url)
  } catch {
    return
  }
  throw new Error("The plugin preview listener remained reachable after stdin EOF.")
}
