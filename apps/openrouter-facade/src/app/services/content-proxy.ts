import { Readable, Transform } from "node:stream"
import type { PublicHttpFetcher } from "@pippit-bridge/core"
import type { AppConfig } from "../../config.js"
import { ApiError } from "../../errors.js"
import { pippitStateToOpenRouterStatus } from "../../openrouter/video-mapping.js"
import type { QueriedJob } from "./job-query.js"

export interface ContentProxyResponse {
  readonly body: Readable
  readonly headers: Readonly<Record<string, string>>
  readonly statusCode: number
}

function withIdleTimeout(input: {
  readonly onCleanup: () => void
  readonly onIdle: () => void
  readonly source: Readable
  readonly timeoutMs: number
}): Readable {
  let cleaned = false
  let idleTimer: NodeJS.Timeout | undefined
  const clearIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = undefined
  }
  let output: Transform
  const resetIdleTimer = (): void => {
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      const error = new Error("The generated video stream exceeded its idle timeout.")
      input.onIdle()
      input.source.destroy(error)
      output.destroy(error)
    }, input.timeoutMs)
    idleTimer.unref()
  }
  const onSourceError = (error: Error): void => {
    output.destroy(error)
  }
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    clearIdleTimer()
    if (!input.source.destroyed) input.source.destroy()
    input.onCleanup()
  }

  output = new Transform({
    transform(chunk, _encoding, callback) {
      resetIdleTimer()
      callback(null, chunk)
    },
  })
  input.source.once("error", onSourceError)
  input.source.once("close", () => input.source.removeListener("error", onSourceError))
  output.once("close", cleanup)
  output.once("end", cleanup)
  output.once("error", cleanup)
  resetIdleTimer()
  input.source.pipe(output)
  return output
}

function resolveVideoUrl(queried: QueriedJob, index: number): URL {
  const status = pippitStateToOpenRouterStatus(queried.result.runState)
  if (status !== "completed") {
    throw new ApiError(`Video content is not available while the job is ${status}.`, {
      code: "video_not_ready",
      param: "job_id",
      statusCode: 400,
      type: "invalid_request_error",
    })
  }
  const videoUrl = queried.result.videoUrls[index]
  if (!videoUrl) {
    throw new ApiError(`Video output index ${index} does not exist.`, {
      code: "video_output_not_found",
      param: "index",
      statusCode: 404,
      type: "not_found_error",
    })
  }
  let parsed: URL
  try {
    parsed = new URL(videoUrl)
  } catch {
    throw new ApiError("Pippit returned an invalid video content URL.", {
      code: "invalid_upstream_response",
      statusCode: 502,
      type: "upstream_error",
    })
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw new ApiError("Pippit returned an unsupported video content URL.", {
      code: "invalid_upstream_response",
      statusCode: 502,
      type: "upstream_error",
    })
  }
  return parsed
}

export function createContentProxyService(input: {
  readonly config: Pick<AppConfig, "CONTENT_STREAM_IDLE_TIMEOUT_MS" | "PIPPIT_REQUEST_TIMEOUT_MS">
  readonly fetcher: PublicHttpFetcher
}): (request: {
  readonly index: number
  readonly onCleanup: () => void
  readonly queried: QueriedJob
  readonly range?: string
  readonly signal: AbortSignal
}) => Promise<ContentProxyResponse> {
  return async request => {
    const parsedVideoUrl = resolveVideoUrl(request.queried, request.index)
    const downloadHeaders = new Headers()
    if (request.range !== undefined) downloadHeaders.set("range", request.range)
    const headerTimeoutController = new AbortController()
    const idleController = new AbortController()
    const headerTimer = setTimeout(
      () => headerTimeoutController.abort(),
      input.config.PIPPIT_REQUEST_TIMEOUT_MS,
    )
    const downloadSignal = AbortSignal.any([
      request.signal,
      headerTimeoutController.signal,
      idleController.signal,
    ])
    let response: Response
    try {
      response = (await input.fetcher.fetch(parsedVideoUrl, {
        headers: downloadHeaders,
        signal: downloadSignal,
      })).response
      clearTimeout(headerTimer)
    } catch {
      clearTimeout(headerTimer)
      request.onCleanup()
      if (headerTimeoutController.signal.aborted) {
        throw new ApiError("Downloading the generated video from Pippit timed out.", {
          code: "upstream_download_timeout",
          statusCode: 504,
          type: "upstream_error",
        })
      }
      if (request.signal.aborted) {
        throw new ApiError("The downstream request was cancelled.", {
          code: "request_cancelled",
          statusCode: 408,
          type: "api_error",
        })
      }
      throw new ApiError("The generated video could not be downloaded from Pippit.", {
        code: "upstream_download_failed",
        statusCode: 502,
        type: "upstream_error",
      })
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      request.onCleanup()
      throw new ApiError("The generated video could not be downloaded from Pippit.", {
        code: "upstream_download_failed",
        metadata: { upstream_status: response.status },
        statusCode: 502,
        type: "upstream_error",
      })
    }

    const upstreamContentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    if (upstreamContentType !== undefined &&
      upstreamContentType !== "application/octet-stream" &&
      !upstreamContentType.startsWith("video/")) {
      await response.body.cancel().catch(() => undefined)
      request.onCleanup()
      throw new ApiError("Pippit returned a non-video content type for the generated result.", {
        code: "invalid_upstream_response",
        statusCode: 502,
        type: "upstream_error",
      })
    }
    const headers: Record<string, string> = {
      "content-type": upstreamContentType?.startsWith("video/") ? upstreamContentType : "video/mp4",
      "x-content-type-options": "nosniff",
    }
    for (const name of ["content-length", "content-range", "accept-ranges"] as const) {
      const value = response.headers.get(name)
      if (value !== null) headers[name] = value
    }
    const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>)
    return {
      body: withIdleTimeout({
        onCleanup: request.onCleanup,
        onIdle: () => idleController.abort(),
        source,
        timeoutMs: input.config.CONTENT_STREAM_IDLE_TIMEOUT_MS,
      }),
      headers,
      statusCode: response.status,
    }
  }
}
