import { PIPPIT_DEFAULT_BASE_URL, PIPPIT_DEFAULT_TIMEOUT_MS } from "@pippit-bridge/sdk"
import { isAbsolute, win32 } from "node:path"

export const PIPPIT_ACCESS_KEY_ENV = "PIPPIT_ACCESS_KEY"
export const PIPPIT_ACCESS_KEY_PAGE = "https://xyq.jianying.com"

export interface PippitPluginOptions {
  readonly allowPrivateReferenceUrls: boolean
  readonly baseURL: string
  readonly outputDirectory: string
  readonly pollIntervalMs: number
  readonly requestTimeoutMs: number
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Pippit plugin option ${key} must be a non-empty string.`)
  }
  return value.trim()
}

function positiveInteger(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key] ?? fallback
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Pippit plugin option ${key} must be a positive integer.`)
  }
  return Number(value)
}

function httpUrl(value: string, key: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Pippit plugin option ${key} must be an absolute URL.`)
  }
  const invalidProtocol = url.protocol !== "https:" && url.protocol !== "http:"
  if (url.username || url.password || invalidProtocol) {
    throw new Error(`Pippit plugin option ${key} must use HTTP(S) without URL credentials.`)
  }
  return url.toString().replace(/\/+$/u, "")
}

export function parsePluginOptions(value: unknown): PippitPluginOptions {
  const input = optionalRecord(value) ?? {}
  const baseURL = httpUrl(optionalString(input, "baseURL") ?? PIPPIT_DEFAULT_BASE_URL, "baseURL")
  if (baseURL !== PIPPIT_DEFAULT_BASE_URL) {
    throw new Error(`Pippit plugin option baseURL is fixed to the official origin ${PIPPIT_DEFAULT_BASE_URL}.`)
  }
  const outputDirectory = optionalString(input, "outputDirectory") ?? ".pippit/outputs"
  if (
    isAbsolute(outputDirectory) ||
    win32.isAbsolute(outputDirectory) ||
    outputDirectory.split(/[\\/]+/u).includes("..")
  ) {
    throw new Error("Pippit plugin option outputDirectory must stay inside the OpenCode worktree.")
  }

  const allowPrivateReferenceUrls = input.allowPrivateReferenceUrls ?? false
  if (typeof allowPrivateReferenceUrls !== "boolean") {
    throw new Error("Pippit plugin option allowPrivateReferenceUrls must be a boolean.")
  }

  return {
    allowPrivateReferenceUrls,
    baseURL,
    outputDirectory,
    pollIntervalMs: positiveInteger(input, "pollIntervalMs", 2_000),
    requestTimeoutMs: positiveInteger(input, "requestTimeoutMs", PIPPIT_DEFAULT_TIMEOUT_MS),
  }
}
