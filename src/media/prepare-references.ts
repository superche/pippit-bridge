import { z } from "zod"
import type { FrameImage, InputReference, VideoGenerationRequest } from "../openrouter/contracts.js"
import type { PippitApi, PippitMediaReference } from "../pippit/index.js"
import type { ReferenceKind, ReferenceLoader } from "./reference-loader.js"
import { ReferenceLoadError } from "./reference-loader.js"

interface ReferenceToUpload {
  readonly kind: ReferenceKind
  readonly url: string
}

export interface PreparedReferences {
  readonly assetIds: readonly string[]
  readonly audios: readonly PippitMediaReference[]
  readonly generateType?: 1
  readonly images: readonly PippitMediaReference[]
  readonly videos: readonly PippitMediaReference[]
}

export interface ReferenceWorkGate {
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>
}

export function createReferenceWorkGate(maxConcurrent: number): ReferenceWorkGate {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new ReferenceLoadError("INVALID_CONFIGURATION")
  }

  let active = 0
  const waiters: Array<{
    readonly reject: (error: ReferenceLoadError) => void
    readonly resolve: () => void
    readonly signal?: AbortSignal
  }> = []

  const release = (): void => {
    active -= 1
    while (waiters.length > 0) {
      const waiter = waiters.shift()
      if (!waiter || waiter.signal?.aborted) continue
      active += 1
      waiter.resolve()
      return
    }
  }

  const acquire = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(new ReferenceLoadError("ABORTED"))
    if (active < maxConcurrent) {
      active += 1
      return Promise.resolve()
    }

    return new Promise<void>((resolve, reject) => {
      let waiter: (typeof waiters)[number]
      const onAbort = (): void => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        reject(new ReferenceLoadError("ABORTED"))
      }
      waiter = {
        reject,
        resolve: () => {
          signal?.removeEventListener("abort", onAbort)
          resolve()
        },
        ...(signal === undefined ? {} : { signal }),
      }
      waiters.push(waiter)
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  return {
    async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      await acquire(signal)
      try {
        return await task()
      } finally {
        release()
      }
    },
  }
}

const pippitProviderOptionsSchema = z
  .object({
    byok_id: z.uuid().optional(),
    thread_id: z.string().trim().min(1).optional(),
  })
  .strict()

export interface PippitProviderOptions {
  readonly byok_id?: string
  readonly thread_id?: string
}

export function readPippitProviderOptions(request: VideoGenerationRequest): PippitProviderOptions {
  const value = request.provider?.options?.pippit
  if (value === undefined) return {}
  const parsed = pippitProviderOptionsSchema.parse(value)
  return {
    ...(parsed.byok_id === undefined ? {} : { byok_id: parsed.byok_id }),
    ...(parsed.thread_id === undefined ? {} : { thread_id: parsed.thread_id }),
  }
}

function urlFromInputReference(reference: InputReference): string {
  switch (reference.type) {
    case "image_url":
      return reference.image_url.url
    case "audio_url":
      return reference.audio_url.url
    case "video_url":
      return reference.video_url.url
  }
}

function kindFromInputReference(reference: InputReference): ReferenceKind {
  switch (reference.type) {
    case "image_url":
      return "image"
    case "audio_url":
      return "audio"
    case "video_url":
      return "video"
  }
}

function orderedFrames(frames: readonly FrameImage[]): readonly FrameImage[] {
  return [...frames].sort((left, right) => {
    const rank = { first_frame: 0, last_frame: 1 } as const
    return rank[left.frame_type] - rank[right.frame_type]
  })
}

function selectedReferences(request: VideoGenerationRequest): {
  readonly generateType?: 1
  readonly references: readonly ReferenceToUpload[]
} {
  if (request.frame_images && request.frame_images.length > 0) {
    return {
      generateType: 1,
      references: orderedFrames(request.frame_images).map((frame) => ({
        kind: "image" as const,
        url: frame.image_url.url,
      })),
    }
  }

  return {
    references:
      request.input_references?.map((reference) => ({
        kind: kindFromInputReference(reference),
        url: urlFromInputReference(reference),
      })) ?? [],
  }
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>,
  onFailure: () => void,
): Promise<readonly U[]> {
  const output: U[] = []
  let cursor = 0
  let hasFailure = false
  let failure: unknown

  async function worker(): Promise<void> {
    while (!hasFailure && cursor < values.length) {
      const index = cursor
      cursor += 1
      const value = values[index]
      if (value === undefined) continue
      try {
        output[index] = await mapper(value, index)
      } catch (error) {
        if (!hasFailure) {
          hasFailure = true
          failure = error
          onFailure()
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  if (hasFailure) throw failure
  return output
}

export async function prepareReferences(input: {
  readonly accessKey: string
  readonly concurrency: number
  readonly gate?: ReferenceWorkGate
  readonly loader: ReferenceLoader
  readonly maxTotalBytes?: number
  readonly maxTotalBytesByKind?: Partial<Readonly<Record<ReferenceKind, number>>>
  readonly pippit: PippitApi
  readonly request: VideoGenerationRequest
  readonly signal?: AbortSignal
}): Promise<PreparedReferences> {
  const selected = selectedReferences(input.request)
  const uploadCache = new Map<string, Promise<string>>()
  const failureController = new AbortController()
  const signal = input.signal
    ? AbortSignal.any([input.signal, failureController.signal])
    : failureController.signal
  let totalBytes = 0
  const totalBytesByKind: Record<ReferenceKind, number> = { audio: 0, image: 0, video: 0 }

  const uploaded = await mapWithConcurrency(selected.references, input.concurrency, async (reference) => {
    const cacheKey = `${reference.kind}\u0000${reference.url}`
    let assetId = uploadCache.get(cacheKey)
    if (!assetId) {
      const upload = async (): Promise<string> => {
        const file = await input.loader.load(reference.url, reference.kind, signal)
        totalBytes += file.bytes.byteLength
        totalBytesByKind[reference.kind] += file.bytes.byteLength
        if (input.maxTotalBytes !== undefined && totalBytes > input.maxTotalBytes) {
          throw new ReferenceLoadError("TOTAL_TOO_LARGE")
        }
        const kindLimit = input.maxTotalBytesByKind?.[reference.kind]
        if (kindLimit !== undefined && totalBytesByKind[reference.kind] > kindLimit) {
          throw new ReferenceLoadError("TOTAL_TOO_LARGE")
        }
        const uploadedFile = await input.pippit.uploadFile({
          accessKey: input.accessKey,
          file,
          signal,
        })
        return uploadedFile.assetId
      }
      assetId = input.gate ? input.gate.run(upload, signal) : upload()
      uploadCache.set(cacheKey, assetId)
    }
    return { assetId: await assetId, kind: reference.kind }
  }, () => failureController.abort())

  const images: PippitMediaReference[] = []
  const videos: PippitMediaReference[] = []
  const audios: PippitMediaReference[] = []

  for (const reference of uploaded) {
    const item = { pippit_asset_id: reference.assetId }
    if (reference.kind === "image") images.push(item)
    if (reference.kind === "video") videos.push(item)
    if (reference.kind === "audio") audios.push(item)
  }

  return {
    assetIds: uploaded.map((reference) => reference.assetId),
    audios,
    ...(selected.generateType === undefined ? {} : { generateType: selected.generateType }),
    images,
    videos,
  }
}
