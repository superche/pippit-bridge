import { isAbsolute, win32 } from "node:path"
import { PIPPIT_DEFAULT_IMAGE_MODEL, PIPPIT_DEFAULT_VIDEO_MODEL } from "@pippit-bridge/core"
import {
  addAccessKeyToolInputContract,
  deleteAccessKeyToolInputContract,
  downloadVideoToolInputContract,
  editVideoToolInputContract,
  emptyToolInputContract,
  generateImageToolInputContract,
  generateVideoToolInputContract,
  getVideoToolInputContract,
  switchAccessKeyToolInputContract,
  type RuntimeContract,
} from "@pippit-bridge/contracts"
import type {
  PippitAddAccessKeyToolInput,
  PippitDeleteAccessKeyToolInput,
  PippitDownloadVideoToolInput,
  PippitEditVideoSegmentToolInput,
  PippitGenerateImageToolInput,
  PippitGenerateVideoToolInput,
  PippitGetVideoToolInput,
  PippitSwitchAccessKeyToolInput,
} from "../contracts.ts"

export class ToolInputError extends Error {}

function assertRuntimeContract(contract: RuntimeContract<unknown>, value: unknown): void {
  try {
    contract.parse(value)
  } catch {
    throw new ToolInputError("Tool arguments do not match the published input contract.")
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(record).find(key => !allowedSet.has(key))
  if (unknown !== undefined) throw new ToolInputError(`${name} contains unsupported field ${unknown}.`)
}

function nonEmptyString(value: unknown, name: string, maximum = 8_192): string {
  if (typeof value !== "string") throw new ToolInputError(`${name} must be a string.`)
  const normalized = value.trim()
  let hasControl = false
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) hasControl = true
  }
  if (normalized === "" || normalized.length > maximum || hasControl) {
    throw new ToolInputError(`${name} must be a non-empty printable string of at most ${maximum} characters.`)
  }
  return normalized
}

function optionalInteger(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ToolInputError(`${name} must be an integer from ${minimum} to ${maximum}.`)
  }
  return Number(value)
}

function httpUrl(value: unknown, name: string): string {
  if (typeof value !== "string") throw new ToolInputError(`${name} must be an HTTP(S) URL.`)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ToolInputError(`${name} must be an HTTP(S) URL.`)
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "") {
    throw new ToolInputError(`${name} must be an HTTP(S) URL without embedded credentials.`)
  }
  return parsed.toString()
}

function urlValue(value: unknown, name: string): { readonly url: string } {
  if (!isRecord(value)) throw new ToolInputError(`${name} must be an object.`)
  assertExactKeys(value, ["url"], name)
  return { url: httpUrl(value.url, `${name}.url`) }
}

function parseInputReferences(value: unknown): PippitGenerateVideoToolInput["input_references"] {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 15) {
    throw new ToolInputError("input_references must contain at most 15 entries.")
  }
  const parsed: NonNullable<PippitGenerateVideoToolInput["input_references"]>[number][] = []
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) throw new ToolInputError(`input_references[${index}] must be an object.`)
    if (item.type === "image_url") {
      assertExactKeys(item, ["type", "image_url"], `input_references[${index}]`)
      parsed.push({ image_url: urlValue(item.image_url, `input_references[${index}].image_url`), type: "image_url" })
    } else if (item.type === "video_url") {
      assertExactKeys(item, ["type", "video_url"], `input_references[${index}]`)
      parsed.push({ type: "video_url", video_url: urlValue(item.video_url, `input_references[${index}].video_url`) })
    } else if (item.type === "audio_url") {
      assertExactKeys(item, ["type", "audio_url"], `input_references[${index}]`)
      parsed.push({ audio_url: urlValue(item.audio_url, `input_references[${index}].audio_url`), type: "audio_url" })
    } else {
      throw new ToolInputError(`input_references[${index}].type is unsupported.`)
    }
  }
  const videos = parsed.filter(item => item.type === "video_url").length
  const audios = parsed.filter(item => item.type === "audio_url").length
  const visuals = parsed.length - audios
  if (visuals > 9) throw new ToolInputError("input_references supports at most 9 combined image/video references.")
  if (videos > 3) throw new ToolInputError("input_references supports at most 3 video references.")
  if (audios > 3) throw new ToolInputError("input_references supports at most 3 audio references.")
  return parsed
}

function parseFrameImages(value: unknown): PippitGenerateVideoToolInput["frame_images"] {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 2) throw new ToolInputError("frame_images must contain at most 2 entries.")
  const parsed: NonNullable<PippitGenerateVideoToolInput["frame_images"]>[number][] = []
  const frameTypes = new Set<string>()
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) throw new ToolInputError(`frame_images[${index}] must be an object.`)
    assertExactKeys(item, ["type", "image_url", "frame_type"], `frame_images[${index}]`)
    if (item.type !== "image_url" || (item.frame_type !== "first_frame" && item.frame_type !== "last_frame")) {
      throw new ToolInputError(`frame_images[${index}] must be a first_frame or last_frame image_url.`)
    }
    if (frameTypes.has(item.frame_type)) throw new ToolInputError(`frame_images contains duplicate ${item.frame_type}.`)
    frameTypes.add(item.frame_type)
    parsed.push({
      frame_type: item.frame_type,
      image_url: urlValue(item.image_url, `frame_images[${index}].image_url`),
      type: "image_url",
    })
  }
  return parsed
}

export function parseEmptyToolInput(value: unknown): void {
  try {
    emptyToolInputContract.parse(value ?? {})
  } catch {
    throw new ToolInputError("Tool arguments must be an object with no additional properties.")
  }
}

export function parseGenerateInput(value: unknown): PippitGenerateVideoToolInput {
  assertRuntimeContract(generateVideoToolInputContract, value)
  if (!isRecord(value)) throw new ToolInputError("Tool arguments must be an object.")
  assertExactKeys(value, ["aspect_ratio", "byok_id", "duration", "frame_images", "idempotency_key", "input_references", "model", "prompt", "resolution", "seed", "thread_id"], "arguments")
  const frameImages = parseFrameImages(value.frame_images)
  const inputReferences = parseInputReferences(value.input_references)
  if ((frameImages?.length ?? 0) > 0 && (inputReferences?.length ?? 0) > 0) {
    throw new ToolInputError("frame_images cannot be combined with input_references.")
  }
  const model = value.model === undefined ? PIPPIT_DEFAULT_VIDEO_MODEL : nonEmptyString(value.model, "model", 256)
  return {
    ...(value.aspect_ratio === undefined ? {} : { aspect_ratio: nonEmptyString(value.aspect_ratio, "aspect_ratio", 64) }),
    ...(value.byok_id === undefined ? {} : { byok_id: nonEmptyString(value.byok_id, "byok_id", 256) }),
    ...(value.duration === undefined ? {} : { duration: optionalInteger(value.duration, "duration", 1, 3_600) as number }),
    ...(frameImages === undefined ? {} : { frame_images: frameImages }),
    ...(value.idempotency_key === undefined ? {} : { idempotency_key: nonEmptyString(value.idempotency_key, "idempotency_key", 200) }),
    ...(inputReferences === undefined ? {} : { input_references: inputReferences }),
    model,
    prompt: nonEmptyString(value.prompt, "prompt", 20_000),
    ...(value.resolution === undefined ? {} : { resolution: nonEmptyString(value.resolution, "resolution", 64) }),
    ...(value.seed === undefined ? {} : { seed: optionalInteger(value.seed, "seed", -1, 4_294_967_295) as number }),
    ...(value.thread_id === undefined ? {} : { thread_id: nonEmptyString(value.thread_id, "thread_id", 8_192) }),
  }
}

export function parseGenerateImageInput(value: unknown): PippitGenerateImageToolInput {
  assertRuntimeContract(generateImageToolInputContract, value)
  if (!isRecord(value)) throw new ToolInputError("Tool arguments must be an object.")
  assertExactKeys(value, ["byok_id", "images", "model", "n", "prompt", "resolution", "thread_id"], "arguments")
  const model = value.model === undefined ? PIPPIT_DEFAULT_IMAGE_MODEL : nonEmptyString(value.model, "model", 256)
  if (model !== "pippit/seedream-5.0" && model !== "pippit/seedream-5.0-pro") {
    throw new ToolInputError("model must be pippit/seedream-5.0 or pippit/seedream-5.0-pro.")
  }
  const references = parseInputReferences(value.images)
  if (references !== undefined && (references.length > 9 || references.some(item => item.type !== "image_url"))) {
    throw new ToolInputError("images must contain at most 9 image_url references.")
  }
  const resolution = value.resolution === undefined ? undefined : nonEmptyString(value.resolution, "resolution", 2)
  if (resolution !== undefined && resolution !== "1K" && resolution !== "2K" && resolution !== "4K") {
    throw new ToolInputError("resolution must be 1K, 2K, or 4K.")
  }
  if (model === "pippit/seedream-5.0" && resolution !== undefined) {
    throw new ToolInputError("resolution must be omitted for pippit/seedream-5.0.")
  }
  return {
    ...(value.byok_id === undefined ? {} : { byok_id: nonEmptyString(value.byok_id, "byok_id", 256) }),
    ...(references === undefined ? {} : { images: references as readonly NonNullable<PippitGenerateImageToolInput["images"]>[number][] }),
    model,
    n: optionalInteger(value.n, "n", 1, 10) ?? 1,
    prompt: nonEmptyString(value.prompt, "prompt", 20_000),
    ...(resolution === undefined ? {} : { resolution }),
    ...(value.thread_id === undefined ? {} : { thread_id: nonEmptyString(value.thread_id, "thread_id", 8_192) }),
  }
}

function finiteNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ToolInputError(`${name} must be a finite number from ${minimum} to ${maximum}.`)
  }
  return value
}

export function parseEditInput(value: unknown): PippitEditVideoSegmentToolInput {
  assertRuntimeContract(editVideoToolInputContract, value)
  if (!isRecord(value)) throw new ToolInputError("Tool arguments must be an object.")
  assertExactKeys(value, ["annotations", "byok_id", "idempotency_key", "model", "prompt", "resolution", "seed", "segment", "source_index", "source_job_id", "thread_id"], "arguments")
  if (!isRecord(value.segment)) throw new ToolInputError("segment must be an object.")
  assertExactKeys(value.segment, ["start_ms", "end_ms"], "segment")
  const startMs = optionalInteger(value.segment.start_ms, "segment.start_ms", 0, Number.MAX_SAFE_INTEGER)
  const endMs = optionalInteger(value.segment.end_ms, "segment.end_ms", 1, Number.MAX_SAFE_INTEGER)
  if (startMs === undefined || endMs === undefined || endMs <= startMs) {
    throw new ToolInputError("segment.end_ms must be greater than segment.start_ms.")
  }
  if (endMs - startMs > 30_000) throw new ToolInputError("segment must be at most 30000 milliseconds.")
  if (!Array.isArray(value.annotations) || value.annotations.length > 20) {
    throw new ToolInputError("annotations must contain at most 20 entries.")
  }
  const annotations: PippitEditVideoSegmentToolInput["annotations"][number][] = []
  for (const [index, annotationValue] of value.annotations.entries()) {
    const name = `annotations[${index}]`
    if (!isRecord(annotationValue)) throw new ToolInputError(`${name} must be an object.`)
    assertExactKeys(annotationValue, ["at_ms", "region", "instruction"], name)
    const atMs = optionalInteger(annotationValue.at_ms, `${name}.at_ms`, 0, Number.MAX_SAFE_INTEGER)
    if (atMs === undefined || atMs < startMs || atMs > endMs) {
      throw new ToolInputError(`${name}.at_ms must fall within segment.`)
    }
    if (!isRecord(annotationValue.region)) throw new ToolInputError(`${name}.region must be an object.`)
    assertExactKeys(annotationValue.region, ["x", "y", "width", "height"], `${name}.region`)
    const x = finiteNumber(annotationValue.region.x, `${name}.region.x`, 0, 1)
    const y = finiteNumber(annotationValue.region.y, `${name}.region.y`, 0, 1)
    const width = finiteNumber(annotationValue.region.width, `${name}.region.width`, 0, 1)
    const height = finiteNumber(annotationValue.region.height, `${name}.region.height`, 0, 1)
    if (width === 0 || height === 0 || x + width > 1 || y + height > 1) {
      throw new ToolInputError(`${name}.region must be a non-empty normalized rectangle within the video.`)
    }
    annotations.push({
      at_ms: atMs,
      instruction: nonEmptyString(annotationValue.instruction, `${name}.instruction`, 2_000),
      region: { height, width, x, y },
    })
  }
  const prompt = value.prompt === undefined ? undefined : nonEmptyString(value.prompt, "prompt", 20_000)
  if (prompt === undefined && annotations.length === 0) throw new ToolInputError("Provide prompt or at least one annotation.")
  return {
    annotations,
    ...(value.byok_id === undefined ? {} : { byok_id: nonEmptyString(value.byok_id, "byok_id", 256) }),
    ...(value.idempotency_key === undefined ? {} : { idempotency_key: nonEmptyString(value.idempotency_key, "idempotency_key", 200) }),
    model: value.model === undefined ? PIPPIT_DEFAULT_VIDEO_MODEL : nonEmptyString(value.model, "model", 256),
    ...(prompt === undefined ? {} : { prompt }),
    ...(value.resolution === undefined ? {} : { resolution: nonEmptyString(value.resolution, "resolution", 64) }),
    ...(value.seed === undefined ? {} : { seed: optionalInteger(value.seed, "seed", -1, 4_294_967_295) as number }),
    segment: { end_ms: endMs, start_ms: startMs },
    source_index: optionalInteger(value.source_index, "source_index", 0, 1_000) ?? 0,
    source_job_id: nonEmptyString(value.source_job_id, "source_job_id"),
    ...(value.thread_id === undefined ? {} : { thread_id: nonEmptyString(value.thread_id, "thread_id", 8_192) }),
  }
}

export function parseAddAccessKeyInput(value: unknown): PippitAddAccessKeyToolInput {
  assertRuntimeContract(addAccessKeyToolInputContract, value)
  if (!isRecord(value)) throw new ToolInputError("Tool arguments must be an object.")
  assertExactKeys(value, ["account_name"], "arguments")
  return { account_name: nonEmptyString(value.account_name, "account_name", 128) }
}

export function parseSwitchAccessKeyInput(value: unknown): PippitSwitchAccessKeyToolInput {
  assertRuntimeContract(switchAccessKeyToolInputContract, value)
  if (!isRecord(value)) throw new ToolInputError("Tool arguments must be an object.")
  assertExactKeys(value, ["credential_id"], "arguments")
  return { credential_id: nonEmptyString(value.credential_id, "credential_id") }
}

export function parseDeleteAccessKeyInput(value: unknown): PippitDeleteAccessKeyToolInput {
  assertRuntimeContract(deleteAccessKeyToolInputContract, value)
  if (!isRecord(value)) throw new ToolInputError("Tool arguments must be an object.")
  assertExactKeys(value, ["credential_id", "confirm"], "arguments")
  if (value.confirm !== true) throw new ToolInputError("confirm must be true to delete an Access Key.")
  return { confirm: true, credential_id: nonEmptyString(value.credential_id, "credential_id") }
}

export function parseGetInput(value: unknown): PippitGetVideoToolInput {
  assertRuntimeContract(getVideoToolInputContract, value)
  if (!isRecord(value)) throw new ToolInputError("Tool arguments must be an object.")
  assertExactKeys(value, ["job_id"], "arguments")
  return { job_id: nonEmptyString(value.job_id, "job_id") }
}

function safeRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0") || value.length > 4_096) {
    throw new ToolInputError("output_path must be a non-empty relative path.")
  }
  if (isAbsolute(value) || win32.isAbsolute(value)) {
    throw new ToolInputError("output_path must stay beneath PIPPIT_MCP_OUTPUT_ROOT.")
  }
  const segments = value.split(/[\\/]+/u)
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
    throw new ToolInputError("output_path must not contain empty, current-directory, or parent-directory segments.")
  }
  return segments.join("/")
}

export function parseDownloadInput(value: unknown): PippitDownloadVideoToolInput {
  assertRuntimeContract(downloadVideoToolInputContract, value)
  if (!isRecord(value)) throw new ToolInputError("Tool arguments must be an object.")
  assertExactKeys(value, ["index", "job_id", "output_path"], "arguments")
  return {
    ...(value.index === undefined ? {} : { index: optionalInteger(value.index, "index", 0, 1_000) as number }),
    job_id: nonEmptyString(value.job_id, "job_id"),
    output_path: safeRelativePath(value.output_path),
  }
}
