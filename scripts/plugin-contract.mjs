import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import { spawn } from "node:child_process"

export const CONTRACT_FORMAT_VERSION = 1
const root = resolve(import.meta.dirname, "..")
const packageRoot = resolve(root, "packages/mcp-server-pippit")
const generatedRoot = resolve(packageRoot, "contracts/generated")

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== "object") return typeof value === "string" ? value.replaceAll("\r\n", "\n") : value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
}

function stable(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`
}

function digest(value) {
  return createHash("sha256").update(stable(value)).digest("hex")
}

function contractEnvironment(runtimeRoot) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("PIPPIT_")),
  )
  return {
    ...environment,
    PIPPIT_BRIDGE_HOME: runtimeRoot,
    PIPPIT_MCP_ENROLLMENT_PORT: "0",
    PIPPIT_MCP_OUTPUT_ROOT: resolve(runtimeRoot, "output"),
  }
}

function githubError(message) {
  if (process.env.GITHUB_ACTIONS !== "true") return
  const escaped = message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")
  process.stdout.write(`::error title=Plugin contract check::${escaped}\n`)
}

async function discover() {
  const runtimeRoot = await mkdtemp(resolve(tmpdir(), "pippit-contract-"))
  const child = spawn(process.execPath, [resolve(packageRoot, "plugin-entry.mjs")], {
    cwd: packageRoot,
    env: contractEnvironment(runtimeRoot),
    stdio: ["pipe", "pipe", "pipe"],
  })
  let childStderr = ""
  child.stderr.on("data", chunk => { childStderr += chunk.toString() })
  const childExit = new Promise(resolveExit => {
    let settled = false
    const settle = result => {
      if (settled) return
      settled = true
      resolveExit(result)
    }
    child.once("error", error => settle({ error }))
    child.once("exit", (code, signal) => settle({ code, signal }))
  })
  const pending = new Map()
  createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line)
    pending.get(message.id)?.(message)
  })
  let id = 0
  const request = (method, params = {}) => new Promise((resolveRequest, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => {
      const detail = childStderr.trim()
      reject(new Error(`MCP discovery timed out: ${method}${detail === "" ? "" : `: ${detail}`}`))
    }, 15_000)
    pending.set(requestId, message => {
      clearTimeout(timer)
      pending.delete(requestId)
      if (message.error) reject(new Error(`${method}: ${message.error.message}`))
      else resolveRequest(message.result)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`)
  })
  let discovery
  let cleanupFailure
  try {
    const initialize = await request("initialize", { capabilities: {}, clientInfo: { name: "contract-generator", version: "1" }, protocolVersion: "2025-11-25" })
    const tools = await request("tools/list")
    const resources = await request("resources/list")
    const templates = await request("resources/templates/list")
    const reads = []
    for (const resource of [...(resources.resources ?? [])].sort((a, b) => a.uri.localeCompare(b.uri))) {
      reads.push({ result: await request("resources/read", { uri: resource.uri }), uri: resource.uri })
    }
    discovery = { initialize, reads, resources, templates, tools }
  } finally {
    child.stdin.end()
    const timeout = Symbol("child-exit-timeout")
    let exit = await Promise.race([
      childExit,
      new Promise(resolveTimeout => setTimeout(() => resolveTimeout(timeout), 2_000)),
    ])
    if (exit === timeout) {
      child.kill("SIGTERM")
      exit = await childExit
    }
    if (exit.error !== undefined) cleanupFailure = exit.error
    else if (exit.code !== 0) {
      const detail = childStderr.trim()
      cleanupFailure = new Error(`MCP discovery process exited with ${exit.signal ?? exit.code}${detail === "" ? "" : `: ${detail}`}`)
    }
    await rm(runtimeRoot, { force: true, recursive: true })
  }
  if (cleanupFailure !== undefined) throw cleanupFailure
  return discovery
}

async function collect() {
  const discovery = await discover()
  const plugin = JSON.parse(await readFile(resolve(packageRoot, ".codex-plugin/plugin.json"), "utf8"))
  const mcp = JSON.parse(await readFile(resolve(packageRoot, ".mcp.json"), "utf8"))
  const skill = await readFile(resolve(packageRoot, "skills/pippit-video/SKILL.md"), "utf8")
  const semantics = JSON.parse(await readFile(resolve(packageRoot, "contracts/result-semantics.json"), "utf8"))
  const mcpGolden = {
    formatVersion: CONTRACT_FORMAT_VERSION,
    initialize: discovery.initialize,
    reads: discovery.reads.map(read => ({ sha256: digest(read.result), uri: read.uri })),
    resources: { sha256: digest(discovery.resources), uris: (discovery.resources.resources ?? []).map(resource => resource.uri).sort() },
    resultSemantics: semantics,
    templates: { sha256: digest(discovery.templates), uriTemplates: (discovery.templates.resourceTemplates ?? []).map(template => template.uriTemplate).sort() },
    tools: { names: (discovery.tools.tools ?? []).map(tool => tool.name).sort(), sha256: digest(discovery.tools) },
  }
  const hostGolden = { formatVersion: CONTRACT_FORMAT_VERSION, mcp, plugin }
  const skillGolden = { formatVersion: CONTRACT_FORMAT_VERSION, skills: [{ path: "skills/pippit-video/SKILL.md", sha256: createHash("sha256").update(skill.replaceAll("\r\n", "\n")).digest("hex") }] }
  return {
    files: {
      "mcp-discovery.golden.json": stable(mcpGolden),
      "plugin-host.golden.json": stable(hostGolden),
      "skill-digests.golden.json": stable(skillGolden),
    },
    hashes: { mcpContractHash: digest(mcpGolden), pluginContractHash: digest({ hostGolden, mcpContractHash: digest(mcpGolden), skillGolden }) },
  }
}

const mode = process.argv[2] ?? "check"
let collected
try {
  collected = await collect()
} catch (error) {
  const message = `PLUGIN_CONTRACT_CHECK_FAILED ${error instanceof Error ? error.message : String(error)}`
  githubError(message)
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
if (mode === "print") {
  process.stdout.write(JSON.stringify(collected))
  process.exit(0)
}
const drift = []
for (const [name, contents] of Object.entries(collected.files)) {
  const path = resolve(generatedRoot, name)
  if (mode === "generate") await writeFile(path, contents)
  else {
    const committed = await readFile(path, "utf8").then(JSON.parse).catch(() => undefined)
    const committedContents = committed === undefined ? undefined : stable(committed)
    if (committedContents !== contents) {
      drift.push({
        actual: createHash("sha256").update(contents).digest("hex"),
        expected: committedContents === undefined
          ? "missing"
          : createHash("sha256").update(committedContents).digest("hex"),
        name,
      })
    }
  }
}
if (drift.length > 0) {
  const details = drift.map(({ actual, expected, name }) => `${name}[expected=${expected},actual=${actual}]`).join(",")
  const message = `PLUGIN_CONTRACT_DRIFT ${details} requires-release-and-new-task`
  githubError(message)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
} else process.stdout.write(`${JSON.stringify(collected.hashes)}\n`)
