import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { ApiError } from "../errors.js"

const JOB_PREFIX = "pippit_job_v2"
const MAX_JOB_ID_LENGTH = 16 * 1024

const payloadSchema = z
  .object({
    api_key_binding: z.string().min(32).max(128),
    created_at: z.number().int().nonnegative(),
    credential_id: z.uuid(),
    credential_version_id: z.uuid(),
    model: z.string().min(1),
    run_id: z.string().min(1),
    thread_id: z.string().min(1),
    version: z.literal(2),
    workspace_id: z.uuid(),
  })
  .strict()

export type JobTokenPayload = z.infer<typeof payloadSchema>
export type NewJobTokenPayload = Omit<JobTokenPayload, "api_key_binding" | "version">

function signingKey(keyHex: string): Buffer {
  const key = Buffer.from(keyHex, "hex")
  if (key.length !== 32) throw new Error("The job signing key is invalid.")
  return key
}

function hmac(value: string, keyHex: string): Buffer {
  return createHmac("sha256", signingKey(keyHex)).update(value).digest()
}

function signature(encodedPayload: string, keyHex: string): Buffer {
  return hmac(`${JOB_PREFIX}.${encodedPayload}`, keyHex)
}

function apiKeyBinding(apiKey: string, keyHex: string): string {
  return hmac(`facade-api-key\u0000${apiKey}`, keyHex).toString("base64url")
}

function invalidJobId(): ApiError {
  return new ApiError("The requested video job does not exist or is not available to this API key.", {
    code: "video_job_not_found",
    param: "job_id",
    statusCode: 404,
    type: "not_found_error",
  })
}

export function createJobId(
  payload: NewJobTokenPayload,
  facadeApiKey: string,
  keyHex: string,
): string {
  const validated = payloadSchema.parse({
    ...payload,
    api_key_binding: apiKeyBinding(facadeApiKey, keyHex),
    version: 2,
  })
  const encodedPayload = Buffer.from(JSON.stringify(validated)).toString("base64url")
  const encodedSignature = signature(encodedPayload, keyHex).toString("base64url")
  return `${JOB_PREFIX}.${encodedPayload}.${encodedSignature}`
}

export function parseJobId(jobId: string, facadeApiKey: string, keyHex: string): JobTokenPayload {
  if (jobId.length > MAX_JOB_ID_LENGTH) throw invalidJobId()
  const [prefix, encodedPayload, encodedSignature, extra] = jobId.split(".")
  if (prefix !== JOB_PREFIX || !encodedPayload || !encodedSignature || extra !== undefined) throw invalidJobId()

  try {
    const actualSignature = Buffer.from(encodedSignature, "base64url")
    const expectedSignature = signature(encodedPayload, keyHex)
    if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) {
      throw invalidJobId()
    }
    const payload: unknown = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"))
    const validated = payloadSchema.parse(payload)
    const actualBinding = Buffer.from(validated.api_key_binding, "base64url")
    const expectedBinding = Buffer.from(apiKeyBinding(facadeApiKey, keyHex), "base64url")
    if (actualBinding.length !== expectedBinding.length || !timingSafeEqual(actualBinding, expectedBinding)) {
      throw invalidJobId()
    }
    return validated
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw invalidJobId()
  }
}
