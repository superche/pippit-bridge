import {
  UnknownVideoModelError,
  resolveVideoModel,
  type PublicHttpFetcher,
  type ReferenceKind,
  type ReferenceLoader,
  type VideoModelDefinition,
} from "@pippit-bridge/core"
import {
  PIPPIT_DEFAULT_TIMEOUT_MS,
  type PippitApi,
  type PippitFailReason,
  type PippitMediaReference,
  type PippitRunState,
  type PippitVideoResult,
} from "@pippit-bridge/sdk"
import { downloadPippitVideos, loadPippitReference } from "./media.js"

export type PippitVideoStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled"

export interface PippitReferenceInput {
  readonly kind: ReferenceKind
  readonly source: string
}

export interface GenerateVideoInput {
  readonly accessKey: string
  readonly afterSubmit?: (result: PippitToolResult) => Promise<void>
  readonly aspectRatio?: string
  readonly duration?: number
  readonly firstFrame?: string
  readonly lastFrame?: string
  readonly maxWaitSeconds?: number
  readonly model?: string
  readonly outputDirectory?: string
  readonly prompt: string
  readonly references?: readonly PippitReferenceInput[]
  readonly resolution?: string
  readonly rootDirectory: string
  readonly seed?: number
  readonly signal?: AbortSignal
  readonly waitForCompletion?: boolean
  readonly beforeSubmit?: () => Promise<void>
}

export interface GetVideoInput {
  readonly accessKey: string
  readonly download?: boolean
  readonly maxWaitSeconds?: number
  readonly outputDirectory?: string
  readonly rootDirectory: string
  readonly runId: string
  readonly signal?: AbortSignal
  readonly threadId: string
  readonly waitForCompletion?: boolean
}

export interface PippitToolResult {
  readonly failure?: string
  readonly files?: readonly string[]
  readonly model?: string
  readonly runId: string
  readonly status: PippitVideoStatus
  readonly threadId: string
  readonly videoUrls?: readonly string[]
  readonly webThreadLink?: string
}

export interface PippitVideoServiceOptions {
  readonly defaultOutputDirectory: string
  readonly outputFetcher: PublicHttpFetcher
  readonly pippit: PippitApi
  readonly pollIntervalMs: number
  readonly requestTimeoutMs?: number
  readonly remoteLoader: ReferenceLoader
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

interface PreparedReferences {
  readonly assetIds: readonly string[]
  readonly audios: readonly PippitMediaReference[]
  readonly generateType?: 1
  readonly images: readonly PippitMediaReference[]
  readonly videos: readonly PippitMediaReference[]
}

const DEFAULT_MODEL = "pippit/seedance-2.0"
const DEFAULT_DURATION = 5
export const PIPPIT_MAX_WAIT_SECONDS = PIPPIT_DEFAULT_TIMEOUT_MS / 1_000
const DEFAULT_MAX_WAIT_SECONDS = PIPPIT_MAX_WAIT_SECONDS
const MAX_TOTAL_REFERENCE_BYTES = 300 * 1024 * 1024
const MAX_AUDIO_REFERENCE_BYTES = 15 * 1024 * 1024

function statusFromRunState(state: PippitRunState): PippitVideoStatus {
  switch (state) {
    case 1:
      return "pending"
    case 2:
    case 7:
      return "in_progress"
    case 3:
      return "completed"
    case 5:
      return "cancelled"
    case 0:
    case 4:
    case 6:
    case 8:
    case 9:
      return "failed"
  }
}

function safeFailure(reason: PippitFailReason | undefined, accessKey: string): string | undefined {
  if (reason === undefined) return undefined
  const message =
    typeof reason === "string"
      ? reason
      : reason.message ?? reason.fallback_message ?? reason.detail ?? "Pippit video generation failed."
  return message.split(accessKey).join("[REDACTED]").slice(0, 2_000)
}

function validateModel(input: GenerateVideoInput): VideoModelDefinition {
  let model: VideoModelDefinition
  try {
    model = resolveVideoModel(input.model ?? DEFAULT_MODEL)
  } catch (error) {
    if (error instanceof UnknownVideoModelError) throw new Error(error.message)
    throw error
  }
  if (input.aspectRatio !== undefined && !model.supported_aspect_ratios?.includes(input.aspectRatio)) {
    throw new Error(`Model ${model.id} does not support aspect ratio ${input.aspectRatio}.`)
  }
  if (input.resolution !== undefined && !model.supported_resolutions?.includes(input.resolution)) {
    throw new Error(`Model ${model.id} does not support resolution ${input.resolution}.`)
  }
  if (input.duration !== undefined && model.supported_durations !== null && !model.supported_durations.includes(input.duration)) {
    throw new Error(`Model ${model.id} does not support duration ${input.duration}.`)
  }
  if (input.firstFrame !== undefined && model.supported_frame_images !== null && !model.supported_frame_images.includes("first_frame")) {
    throw new Error(`Model ${model.id} does not support a first frame.`)
  }
  if (input.lastFrame !== undefined && model.supported_frame_images !== null && !model.supported_frame_images.includes("last_frame")) {
    throw new Error(`Model ${model.id} does not support a last frame.`)
  }
  if (input.seed !== undefined && model.seed === false) {
    throw new Error(`Model ${model.id} does not support a seed.`)
  }
  return model
}

function positiveInteger(value: number | undefined, fallback: number, name: string, maximum: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`)
  }
  return result
}

function validateGenerateInput(input: GenerateVideoInput): void {
  const prompt = input.prompt.trim()
  if (prompt.length < 1 || prompt.length > 20_000) {
    throw new Error("Pippit video prompts must contain 1 to 20,000 characters.")
  }
  positiveInteger(input.duration, DEFAULT_DURATION, "duration", 3_600)
  positiveInteger(input.maxWaitSeconds, DEFAULT_MAX_WAIT_SECONDS, "max_wait_seconds", PIPPIT_MAX_WAIT_SECONDS)
  if (
    input.seed !== undefined &&
    (!Number.isSafeInteger(input.seed) || input.seed < -1 || input.seed > 4_294_967_295)
  ) {
    throw new Error("seed must be an integer from -1 to 4294967295.")
  }

  if (input.firstFrame === undefined && input.lastFrame === undefined) {
    const references = input.references ?? []
    if (references.length > 15) throw new Error("Pippit accepts at most 15 input references.")
    const videoCount = references.filter((reference) => reference.kind === "video").length
    const audioCount = references.filter((reference) => reference.kind === "audio").length
    const visualCount = references.filter((reference) => reference.kind !== "audio").length
    if (visualCount > 9) throw new Error("Pippit accepts at most 9 combined image/video references.")
    if (videoCount > 3) throw new Error("Pippit accepts at most 3 video references.")
    if (audioCount > 3) throw new Error("Pippit accepts at most 3 audio references.")
  }
}

function selectedReferences(input: GenerateVideoInput): {
  readonly generateType?: 1
  readonly references: readonly PippitReferenceInput[]
} {
  const frames: PippitReferenceInput[] = []
  if (input.firstFrame !== undefined) frames.push({ kind: "image", source: input.firstFrame })
  if (input.lastFrame !== undefined) frames.push({ kind: "image", source: input.lastFrame })
  return frames.length > 0 ? { generateType: 1, references: frames } : { references: input.references ?? [] }
}

async function prepareReferences(
  input: GenerateVideoInput,
  pippit: PippitApi,
  remoteLoader: ReferenceLoader,
): Promise<PreparedReferences> {
  const selected = selectedReferences(input)
  const cache = new Map<string, Promise<string>>()
  const uploaded: Array<{ readonly assetId: string; readonly kind: ReferenceKind }> = []
  let totalBytes = 0
  let audioBytes = 0

  for (const reference of selected.references) {
    const cacheKey = `${reference.kind}\u0000${reference.source}`
    let upload = cache.get(cacheKey)
    if (upload === undefined) {
      upload = (async () => {
        const file = await loadPippitReference({
          kind: reference.kind,
          remoteLoader,
          rootDirectory: input.rootDirectory,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          source: reference.source,
        })
        totalBytes += file.bytes.byteLength
        if (reference.kind === "audio") audioBytes += file.bytes.byteLength
        if (totalBytes > MAX_TOTAL_REFERENCE_BYTES || audioBytes > MAX_AUDIO_REFERENCE_BYTES) {
          throw new Error("The combined Pippit references exceed the supported byte limit.")
        }
        const result = await pippit.uploadFile({
          accessKey: input.accessKey,
          file,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
        return result.assetId
      })()
      cache.set(cacheKey, upload)
    }
    uploaded.push({ assetId: await upload, kind: reference.kind })
  }

  const images: PippitMediaReference[] = []
  const videos: PippitMediaReference[] = []
  const audios: PippitMediaReference[] = []
  for (const reference of uploaded) {
    const media = { pippit_asset_id: reference.assetId }
    if (reference.kind === "image") images.push(media)
    if (reference.kind === "video") videos.push(media)
    if (reference.kind === "audio") audios.push(media)
  }
  return {
    assetIds: uploaded.map((reference) => reference.assetId),
    audios,
    ...(selected.generateType === undefined ? {} : { generateType: selected.generateType }),
    images,
    videos,
  }
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Pippit polling was cancelled."))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(new Error("Pippit polling was cancelled."))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function deadlineSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): {
  readonly cleanup: () => void
  readonly signal: AbortSignal
  readonly timedOut: () => boolean
} {
  const controller = new AbortController()
  let expired = false
  const onCallerAbort = (): void => controller.abort()
  if (callerSignal?.aborted) controller.abort()
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true })
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, Math.max(1, timeoutMs))
  return {
    cleanup() {
      clearTimeout(timer)
      callerSignal?.removeEventListener("abort", onCallerAbort)
    },
    signal: controller.signal,
    timedOut: () => expired,
  }
}

export class PippitVideoService {
  private readonly defaultOutputDirectory: string
  private readonly outputFetcher: PublicHttpFetcher
  private readonly pippit: PippitApi
  private readonly pollIntervalMs: number
  private readonly requestTimeoutMs: number
  private readonly remoteLoader: ReferenceLoader
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>

  constructor(options: PippitVideoServiceOptions) {
    this.defaultOutputDirectory = options.defaultOutputDirectory
    this.outputFetcher = options.outputFetcher
    this.pippit = options.pippit
    this.pollIntervalMs = options.pollIntervalMs
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs,
      PIPPIT_DEFAULT_TIMEOUT_MS,
      "request_timeout_ms",
      PIPPIT_DEFAULT_TIMEOUT_MS,
    )
    this.remoteLoader = options.remoteLoader
    this.sleep = options.sleep ?? defaultSleep
  }

  async generate(input: GenerateVideoInput): Promise<PippitToolResult> {
    validateGenerateInput(input)
    const model = validateModel(input)
    const references = await prepareReferences(input, this.pippit, this.remoteLoader)
    await input.beforeSubmit?.()
    const submitted = await this.pippit.submitRun({
      accessKey: input.accessKey,
      request: {
        asset_ids: [...references.assetIds],
        message: input.prompt.trim(),
        video_part_tool_param: {
          ...(references.audios.length === 0 ? {} : { audios: [...references.audios] }),
          duration_sec: input.duration ?? DEFAULT_DURATION,
          ...(references.generateType === undefined ? {} : { generate_type: references.generateType }),
          ...(references.images.length === 0 ? {} : { images: [...references.images] }),
          model: model.upstreamModel,
          prompt: input.prompt.trim(),
          ...(input.aspectRatio === undefined ? {} : { ratio: input.aspectRatio }),
          ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
          ...(input.seed === undefined ? {} : { seed: input.seed }),
          ...(references.videos.length === 0 ? {} : { videos: [...references.videos] }),
        },
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const base: PippitToolResult = {
      model: model.id,
      runId: submitted.run.runId,
      status: statusFromRunState(submitted.run.state),
      threadId: submitted.run.threadId,
      ...(submitted.webThreadLink === undefined ? {} : { webThreadLink: submitted.webThreadLink }),
    }
    await input.afterSubmit?.(base)
    if (input.waitForCompletion === false) return base
    return this.get({
      accessKey: input.accessKey,
      download: true,
      ...(input.maxWaitSeconds === undefined ? {} : { maxWaitSeconds: input.maxWaitSeconds }),
      ...(input.outputDirectory === undefined ? {} : { outputDirectory: input.outputDirectory }),
      rootDirectory: input.rootDirectory,
      runId: submitted.run.runId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      threadId: submitted.run.threadId,
      waitForCompletion: true,
    }).then((result) => ({ ...result, model: model.id, ...(base.webThreadLink ? { webThreadLink: base.webThreadLink } : {}) }))
  }

  async get(input: GetVideoInput): Promise<PippitToolResult> {
    const maxWaitSeconds = positiveInteger(
      input.maxWaitSeconds,
      DEFAULT_MAX_WAIT_SECONDS,
      "max_wait_seconds",
      PIPPIT_MAX_WAIT_SECONDS,
    )
    const deadline = Date.now() + maxWaitSeconds * 1_000
    let result: PippitVideoResult
    let lastStatus: PippitVideoStatus = "pending"
    while (true) {
      const shouldWait = input.waitForCompletion !== false
      const remainingMs = deadline - Date.now()
      if (shouldWait && remainingMs <= 0) {
        return { runId: input.runId, status: lastStatus, threadId: input.threadId }
      }
      const boundedSignal = shouldWait ? deadlineSignal(input.signal, remainingMs) : undefined
      const querySignal = boundedSignal?.signal ?? input.signal
      try {
        result = await this.pippit.queryVideoResult({
          accessKey: input.accessKey,
          runId: input.runId,
          ...(querySignal === undefined ? {} : { signal: querySignal }),
          threadId: input.threadId,
        })
      } catch (error) {
        if (boundedSignal?.timedOut()) {
          return { runId: input.runId, status: lastStatus, threadId: input.threadId }
        }
        throw error
      } finally {
        boundedSignal?.cleanup()
      }
      const status = statusFromRunState(result.runState)
      lastStatus = status
      if (status !== "pending" && status !== "in_progress") break
      if (!shouldWait || Date.now() >= deadline) {
        return { runId: input.runId, status, threadId: input.threadId }
      }
      const sleepMs = Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now()))
      if (sleepMs <= 0) return { runId: input.runId, status, threadId: input.threadId }
      await this.sleep(sleepMs, input.signal)
      if (Date.now() >= deadline) return { runId: input.runId, status, threadId: input.threadId }
    }

    const status = statusFromRunState(result.runState)
    if (status !== "completed") {
      const failure = safeFailure(result.failReason, input.accessKey)
      return {
        ...(failure === undefined ? {} : { failure }),
        runId: input.runId,
        status,
        threadId: input.threadId,
      }
    }
    if (result.videoUrls.length === 0) {
      throw new Error("Pippit completed the run without returning a video URL.")
    }
    if (input.download === false) {
      return {
        runId: input.runId,
        status,
        threadId: input.threadId,
        videoUrls: result.videoUrls,
      }
    }
    const files = await downloadPippitVideos({
      fetcher: this.outputFetcher,
      outputDirectory: input.outputDirectory ?? this.defaultOutputDirectory,
      rootDirectory: input.rootDirectory,
      runId: input.runId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: this.requestTimeoutMs,
      urls: result.videoUrls,
    })
    return { files, runId: input.runId, status, threadId: input.threadId }
  }
}
