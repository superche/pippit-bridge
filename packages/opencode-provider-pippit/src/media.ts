import { mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve, sep, win32 } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import {
  inspectReferenceBytes,
  type LoadedReference,
  type PublicHttpFetcher,
  type ReferenceKind,
  type ReferenceLoader,
} from "@pippit-bridge/core"

const MAX_REFERENCE_BYTES: Readonly<Record<ReferenceKind, number>> = {
  audio: 15 * 1024 * 1024,
  image: 30 * 1024 * 1024,
  video: 200 * 1024 * 1024,
}
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024
const DEFAULT_OUTPUT_TIMEOUT_MS = 120_000

function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
}

function parseRemoteUrl(source: string): URL | undefined {
  if (isAbsolute(source) || win32.isAbsolute(source)) return undefined
  let url: URL
  try {
    url = new URL(source)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Pippit references must use a worktree file path or an HTTP(S) URL.")
  }
  return url
}

async function loadLocalReference(
  source: string,
  kind: ReferenceKind,
  rootDirectory: string,
): Promise<LoadedReference> {
  const root = await realpath(rootDirectory)
  const candidate = resolve(root, source)
  const path = await realpath(candidate).catch(() => {
    throw new Error("A local Pippit reference does not exist.")
  })
  if (!isInside(root, path)) {
    throw new Error("Local Pippit references must stay inside the OpenCode worktree.")
  }
  const info = await stat(path)
  if (!info.isFile()) throw new Error("A local Pippit reference is not a regular file.")
  if (info.size > MAX_REFERENCE_BYTES[kind]) {
    throw new Error(`The local ${kind} reference exceeds the supported byte limit.`)
  }
  const bytes = new Uint8Array(await readFile(path))
  return inspectReferenceBytes({ bytes, filename: basename(path), kind })
}

export async function loadPippitReference(input: {
  readonly kind: ReferenceKind
  readonly remoteLoader: ReferenceLoader
  readonly rootDirectory: string
  readonly signal?: AbortSignal
  readonly source: string
}): Promise<LoadedReference> {
  const source = input.source.trim()
  if (source === "") throw new Error("Pippit reference sources cannot be empty.")
  const remote = parseRemoteUrl(source)
  return remote === undefined
    ? loadLocalReference(source, input.kind, input.rootDirectory)
    : input.remoteLoader.load(remote.toString(), input.kind, input.signal)
}

function outputExtension(contentType: string | undefined): string {
  if (contentType === "video/quicktime") return ".mov"
  if (contentType === "video/webm") return ".webm"
  return ".mp4"
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

async function createUniqueOutputFile(
  outputDirectory: string,
  runId: string,
  index: number,
  extension: string,
) {
  const stem = `${safeRunId(runId)}-${index + 1}`
  for (let collision = 0; collision < 1_000; collision += 1) {
    const suffix = collision === 0 ? "" : `-${collision + 1}`
    const outputPath = resolve(outputDirectory, `${stem}${suffix}${extension}`)
    try {
      return { outputFile: await open(outputPath, "wx", 0o600), outputPath }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
  }
  throw new Error("Pippit could not allocate a collision-safe output filename.")
}

function safeRunId(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/gu, "-").slice(0, 80)
  return safe || "pippit-video"
}

function validateOutputDirectory(value: string): void {
  if (
    value.trim() === "" ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.split(/[\\/]+/u).includes("..")
  ) {
    throw new Error("The Pippit output directory must stay inside the OpenCode worktree.")
  }
}

function byteLimitStream(maxBytes: number): Transform {
  let bytes = 0
  return new Transform({
    transform(chunk, _encoding, callback) {
      bytes += Buffer.byteLength(chunk)
      callback(bytes > maxBytes ? new Error("A generated Pippit video exceeds the download limit.") : null, chunk)
    },
  })
}

function runWithDeadline<T>(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const controller = new AbortController()
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      callerSignal?.removeEventListener("abort", onCallerAbort)
    }
    const reject = (error: Error): void => {
      if (settled) return
      settled = true
      controller.abort()
      cleanup()
      rejectPromise(error)
    }
    const onCallerAbort = (): void => reject(new Error("Pippit output download was cancelled."))
    const timer = setTimeout(() => reject(new Error("Pippit output download timed out.")), timeoutMs)

    if (callerSignal?.aborted) {
      onCallerAbort()
      return
    }
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true })
    task(controller.signal).then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolvePromise(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        rejectPromise(error)
      },
    )
  })
}

async function downloadOne(input: {
  readonly fetcher: PublicHttpFetcher
  readonly index: number
  readonly outputDirectory: string
  readonly runId: string
  readonly signal: AbortSignal
  readonly url: string
}): Promise<string> {
  const { response } = await input.fetcher.fetch(
    input.url,
    { signal: input.signal },
  )
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error("A generated Pippit video could not be downloaded.")
  }
  const declaredLength = response.headers.get("content-length")
  if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > MAX_OUTPUT_BYTES) {
    await response.body.cancel().catch(() => undefined)
    throw new Error("A generated Pippit video exceeds the download limit.")
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== undefined && contentType !== "application/octet-stream" && !contentType.startsWith("video/")) {
    await response.body.cancel().catch(() => undefined)
    throw new Error("Pippit returned a generated output that is not a video.")
  }

  const { outputFile, outputPath } = await createUniqueOutputFile(
    input.outputDirectory,
    input.runId,
    input.index,
    outputExtension(contentType),
  ).catch(async (error: unknown) => {
    await response.body?.cancel().catch(() => undefined)
    throw error
  })
  try {
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
      byteLimitStream(MAX_OUTPUT_BYTES),
      outputFile.createWriteStream(),
      { signal: input.signal },
    )
    return outputPath
  } catch (error) {
    await outputFile.close().catch(() => undefined)
    await unlink(outputPath).catch(() => undefined)
    throw error
  }
}

export async function downloadPippitVideos(input: {
  readonly fetcher: PublicHttpFetcher
  readonly outputDirectory: string
  readonly rootDirectory: string
  readonly runId: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly urls: readonly string[]
}): Promise<readonly string[]> {
  validateOutputDirectory(input.outputDirectory)
  const root = await realpath(input.rootDirectory)
  const outputDirectory = resolve(root, input.outputDirectory)
  if (!isInside(root, outputDirectory)) {
    throw new Error("The Pippit output directory must stay inside the OpenCode worktree.")
  }
  await mkdir(outputDirectory, { mode: 0o700, recursive: true })
  const realOutputDirectory = await realpath(outputDirectory)
  if (!isInside(root, realOutputDirectory)) {
    throw new Error("The Pippit output directory resolves outside the OpenCode worktree.")
  }

  const files: string[] = []
  const timeoutMs = input.timeoutMs ?? DEFAULT_OUTPUT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("The Pippit output timeout must be a positive integer.")
  }
  try {
    for (const [index, url] of input.urls.entries()) {
      files.push(
        await runWithDeadline(timeoutMs, input.signal, (signal) =>
          downloadOne({
            fetcher: input.fetcher,
            index,
            outputDirectory: realOutputDirectory,
            runId: input.runId,
            signal,
            url,
          }),
        ),
      )
    }
    return files
  } catch (error) {
    await Promise.all(files.map((file) => unlink(file).catch(() => undefined)))
    throw error
  }
}
