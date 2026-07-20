import { z } from "zod"
import { PIPPIT_DEFAULT_TIMEOUT_MS } from "@pippit-bridge/sdk"

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const KEY_HEX_PATTERN = /^[a-f0-9]{64}$/u

const booleanFromEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true")

const optionalUrl = z
  .string()
  .trim()
  .default("")
  .transform((value) => (value === "" ? undefined : value))
  .pipe(z.url().optional())

const sha256Allowlist = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().regex(SHA256_PATTERN)))

const envSchema = z.object({
  ALLOW_PRIVATE_REFERENCE_URLS: booleanFromEnv,
  BYOK_ENCRYPTION_KEY_HEX: z.string().trim().toLowerCase().default(""),
  BYOK_MANAGEMENT_KEY_SHA256: z.string().trim().toLowerCase().default(""),
  BYOK_STORE_PATH: z.string().trim().min(1).default("./data/byok-credentials.json"),
  CONTENT_STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(PIPPIT_DEFAULT_TIMEOUT_MS),
  FACADE_API_KEY_SHA256_ALLOWLIST: sha256Allowlist,
  HOST: z.string().min(1).default("127.0.0.1"),
  JOB_SIGNING_KEY_HEX: z.string().trim().toLowerCase().default(""),
  PIPPIT_BASE_URL: z.url().default("https://xyq.jianying.com"),
  PIPPIT_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(PIPPIT_DEFAULT_TIMEOUT_MS),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  PUBLIC_BASE_URL: optionalUrl,
  REFERENCE_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(PIPPIT_DEFAULT_TIMEOUT_MS),
  REFERENCE_GLOBAL_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  REFERENCE_MAX_AUDIO_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),
  REFERENCE_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(30 * 1024 * 1024),
  REFERENCE_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(3),
  REFERENCE_MAX_TOTAL_BYTES: z.coerce.number().int().positive().default(300 * 1024 * 1024),
  REFERENCE_MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(200 * 1024 * 1024),
  REFERENCE_UPLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(1),
})

export type AppConfig = z.infer<typeof envSchema>

function assertOperationalConfig(config: AppConfig): void {
  if (!KEY_HEX_PATTERN.test(config.BYOK_ENCRYPTION_KEY_HEX)) {
    throw new Error("BYOK_ENCRYPTION_KEY_HEX must contain exactly 32 random bytes encoded as 64 lowercase hex characters.")
  }
  if (!KEY_HEX_PATTERN.test(config.JOB_SIGNING_KEY_HEX)) {
    throw new Error("JOB_SIGNING_KEY_HEX must contain exactly 32 random bytes encoded as 64 lowercase hex characters.")
  }
  if (config.BYOK_ENCRYPTION_KEY_HEX === config.JOB_SIGNING_KEY_HEX) {
    throw new Error("BYOK_ENCRYPTION_KEY_HEX and JOB_SIGNING_KEY_HEX must be different keys.")
  }
  if (!SHA256_PATTERN.test(config.BYOK_MANAGEMENT_KEY_SHA256)) {
    throw new Error("BYOK_MANAGEMENT_KEY_SHA256 must be the SHA-256 digest of a high-entropy Management API Key.")
  }
  if (config.FACADE_API_KEY_SHA256_ALLOWLIST.length === 0) {
    throw new Error("FACADE_API_KEY_SHA256_ALLOWLIST must contain at least one facade API key digest.")
  }
  if (config.FACADE_API_KEY_SHA256_ALLOWLIST.some((digest) => !SHA256_PATTERN.test(digest))) {
    throw new Error("FACADE_API_KEY_SHA256_ALLOWLIST must contain only lowercase SHA-256 digests.")
  }
  if (config.FACADE_API_KEY_SHA256_ALLOWLIST.includes(config.BYOK_MANAGEMENT_KEY_SHA256)) {
    throw new Error("The Management API Key must not also be authorized as a facade API key.")
  }
  const authenticationDigests = [
    config.BYOK_MANAGEMENT_KEY_SHA256,
    ...config.FACADE_API_KEY_SHA256_ALLOWLIST,
  ]
  if (
    authenticationDigests.includes(config.BYOK_ENCRYPTION_KEY_HEX) ||
    authenticationDigests.includes(config.JOB_SIGNING_KEY_HEX)
  ) {
    throw new Error("Encryption and job-signing keys must not reuse a management or facade credential digest.")
  }
}

export function parseConfig(env: NodeJS.ProcessEnv = {}): AppConfig {
  return envSchema.parse(env)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = parseConfig(env)
  assertOperationalConfig(config)
  return config
}

export function mergeConfig(base: AppConfig, overrides: Partial<AppConfig> | undefined): AppConfig {
  const config = overrides ? { ...base, ...overrides } : base
  assertOperationalConfig(config)
  return config
}
