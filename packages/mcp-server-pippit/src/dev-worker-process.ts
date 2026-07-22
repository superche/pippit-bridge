import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import { DEV_WORKER_IPC_VERSION, DevGatewayError, type DevWorkerGeneration } from "./dev-supervisor.ts"
import type { DevWorkerRequest, DevWorkerResult, FrozenDevContract } from "./dev-gateway.ts"

interface JsonRpcReply {
  readonly error?: { readonly message?: string }
  readonly id?: number
  readonly result?: DevWorkerResult
}

export class ChildMcpWorkerGeneration implements DevWorkerGeneration<DevWorkerRequest, DevWorkerResult> {
  readonly ready = true
  readonly ipcVersion = DEV_WORKER_IPC_VERSION
  #child: ChildProcessWithoutNullStreams
  #nextId = 10
  #pending = new Map<number, { reject(error: Error): void; resolve(value: DevWorkerResult): void }>()
  #closed = false

  private constructor(
    readonly contractHash: string,
    readonly generationId: string,
    readonly implementationHash: string,
    readonly migrationEpoch: number,
    readonly storageBackwardCompatible: boolean,
    child: ChildProcessWithoutNullStreams,
  ) {
    this.#child = child
    child.stderr.resume()
    createInterface({ input: child.stdout }).on("line", line => {
      let reply: JsonRpcReply
      try { reply = JSON.parse(line) as JsonRpcReply } catch { return }
      if (typeof reply.id !== "number") return
      const pending = this.#pending.get(reply.id)
      if (!pending) return
      this.#pending.delete(reply.id)
      if (reply.error) pending.reject(new Error(reply.error.message ?? "Worker JSON-RPC error."))
      else pending.resolve(reply.result)
    })
    child.once("exit", () => {
      this.#closed = true
      for (const pending of this.#pending.values()) pending.reject(new DevGatewayError("DEV_SUPERVISOR_UNAVAILABLE", "The pinned worker generation exited."))
      this.#pending.clear()
    })
  }

  static async start(input: {
    readonly contractHash: string
    readonly entryPath: string
    readonly env?: NodeJS.ProcessEnv
    readonly generationId: string
    readonly implementationHash: string
    readonly migrationEpoch: number
    readonly storageBackwardCompatible: boolean
  }): Promise<{ readonly contract: FrozenDevContract; readonly worker: ChildMcpWorkerGeneration }> {
    const child = spawn(process.execPath, [input.entryPath], { env: input.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] })
    const worker = new ChildMcpWorkerGeneration(
      input.contractHash, input.generationId, input.implementationHash, input.migrationEpoch,
      input.storageBackwardCompatible, child,
    )
    try {
      await worker.#request("initialize", { capabilities: {}, clientInfo: { name: "pippit-dev-gateway", version: "1" }, protocolVersion: "2025-11-25" })
      const tools = await worker.#request("tools/list", {}) as { readonly tools?: FrozenDevContract["tools"] }
      const resources = await worker.#request("resources/list", {}) as FrozenDevContract["resources"]
      const resourceTemplates = await worker.#request("resources/templates/list", {}) as FrozenDevContract["resourceTemplates"]
      if (!Array.isArray(tools?.tools)) throw new DevGatewayError("DEV_WORKER_NOT_READY", "Candidate did not provide valid frozen tool discovery.")
      const listedResources = "resources" in resources && Array.isArray(resources.resources)
        ? resources.resources
        : []
      const staticResourceReads: Record<string, Readonly<Record<string, unknown>>> = {}
      for (const resource of listedResources) {
        if (typeof resource !== "object" || resource === null || !("uri" in resource) || typeof resource.uri !== "string") {
          throw new DevGatewayError("DEV_WORKER_NOT_READY", "Candidate provided invalid static resource discovery.")
        }
        const result = await worker.#request("resources/read", { uri: resource.uri })
        if (result === undefined || "content" in result) {
          throw new DevGatewayError("DEV_WORKER_NOT_READY", "Candidate static resource could not be frozen.")
        }
        staticResourceReads[resource.uri] = result
      }
      return { contract: { resourceTemplates, resources, staticResourceReads, tools: tools.tools }, worker }
    } catch (error) {
      await worker.close()
      throw error
    }
  }

  invoke(request: DevWorkerRequest, signal: AbortSignal): Promise<DevWorkerResult> {
    return this.#request(request.method, request.method === "tools/call"
      ? { arguments: request.argumentsValue, name: request.name }
      : { uri: request.uri }, signal)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#child.stdin.end()
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.#child.kill("SIGTERM"); resolve() }, 2_000)
      this.#child.once("exit", () => { clearTimeout(timer); resolve() })
    })
  }

  #request(method: string, params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<DevWorkerResult> {
    if (this.#closed) return Promise.reject(new DevGatewayError("DEV_SUPERVISOR_UNAVAILABLE", "Worker generation is closed."))
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(id)
        reject(new DevGatewayError("DEV_SUPERVISOR_UNAVAILABLE", "The pinned worker call was cancelled; it was not replayed."))
      }
      if (signal?.aborted) return abort()
      signal?.addEventListener("abort", abort, { once: true })
      this.#pending.set(id, {
        reject: error => { signal?.removeEventListener("abort", abort); reject(error) },
        resolve: value => { signal?.removeEventListener("abort", abort); resolve(value) },
      })
      this.#child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`)
    })
  }
}
