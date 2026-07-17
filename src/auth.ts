import { createHash, timingSafeEqual } from "node:crypto"
import type { FastifyRequest } from "fastify"
import { ApiError } from "./errors.js"

const BEARER_PATTERN = /^Bearer[ \t]+([^\s]+)$/iu
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const MAX_API_KEY_LENGTH = 4096

export interface AuthenticatedApiKey {
  readonly apiKey: string
  readonly apiKeyHash: string
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex")
}

function getBearerToken(request: FastifyRequest, audience: "facade" | "management"): string {
  const authorization = request.headers.authorization
  const match = authorization?.match(BEARER_PATTERN)
  if (!match?.[1] || match[1].length > MAX_API_KEY_LENGTH) {
    const label = audience === "management" ? "Management API Key" : "facade API key"
    throw new ApiError(`A valid Authorization: Bearer <${label}> header is required.`, {
      code: "invalid_api_key",
      param: null,
      statusCode: 401,
      type: "authentication_error",
    })
  }
  return match[1]
}

function digestMatches(candidate: string, expectedHex: string): boolean {
  if (!SHA256_PATTERN.test(expectedHex)) return false
  const actual = createHash("sha256").update(candidate).digest()
  const expected = Buffer.from(expectedHex, "hex")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function authenticateFacadeApiKey(
  request: FastifyRequest,
  allowlist: readonly string[],
): AuthenticatedApiKey {
  const apiKey = getBearerToken(request, "facade")
  const apiKeyHash = hashApiKey(apiKey)
  const allowed = allowlist.some((expected) => {
    const candidate = Buffer.from(apiKeyHash, "hex")
    const digest = Buffer.from(expected, "hex")
    return candidate.length === digest.length && timingSafeEqual(candidate, digest)
  })
  if (!allowed) {
    throw new ApiError("The supplied facade API key is not authorized.", {
      code: "invalid_api_key",
      param: null,
      statusCode: 401,
      type: "authentication_error",
    })
  }
  return { apiKey, apiKeyHash }
}

export function authenticateManagementKey(request: FastifyRequest, expectedDigest: string): void {
  const managementKey = getBearerToken(request, "management")
  if (!digestMatches(managementKey, expectedDigest)) {
    throw new ApiError("The supplied Management API Key is not authorized.", {
      code: "invalid_api_key",
      param: null,
      statusCode: 401,
      type: "authentication_error",
    })
  }
}
