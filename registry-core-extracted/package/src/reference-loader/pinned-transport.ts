import { request as httpRequest, type IncomingHttpHeaders } from "node:http"
import { request as httpsRequest } from "node:https"
import { type LookupFunction } from "node:net"
import { Readable } from "node:stream"
import { type PublicHttpFetchOptions, type ReferenceLookupAddress } from "./contracts.js"

function toRequestHeaders(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries())
}

function toResponseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const item of value) result.append(name, item)
    else if (value !== undefined) result.set(name, value)
  }
  return result
}

export function fetchWithPinnedNodeTransport(
  url: URL,
  target: ReferenceLookupAddress | undefined,
  options: PublicHttpFetchOptions,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const requestFactory = url.protocol === "https:" ? httpsRequest : httpRequest
    const pinnedLookup: LookupFunction | undefined = target === undefined
      ? undefined
      : (_hostname, lookupOptions, callback) => {
          const family = target.family === 6 ? 6 : 4
          if (lookupOptions.all) callback(null, [{ address: target.address, family }])
          else callback(null, target.address, family)
        }
    const request = requestFactory(url, {
      headers: toRequestHeaders(options.headers), lookup: pinnedLookup, method: "GET", signal: options.signal,
    }, incoming => {
      const status = incoming.statusCode ?? 502
      const bodyless = status === 101 || status === 204 || status === 205 || status === 304
      const body = bodyless ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>)
      try {
        resolve(new Response(body, {
          headers: toResponseHeaders(incoming.headers), status,
          ...(incoming.statusMessage === undefined ? {} : { statusText: incoming.statusMessage }),
        }))
      } catch (error) {
        incoming.destroy()
        reject(error)
      }
    })
    request.once("error", reject)
    request.end()
  })
}
