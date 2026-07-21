import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { createInterface } from "node:readline"

const root = resolve(import.meta.dirname, "..")
const devHome = await mkdtemp(resolve(tmpdir(), "pippit-dev-gateway-smoke-"))

function exec(command, args, options = {}) {
  return new Promise((resolveExec, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? root, env: options.env ?? process.env, stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", code => code === 0 ? resolveExec() : reject(new Error(`${command} exited ${code}`)))
  })
}

try {
  const environment = { ...process.env, PIPPIT_BRIDGE_DEV_HOME: devHome }
  await exec(process.execPath, [resolve(root, "scripts/codex-dev.mjs"), "bootstrap"], { env: environment })
  const pointerPath = resolve(devHome, "pointer.json")
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"))
  const frozenContract = JSON.parse(await readFile(pointer.frozenContractPath, "utf8"))
  if (pointer.runtimeRoot !== resolve(devHome, "runtime")) throw new Error("Dev runtime data is not physically isolated.")
  const marketplace = JSON.parse(await readFile(resolve(devHome, ".agents/plugins/marketplace.json"), "utf8"))
  if (marketplace.name !== "pippit-bridge-dev" || marketplace.plugins?.[0]?.source?.path !== "./gateway-bundle") {
    throw new Error("Dev bootstrap did not produce an installable isolated marketplace.")
  }
  const bundle = pointer.gatewayBundle
  const child = spawn("/bin/sh", ["./dev-plugin-entry.sh"], {
    cwd: bundle,
    env: { ...environment, PIPPIT_DEV_POINTER: pointerPath },
    stdio: ["pipe", "pipe", "pipe"],
  })
  child.stderr.on("data", chunk => process.stderr.write(chunk))
  const pending = new Map()
  createInterface({ input: child.stdout }).on("line", line => {
    const response = JSON.parse(line)
    pending.get(response.id)?.(response)
  })
  let nextId = 0
  const request = (method, params = {}) => new Promise((resolveRequest, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => reject(new Error(`Dev gateway timed out: ${method}`)), 15_000)
    pending.set(id, response => {
      clearTimeout(timer)
      pending.delete(id)
      if (response.error) reject(new Error(`${method}: ${response.error.message}`))
      else resolveRequest(response.result)
    })
    child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`)
  })
  try {
    const initialized = await request("initialize", { capabilities: {}, clientInfo: { name: "dev-smoke", version: "1" }, protocolVersion: "2025-11-25" })
    const tools = await request("tools/list")
    const resources = await request("resources/list")
    const templates = await request("resources/templates/list")
    for (const resource of resources.resources) await request("resources/read", { uri: resource.uri })
    const previewTool = tools.tools.find(tool => tool.name === "pippit_dev_preview_error_widget")
    const frozenTools = tools.tools.filter(tool => tool.name !== "pippit_dev_preview_error_widget")
    const previewResult = await request("tools/call", { arguments: {}, name: "pippit_dev_preview_error_widget" })
    if (
      initialized.serverInfo.version !== "0.2.16"
      || JSON.stringify(frozenTools) !== JSON.stringify(frozenContract.tools)
      || tools.tools.length !== frozenContract.tools.length + 1
      || previewTool?._meta?.["openai/outputTemplate"] !== "ui://widget/pippit-video-job-v14.html"
      || previewResult.isError === true
      || previewResult.structuredContent?.pippit_dev_preview !== "error"
      || resources.resources.length !== 2
      || templates.resourceTemplates.length !== 2
    ) {
      throw new Error("Dev gateway discovery did not match the frozen contract.")
    }
    process.stdout.write(`${JSON.stringify({ gatewayPid: child.pid, previewTool: previewTool.name, productionTools: frozenTools.length, resources: resources.resources.length, templates: templates.resourceTemplates.length, tools: tools.tools.length, version: initialized.serverInfo.version })}\n`)
  } finally {
    child.stdin.end()
    if (child.exitCode === null) await new Promise(resolveExit => child.once("exit", resolveExit))
  }
} finally {
  await rm(devHome, { force: true, recursive: true })
}
