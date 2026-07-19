import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { PippitFacadeClientOptions, PippitFacadeManagementClientOptions } from "./contracts.ts"

export const PIPPIT_DEFAULT_FACADE_BASE_URL = "http://127.0.0.1:3000"
export const PIPPIT_DEFAULT_FACADE_TIMEOUT_MS = 120_000
export const PIPPIT_DEFAULT_ENROLLMENT_TTL_MS = 5 * 60_000
export const PIPPIT_DEFAULT_ENROLLMENT_PORT = 0

export function defaultPippitOutputDirectory(
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return join(userHome, platform === "darwin" ? "Movies" : "Videos", "Pippit")
}

export const PIPPIT_DEFAULT_OUTPUT_DIRECTORY = defaultPippitOutputDirectory()

export interface PippitMcpOptions {
  readonly facadeApiKey: string
  readonly facadeBaseUrl: string
  readonly facadeManagementApiKey?: string
  readonly facadeTimeoutMs: number
  readonly enrollmentPort: number
  readonly enrollmentTtlMs: number
  readonly outputRoot: string
}

export type PippitMcpOptionOverrides = Partial<PippitMcpOptions>

export function normalizePippitFacadeBaseUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error("PIPPIT_FACADE_BASE_URL must be an absolute HTTP(S) URL.")
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("PIPPIT_FACADE_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment.")
  }
  const loopbackHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(parsed.hostname))
  if (parsed.protocol !== "https:" && !loopbackHttp) {
    throw new Error("PIPPIT_FACADE_BASE_URL must use HTTPS except for a loopback HTTP facade.")
  }
  return parsed.toString().replace(/\/+$/u, "")
}

function normalizeFacadeApiKey(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error("PIPPIT_FACADE_API_KEY is required.")
  }
  const normalized = value.trim()
  if (!/^[\x21-\x7e]+$/u.test(normalized)) {
    throw new Error("PIPPIT_FACADE_API_KEY must contain only visible ASCII characters.")
  }
  return normalized
}

function normalizeOptionalManagementApiKey(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined
  const normalized = value.trim()
  if (!/^[\x21-\x7e]+$/u.test(normalized)) {
    throw new Error("PIPPIT_FACADE_MANAGEMENT_API_KEY must contain only visible ASCII characters.")
  }
  return normalized
}

function normalizeTimeout(value: string | number | undefined): number {
  const candidate = value ?? PIPPIT_DEFAULT_FACADE_TIMEOUT_MS
  const timeout = typeof candidate === "number" ? candidate : Number(candidate)
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000) {
    throw new Error("PIPPIT_FACADE_TIMEOUT_MS must be an integer from 1 to 600000.")
  }
  return timeout
}

function normalizeOutputRoot(value: string): string {
  if (value.trim() === "" || value.includes("\0")) {
    throw new Error("PIPPIT_MCP_OUTPUT_ROOT must be a non-empty filesystem path.")
  }
  return resolve(value)
}

function normalizeEnrollmentTtl(value: string | number | undefined): number {
  const candidate = value ?? PIPPIT_DEFAULT_ENROLLMENT_TTL_MS
  const ttl = typeof candidate === "number" ? candidate : Number(candidate)
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 15 * 60_000) {
    throw new Error("PIPPIT_MCP_ENROLLMENT_TTL_MS must be an integer from 1 to 900000.")
  }
  return ttl
}

function normalizeEnrollmentPort(value: string | number | undefined): number {
  const candidate = value ?? PIPPIT_DEFAULT_ENROLLMENT_PORT
  const port = typeof candidate === "number" ? candidate : Number(candidate)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PIPPIT_MCP_ENROLLMENT_PORT must be an integer from 0 to 65535.")
  }
  return port
}

export function parsePippitMcpOptions(
  env: NodeJS.ProcessEnv = process.env,
  overrides: PippitMcpOptionOverrides = {},
): PippitMcpOptions {
  const facadeManagementApiKey = normalizeOptionalManagementApiKey(
    overrides.facadeManagementApiKey ?? env.PIPPIT_FACADE_MANAGEMENT_API_KEY,
  )
  return {
    facadeApiKey: normalizeFacadeApiKey(overrides.facadeApiKey ?? env.PIPPIT_FACADE_API_KEY),
    facadeBaseUrl: normalizePippitFacadeBaseUrl(
      overrides.facadeBaseUrl ?? env.PIPPIT_FACADE_BASE_URL ?? PIPPIT_DEFAULT_FACADE_BASE_URL,
    ),
    ...(facadeManagementApiKey === undefined ? {} : { facadeManagementApiKey }),
    facadeTimeoutMs: normalizeTimeout(overrides.facadeTimeoutMs ?? env.PIPPIT_FACADE_TIMEOUT_MS),
    enrollmentPort: normalizeEnrollmentPort(
      overrides.enrollmentPort ?? env.PIPPIT_MCP_ENROLLMENT_PORT,
    ),
    enrollmentTtlMs: normalizeEnrollmentTtl(
      overrides.enrollmentTtlMs ?? env.PIPPIT_MCP_ENROLLMENT_TTL_MS,
    ),
    outputRoot: normalizeOutputRoot(
      overrides.outputRoot ?? env.PIPPIT_MCP_OUTPUT_ROOT ?? PIPPIT_DEFAULT_OUTPUT_DIRECTORY,
    ),
  }
}

export function facadeClientOptions(options: PippitMcpOptions): PippitFacadeClientOptions {
  return {
    apiKey: options.facadeApiKey,
    baseUrl: options.facadeBaseUrl,
    timeoutMs: options.facadeTimeoutMs,
  }
}

export function facadeManagementClientOptions(
  options: PippitMcpOptions,
): PippitFacadeManagementClientOptions | undefined {
  if (options.facadeManagementApiKey === undefined) return undefined
  return {
    baseUrl: options.facadeBaseUrl,
    facadeApiKeyHash: createHash("sha256").update(options.facadeApiKey, "utf8").digest("hex"),
    managementApiKey: options.facadeManagementApiKey,
    timeoutMs: options.facadeTimeoutMs,
  }
}
