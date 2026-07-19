import { z } from "zod"

import {
  PIPPIT_DEFAULT_FACADE_TIMEOUT_MS,
  resolvePippitRuntimeEnvironment,
  type PippitResolvedRuntimeEnvironment,
} from "@pippit-bridge/mcp-server"

const KEY_HEX_PATTERN = /^[a-f0-9]{64}$/u

const optionalUrl = z
  .string()
  .trim()
  .default("")
  .transform((value) => (value === "" ? undefined : value))
  .pipe(z.url().optional())

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" || hostname === "localhost"
}

function isSafeBaseOrigin(value: string): boolean {
  const url = new URL(value)
  const allowedProtocol = url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname))
  return (
    allowedProtocol &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === ""
  )
}

const optionalPublicBaseUrl = optionalUrl.refine(
  (value) => value === undefined || isSafeBaseOrigin(value),
  "CHATGPT_APP_PUBLIC_BASE_URL must be an HTTPS origin (or HTTP loopback origin) without credentials, a path, query, or fragment.",
)

const facadeBaseUrl = z.url().refine(
  isSafeBaseOrigin,
  "PIPPIT_FACADE_BASE_URL must be an HTTPS origin (or HTTP loopback origin) without credentials, a path, query, or fragment.",
)

const optionalSigningKey = z
  .string()
  .trim()
  .toLowerCase()
  .default("")
  .transform((value) => (value === "" ? undefined : value))
  .pipe(z.string().regex(KEY_HEX_PATTERN).optional())

const envSchema = z
  .object({
    CHATGPT_APP_HOST: z
      .string()
      .trim()
      .min(1)
      .default("127.0.0.1")
      .refine(
        isLoopbackHostname,
        "The current noauth ChatGPT App can listen only on localhost, 127.0.0.1, or ::1.",
      ),
    CHATGPT_APP_MEDIA_SIGNING_KEY_HEX: optionalSigningKey,
    CHATGPT_APP_MEDIA_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
    CHATGPT_APP_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
    CHATGPT_APP_PUBLIC_BASE_URL: optionalPublicBaseUrl,
    PIPPIT_FACADE_API_KEY: z.string().trim().min(1),
    PIPPIT_FACADE_BASE_URL: facadeBaseUrl.default("http://127.0.0.1:3000"),
    PIPPIT_FACADE_TIMEOUT_MS: z.coerce.number().int().positive().default(PIPPIT_DEFAULT_FACADE_TIMEOUT_MS),
  })
  .superRefine((value, context) => {
    const hasPublicUrl = value.CHATGPT_APP_PUBLIC_BASE_URL !== undefined
    const hasSigningKey = value.CHATGPT_APP_MEDIA_SIGNING_KEY_HEX !== undefined
    if (hasPublicUrl !== hasSigningKey) {
      context.addIssue({
        code: "custom",
        message:
          "CHATGPT_APP_PUBLIC_BASE_URL and CHATGPT_APP_MEDIA_SIGNING_KEY_HEX must be configured together to enable media previews.",
        path: hasPublicUrl
          ? ["CHATGPT_APP_MEDIA_SIGNING_KEY_HEX"]
          : ["CHATGPT_APP_PUBLIC_BASE_URL"],
      })
    }
  })

interface ParsedEnvironment {
  readonly CHATGPT_APP_HOST: string
  readonly CHATGPT_APP_MEDIA_SIGNING_KEY_HEX?: string
  readonly CHATGPT_APP_MEDIA_TTL_SECONDS: number
  readonly CHATGPT_APP_PORT: number
  readonly CHATGPT_APP_PUBLIC_BASE_URL?: string
  readonly PIPPIT_FACADE_API_KEY: string
  readonly PIPPIT_FACADE_BASE_URL: string
  readonly PIPPIT_FACADE_TIMEOUT_MS: number
}

export interface ChatGptAppConfig {
  readonly facadeApiKey: string
  readonly facadeBaseUrl: string
  readonly facadeTimeoutMs: number
  readonly host: string
  readonly mediaSigningKeyHex?: string
  readonly mediaTtlSeconds: number
  readonly port: number
  readonly publicBaseUrl?: string
}

export type PippitRuntimeEnvironmentResolver = (
  env: NodeJS.ProcessEnv,
) => Promise<PippitResolvedRuntimeEnvironment>

export interface ResolveChatGptAppConfigOptions {
  readonly runtimeEnvironmentResolver?: PippitRuntimeEnvironmentResolver
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url
}

export function parseChatGptAppConfig(env: NodeJS.ProcessEnv = {}): ChatGptAppConfig {
  const parsed = envSchema.parse(env) as ParsedEnvironment
  return {
    facadeApiKey: parsed.PIPPIT_FACADE_API_KEY,
    facadeBaseUrl: trimTrailingSlash(parsed.PIPPIT_FACADE_BASE_URL),
    facadeTimeoutMs: parsed.PIPPIT_FACADE_TIMEOUT_MS,
    host: parsed.CHATGPT_APP_HOST,
    ...(parsed.CHATGPT_APP_MEDIA_SIGNING_KEY_HEX === undefined
      ? {}
      : { mediaSigningKeyHex: parsed.CHATGPT_APP_MEDIA_SIGNING_KEY_HEX }),
    mediaTtlSeconds: parsed.CHATGPT_APP_MEDIA_TTL_SECONDS,
    port: parsed.CHATGPT_APP_PORT,
    ...(parsed.CHATGPT_APP_PUBLIC_BASE_URL === undefined
      ? {}
      : { publicBaseUrl: trimTrailingSlash(parsed.CHATGPT_APP_PUBLIC_BASE_URL) }),
  }
}

export function loadChatGptAppConfig(env: NodeJS.ProcessEnv = process.env): ChatGptAppConfig {
  return parseChatGptAppConfig(env)
}

/**
 * Resolves either an explicitly configured Facade or the shared user-level
 * local runtime before parsing the HTTP App settings. Only the Facade runtime
 * credential is projected into the ChatGPT App; the management credential is
 * deliberately removed so it cannot enter the App tool layer.
 */
export async function resolveChatGptAppConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveChatGptAppConfigOptions = {},
): Promise<ChatGptAppConfig> {
  const resolved = await (options.runtimeEnvironmentResolver ?? resolvePippitRuntimeEnvironment)(env)
  const configEnvironment: NodeJS.ProcessEnv = {
    ...env,
    ...resolved.environment,
  }
  delete configEnvironment.PIPPIT_FACADE_MANAGEMENT_API_KEY

  const publicBaseUrl = configEnvironment.CHATGPT_APP_PUBLIC_BASE_URL?.trim()
  const mediaSigningKey = configEnvironment.CHATGPT_APP_MEDIA_SIGNING_KEY_HEX?.trim()
  if (resolved.mode === "local" && publicBaseUrl && !mediaSigningKey) {
    if (resolved.local === undefined) {
      throw new Error("The local Pippit runtime did not provide a ChatGPT media signing key.")
    }
    configEnvironment.CHATGPT_APP_MEDIA_SIGNING_KEY_HEX = resolved.local.mediaSigningKeyHex
  }

  return parseChatGptAppConfig(configEnvironment)
}

export function mediaPreviewsEnabled(
  config: ChatGptAppConfig,
): config is ChatGptAppConfig & Required<Pick<ChatGptAppConfig, "mediaSigningKeyHex" | "publicBaseUrl">> {
  return config.mediaSigningKeyHex !== undefined && config.publicBaseUrl !== undefined
}
