import { resolve } from "node:path"
import type {
  PippitDownloadedVideo,
  PippitVideoEditRequest,
  PippitVideoGenerateRequest,
} from "../contracts.ts"
import { PippitFacadeError } from "../client.ts"
import { createPippitAccessKeyEnrollmentServer } from "../enrollment.ts"
import { PIPPIT_DEFAULT_OUTPUT_DIRECTORY } from "../options.ts"
import type { PippitToolRuntime, PippitToolRuntimeOptions } from "./contract.ts"
import { writeDownload } from "./download-writer.ts"
import {
  parseAddAccessKeyInput,
  parseDeleteAccessKeyInput,
  parseDownloadInput,
  parseEditInput,
  parseEmptyToolInput,
  parseGenerateImageInput,
  parseGenerateInput,
  parseGetInput,
  parseSwitchAccessKeyInput,
  ToolInputError,
} from "./inputs.ts"
import {
  facadeEditRequest,
  facadeImageRequest,
  facadeRequest,
  imageResult,
  safeError,
  structuredResult,
} from "./mappers.ts"
import { PIPPIT_MANAGEMENT_TOOL_DEFINITIONS, PIPPIT_RUNTIME_TOOL_DEFINITIONS } from "./registry.ts"

export * from "./contract.js"
export * from "./registry.js"

interface DedupeEntry {
  readonly fingerprint: string
  readonly promise: Promise<object>
  settled: boolean
}

function failureCodePart(value: string | number): string {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 64)
}

function createSubmissionCoordinator(
  options: PippitToolRuntimeOptions,
  dedupeLimit: number,
): (
  idempotencyKey: string | undefined,
  operation: "edit" | "generate",
  request: PippitVideoEditRequest | PippitVideoGenerateRequest,
  create: () => Promise<object>,
) => Promise<object> {
  const dedupe = new Map<string, DedupeEntry>()
  return (idempotencyKey, operation, request, create) => {
    if (idempotencyKey === undefined) return create()
    const fingerprint = JSON.stringify({ operation, request })
    const existing = dedupe.get(idempotencyKey)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new ToolInputError("idempotency_key was already used for a different request in this MCP process.")
      }
      return existing.promise
    }
    if (dedupe.size >= dedupeLimit) {
      const settledKey = [...dedupe].find(([, entry]) => entry.settled)?.[0]
      if (settledKey === undefined) {
        throw new ToolInputError("The process-local idempotency cache is busy; retry after an in-flight submission settles.")
      }
      dedupe.delete(settledKey)
    }
    const durableSubmission = async (): Promise<object> => {
      if (options.idempotencyStore === undefined) return create()
      const begun = await options.idempotencyStore.begin({
        key: idempotencyKey,
        operation: operation === "generate" ? "mcp_generate_video" : "mcp_edit_video",
        request,
        scope: options.idempotencyScope as string,
      })
      if (begun.kind === "replay") return begun.response as object
      if (begun.kind === "conflict") {
        throw new ToolInputError("idempotency_key was already used for a different recovery request.")
      }
      if (begun.kind === "in_progress") {
        throw new ToolInputError(`The recovery request for this idempotency_key is still ${begun.phase}.`)
      }
      if (begun.kind === "indeterminate") {
        throw new ToolInputError("The previous submission may have reached Pippit. Do not retry automatically; inspect the original task first.")
      }
      if (begun.kind === "failed") {
        throw new ToolInputError(`The previous recovery request failed (${begun.errorCode}).`)
      }
      await options.idempotencyStore.markSubmitting(begun.recordId)
      let response: object
      try {
        response = await create()
      } catch (error) {
        const ambiguous = !(error instanceof PippitFacadeError) ||
          ["ABORTED", "INVALID_RESPONSE", "NETWORK_ERROR", "TIMEOUT"].includes(error.code)
        if (ambiguous) await options.idempotencyStore.markIndeterminate(begun.recordId)
        else {
          const errorCode = error.code.toLowerCase()
          const operationFailureCode = error.upstreamOperation === undefined
            ? errorCode
            : `${errorCode}_${error.upstreamOperation}`
          const upstreamCode = error.upstreamCode === undefined ? "" : failureCodePart(error.upstreamCode)
          const failureCode = upstreamCode === ""
            ? operationFailureCode
            : `${operationFailureCode}_code_${upstreamCode}`
          const upstreamLogId = error.upstreamLogId === undefined ? "" : failureCodePart(error.upstreamLogId)
          await options.idempotencyStore.markFailed(
            begun.recordId,
            upstreamLogId === "" ? failureCode : `${failureCode}_logid_${upstreamLogId}`,
          )
        }
        throw error
      }
      try {
        await options.idempotencyStore.markSubmitted(begun.recordId, response)
      } catch {
        throw new ToolInputError("Pippit accepted the task, but its recovery record could not be saved. Do not retry automatically.")
      }
      return response
    }
    const entry: DedupeEntry = { fingerprint, promise: durableSubmission(), settled: false }
    dedupe.set(idempotencyKey, entry)
    void entry.promise.then(
      () => { entry.settled = true },
      () => { entry.settled = true },
    )
    return entry.promise
  }
}

export function createPippitToolRuntime(options: PippitToolRuntimeOptions): PippitToolRuntime {
  const dedupeLimit = options.dedupeLimit ?? 256
  const maxDownloadBytes = options.maxDownloadBytes ?? 2 * 1024 * 1024 * 1024
  if (!Number.isSafeInteger(dedupeLimit) || dedupeLimit < 1 || dedupeLimit > 10_000) {
    throw new Error("dedupeLimit must be an integer from 1 to 10000.")
  }
  if (!Number.isSafeInteger(maxDownloadBytes) || maxDownloadBytes < 1) {
    throw new Error("maxDownloadBytes must be a positive safe integer.")
  }
  if (options.managementClient === undefined && options.enrollmentServer !== undefined) {
    throw new Error("enrollmentServer requires managementClient.")
  }
  if (options.idempotencyStore !== undefined && !options.idempotencyScope?.trim()) {
    throw new Error("idempotencyScope is required when idempotencyStore is configured.")
  }
  const outputRoot = resolve(options.outputRoot ?? PIPPIT_DEFAULT_OUTPUT_DIRECTORY)
  const enrollmentServer = options.managementClient === undefined
    ? undefined
    : options.enrollmentServer ?? createPippitAccessKeyEnrollmentServer({
        managementClient: options.managementClient,
        ...(options.enrollmentPort === undefined ? {} : { port: options.enrollmentPort }),
        ...(options.enrollmentTtlMs === undefined ? {} : { ttlMs: options.enrollmentTtlMs }),
      })
  const submit = createSubmissionCoordinator(options, dedupeLimit)

  return {
    async callTool(name, argumentsValue) {
      try {
        if (name === "pippit_list_image_models") {
          parseEmptyToolInput(argumentsValue)
          return structuredResult(await options.client.listImageModels())
        }
        if (name === "pippit_generate_image") {
          return imageResult(await options.client.generateImage(facadeImageRequest(parseGenerateImageInput(argumentsValue))))
        }
        if (name === "pippit_list_video_models") {
          parseEmptyToolInput(argumentsValue)
          return structuredResult(await options.client.listVideoModels())
        }
        if (name === "pippit_generate_video") {
          const parsed = parseGenerateInput(argumentsValue)
          const request = facadeRequest(parsed)
          return structuredResult(await submit(parsed.idempotency_key, "generate", request, () => options.client.generateVideo(request)))
        }
        if (name === "pippit_get_video") {
          return structuredResult(await options.client.getVideo(parseGetInput(argumentsValue).job_id))
        }
        if (name === "pippit_download_video") {
          const parsed = parseDownloadInput(argumentsValue)
          const index = parsed.index ?? 0
          const written = await writeDownload({
            maxBytes: maxDownloadBytes,
            outputRoot,
            relativePath: parsed.output_path,
            response: await options.client.downloadVideo(parsed.job_id, { index }),
          })
          const result: PippitDownloadedVideo = {
            bytes: written.bytes,
            index,
            job_id: parsed.job_id,
            media_type: written.mediaType,
            path: parsed.output_path,
          }
          return structuredResult(result)
        }
        if (name === "pippit_edit_video_segment") {
          const parsed = parseEditInput(argumentsValue)
          const request = facadeEditRequest(parsed)
          return structuredResult(await submit(parsed.idempotency_key, "edit", request, () => options.client.editVideo(request)))
        }
        if (options.managementClient !== undefined && enrollmentServer !== undefined) {
          if (name === "pippit_list_access_keys") {
            parseEmptyToolInput(argumentsValue)
            return structuredResult(await options.managementClient.listAccessKeys())
          }
          if (name === "pippit_add_access_key") {
            return structuredResult(await enrollmentServer.createEnrollment(parseAddAccessKeyInput(argumentsValue).account_name))
          }
          if (name === "pippit_switch_access_key") {
            return structuredResult(await options.managementClient.switchAccessKey(parseSwitchAccessKeyInput(argumentsValue).credential_id))
          }
          if (name === "pippit_delete_access_key") {
            return structuredResult(await options.managementClient.deleteAccessKey(parseDeleteAccessKeyInput(argumentsValue).credential_id))
          }
        }
        throw new ToolInputError(`Unknown Pippit tool ${name}.`)
      } catch (error) {
        return safeError(error)
      }
    },
    async close() {
      await Promise.all([enrollmentServer?.close(), options.idempotencyStore?.close()])
    },
    listTools() {
      return options.managementClient === undefined
        ? PIPPIT_RUNTIME_TOOL_DEFINITIONS
        : [...PIPPIT_RUNTIME_TOOL_DEFINITIONS, ...PIPPIT_MANAGEMENT_TOOL_DEFINITIONS]
    },
  }
}
