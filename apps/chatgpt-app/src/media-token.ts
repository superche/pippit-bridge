import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { z } from "zod"

const TOKEN_PART_PATTERN = /^[A-Za-z0-9_-]+$/u

const tokenPayloadSchema = z
  .object({
    e: z.number().int().positive(),
    i: z.number().int().min(0).max(1_000),
    j: z.string().min(1).max(8_192),
    n: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
    v: z.literal(1),
  })
  .strict()

export interface MediaTokenPayload {
  readonly expiresAt: number
  readonly index: number
  readonly jobId: string
}

export interface MediaTokenSignerOptions {
  readonly keyHex: string
  readonly now?: () => number
  readonly ttlSeconds: number
}

export interface MediaTokenSigner {
  issue(jobId: string, index?: number): string
  verify(token: string): MediaTokenPayload
}

function signature(value: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(value, "ascii").digest()
}

export function createMediaTokenSigner(options: MediaTokenSignerOptions): MediaTokenSigner {
  const key = Buffer.from(options.keyHex, "hex")
  if (key.byteLength !== 32) {
    throw new Error("Media signing keys must contain exactly 32 bytes encoded as hexadecimal.")
  }
  if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds <= 0) {
    throw new Error("Media token TTL must be a positive integer.")
  }
  const now = options.now ?? Date.now

  return {
    issue(jobId, index = 0) {
      const payload = tokenPayloadSchema.parse({
        e: Math.floor(now() / 1000) + options.ttlSeconds,
        i: index,
        j: jobId,
        n: randomBytes(12).toString("base64url"),
        v: 1,
      })
      const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
      const encodedSignature = signature(encodedPayload, key).toString("base64url")
      return `${encodedPayload}.${encodedSignature}`
    },
    verify(token) {
      const parts = token.split(".")
      const encodedPayload = parts[0]
      const encodedSignature = parts[1]
      if (
        parts.length !== 2 ||
        encodedPayload === undefined ||
        encodedSignature === undefined ||
        !TOKEN_PART_PATTERN.test(encodedPayload) ||
        !TOKEN_PART_PATTERN.test(encodedSignature)
      ) {
        throw new Error("Invalid media token.")
      }

      const actualSignature = Buffer.from(encodedSignature, "base64url")
      const expectedSignature = signature(encodedPayload, key)
      if (
        actualSignature.byteLength !== expectedSignature.byteLength ||
        !timingSafeEqual(actualSignature, expectedSignature)
      ) {
        throw new Error("Invalid media token signature.")
      }

      let rawPayload: unknown
      try {
        rawPayload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"))
      } catch {
        throw new Error("Invalid media token payload.")
      }
      const payload = tokenPayloadSchema.parse(rawPayload)
      if (payload.e <= Math.floor(now() / 1000)) {
        throw new Error("Media token has expired.")
      }
      return { expiresAt: payload.e, index: payload.i, jobId: payload.j }
    },
  }
}
