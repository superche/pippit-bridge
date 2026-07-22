import { createInterface } from "node:readline"
import type { JsonRpcResponse, PippitMcpMessageHandler } from "../protocol.ts"
import type { PippitToolRuntime } from "../tools.ts"

function parseFailure(): JsonRpcResponse {
  return { error: { code: -32700, message: "Invalid JSON." }, id: null, jsonrpc: "2.0" }
}

function internalFailure(message: unknown): JsonRpcResponse {
  let id: number | string | null = null
  if (typeof message === "object" && message !== null && !Array.isArray(message)) {
    const candidate = (message as Record<string, unknown>).id
    if (typeof candidate === "string" || (typeof candidate === "number" && Number.isFinite(candidate))) id = candidate
  }
  return { error: { code: -32603, message: "Internal error." }, id, jsonrpc: "2.0" }
}

export async function serveJsonRpcLines(input: {
  readonly handler: PippitMcpMessageHandler
  readonly readable: NodeJS.ReadableStream
  readonly runtime: PippitToolRuntime
  readonly writable: NodeJS.WritableStream
}): Promise<void> {
  const lines = createInterface({ crlfDelay: Infinity, input: input.readable, terminal: false })
  let closePromise: Promise<void> | undefined
  const closeRuntime = (): Promise<void> => {
    closePromise ??= input.runtime.close?.() ?? Promise.resolve()
    return closePromise
  }
  const closeAtEof = (): void => { void closeRuntime().catch(() => undefined) }
  input.readable.once("end", closeAtEof)
  try {
    for await (const line of lines) {
      let response: JsonRpcResponse | undefined
      let message: unknown
      try {
        message = JSON.parse(line) as unknown
      } catch {
        response = parseFailure()
      }
      if (response === undefined) {
        try {
          response = await input.handler.handle(message)
        } catch {
          response = internalFailure(message)
        }
      }
      if (response !== undefined) input.writable.write(`${JSON.stringify(response)}\n`)
    }
  } finally {
    input.readable.removeListener("end", closeAtEof)
    lines.close()
    await closeRuntime()
  }
}
