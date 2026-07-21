import { timingSafeEqual } from "node:crypto"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export const PIPPIT_DEV_WIDGET_RESOURCE_URI = "ui://pippit-video/dev-shell-v1.html"
export const PIPPIT_DEV_WIDGET_MIME = "text/html+skybridge"

export interface WidgetBehaviorFixture {
  readonly confirmation: "none" | "required"
  readonly input: Readonly<Record<string, unknown>>
  readonly toolName: string
}

export function assertWidgetBehaviorCompatible(
  previous: readonly WidgetBehaviorFixture[],
  candidate: readonly WidgetBehaviorFixture[],
): void {
  if (JSON.stringify(previous) !== JSON.stringify(candidate)) {
    throw new Error("DEV_CONTRACT_MISMATCH Widget tool payload or confirmation boundary changed.")
  }
}

export function authorizeDevWidgetRequest(input: {
  readonly capability: string | undefined
  readonly expectedCapability: string
  readonly expectedHost: string
  readonly host: string | undefined
  readonly origin: string | undefined
}): boolean {
  if (input.host !== input.expectedHost || input.origin !== `http://${input.expectedHost}`) return false
  if (input.capability === undefined) return false
  const actual = Buffer.from(input.capability)
  const expected = Buffer.from(input.expectedCapability)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function renderDevWidgetShell(input: { readonly assetOrigin: string; readonly capability: string }): string {
  const origin = JSON.stringify(input.assetOrigin)
  const capability = JSON.stringify(input.capability)
  return `<!doctype html><meta charset="utf-8"><div id="pippit-widget-root"></div><script type="module">
const origin=${origin};const capability=${capability};
const load=()=>import(origin+"/widget.js?capability="+encodeURIComponent(capability));
load();const events=new EventSource(origin+"/hmr?capability="+encodeURIComponent(capability));
events.addEventListener("asset",()=>load());
</script>`
}

export interface DevWidgetAssetServer {
  readonly origin: string
  close(): Promise<void>
  publish(): void
}

function deny(response: ServerResponse): void {
  response.writeHead(403, { "cache-control": "no-store", "content-type": "text/plain" })
  response.end("Forbidden")
}

export async function createDevWidgetAssetServer(input: {
  readonly capability: string
  readonly readAsset: () => Promise<string>
  readonly port?: number
}): Promise<DevWidgetAssetServer> {
  const streams = new Set<ServerResponse>()
  let expectedHost = ""
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "invalid"}`)
    if (!authorizeDevWidgetRequest({
      capability: url.searchParams.get("capability") ?? undefined,
      expectedCapability: input.capability,
      expectedHost,
      host: request.headers.host,
      origin: request.headers.origin,
    })) return deny(response)
    if (request.method !== "GET") return deny(response)
    if (url.pathname === "/widget.js") {
      const asset = await input.readAsset()
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(asset),
        "content-type": "text/javascript; charset=utf-8",
        "x-content-type-options": "nosniff",
      })
      response.end(asset)
      return
    }
    if (url.pathname === "/hmr") {
      response.writeHead(200, {
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
        "content-type": "text/event-stream",
        "x-accel-buffering": "no",
      })
      response.write(": ready\n\n")
      streams.add(response)
      request.once("close", () => streams.delete(response))
      return
    }
    response.writeHead(404, { "cache-control": "no-store" })
    response.end()
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject)
    server.listen(input.port ?? 43119, "127.0.0.1", () => resolveListen())
  })
  const address = server.address() as AddressInfo
  expectedHost = `127.0.0.1:${address.port}`
  return {
    async close() {
      for (const stream of streams) stream.end()
      streams.clear()
      await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
    },
    origin: `http://${expectedHost}`,
    publish() {
      for (const stream of streams) stream.write("event: asset\ndata: reload\n\n")
    },
  }
}
