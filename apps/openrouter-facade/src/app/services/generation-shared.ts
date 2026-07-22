import { PippitApiError } from "@pippit-bridge/sdk"
import { ApiError } from "../../errors.js"

export function canTryNextByokCredential(error: unknown): boolean {
  return error instanceof PippitApiError &&
    error.code === "HTTP_ERROR" &&
    (error.status === 401 || error.status === 403 || error.status === 429)
}

export function noEligibleByokCredential(): ApiError {
  return new ApiError("No enabled Pippit BYOK credential is eligible for this request.", {
    code: "byok_credential_unavailable",
    statusCode: 503,
    type: "api_error",
  })
}
