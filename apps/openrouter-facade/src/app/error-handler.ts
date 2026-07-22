import type { FastifyInstance } from "fastify"
import { ReferenceLoadError } from "@pippit-bridge/core"
import { PippitApiError } from "@pippit-bridge/sdk"
import { ByokStoreError } from "../byok/index.js"
import { ApiError, toOpenRouterError } from "../errors.js"

function normalizePippitError(error: PippitApiError): ApiError {
  const metadata = {
    operation: error.operation,
    ...(error.logId === undefined ? {} : { upstream_log_id: error.logId }),
    ...(error.upstreamCode === undefined ? {} : { upstream_code: error.upstreamCode }),
  }
  if (error.code === "HTTP_ERROR" && (error.status === 401 || error.status === 403)) {
    return new ApiError("The selected Pippit BYOK credential was rejected by the upstream service.", {
      code: "byok_credential_rejected", metadata, statusCode: 502, type: "upstream_error",
    })
  }
  if (error.code === "HTTP_ERROR" && error.status === 429) {
    return new ApiError("Pippit rate limited the request.", {
      code: "rate_limit_exceeded", metadata, statusCode: 429, type: "upstream_error",
    })
  }
  if (error.code === "TIMEOUT") {
    return new ApiError("The Pippit upstream request timed out.", {
      code: "upstream_timeout", metadata, statusCode: 504, type: "upstream_error",
    })
  }
  if (error.code === "ABORTED") {
    return new ApiError("The request was cancelled.", {
      code: "request_cancelled", metadata, statusCode: 408, type: "api_error",
    })
  }
  return new ApiError("Pippit could not complete the upstream operation.", {
    code: "pippit_upstream_error", metadata, statusCode: 502, type: "upstream_error",
  })
}

function normalizeReferenceError(error: ReferenceLoadError): ApiError {
  const metadata = {
    reference_error: error.code,
    ...(error.status === undefined ? {} : { upstream_status: error.status }),
  }
  if (error.code === "INVALID_CONFIGURATION" || error.code === "INVALID_KIND") {
    return new ApiError("The reference loader is not configured correctly.", {
      code: "reference_loader_error", metadata, statusCode: 500, type: "api_error",
    })
  }
  if (error.code === "ABORTED") {
    return new ApiError("The request was cancelled while loading a reference.", {
      code: "request_cancelled", metadata, statusCode: 408, type: "api_error",
    })
  }
  if (error.code === "TOO_LARGE" || error.code === "TOTAL_TOO_LARGE") {
    return new ApiError(error.message, {
      code: "reference_too_large", metadata, param: "input_references", statusCode: 413,
      type: "invalid_request_error",
    })
  }
  return new ApiError(error.message, {
    code: error.code === "TIMEOUT" ? "reference_timeout" : "invalid_reference",
    metadata, param: "input_references", statusCode: 400, type: "invalid_request_error",
  })
}

function normalizeByokStoreError(error: ByokStoreError): ApiError {
  if (error.code === "ACTIVE_CREDENTIAL_DELETE_REQUIRES_SWITCH") {
    return new ApiError("Switch away from the active BYOK credential before deleting it.", {
      code: "active_byok_delete_requires_switch", statusCode: 409, type: "invalid_request_error",
    })
  }
  if (error.code === "ACTIVE_CREDENTIAL_INELIGIBLE") {
    return new ApiError("The requested BYOK credential is not eligible for this facade API key.", {
      code: "byok_credential_ineligible", param: "credential_id", statusCode: 409,
      type: "invalid_request_error",
    })
  }
  if (error.code === "CREDENTIAL_NOT_FOUND") {
    return new ApiError("The requested BYOK credential does not exist.", {
      code: "byok_credential_not_found", param: "credential_id", statusCode: 404, type: "not_found_error",
    })
  }
  if (error.code === "CREDENTIAL_LIMIT_EXCEEDED") {
    return new ApiError("The BYOK credential store has reached its configured limit.", {
      code: "byok_credential_limit_exceeded", statusCode: 409, type: "invalid_request_error",
    })
  }
  if (error.code === "INVALID_CONFIGURATION") {
    return new ApiError("The BYOK request is not valid for this provider workspace.", {
      code: "invalid_byok_request", statusCode: 400, type: "invalid_request_error",
    })
  }
  if (error.code === "STORE_CLOSED") {
    return new ApiError("The BYOK credential store is unavailable.", {
      code: "byok_store_unavailable", statusCode: 503, type: "api_error",
    })
  }
  return new ApiError("The encrypted BYOK credential store could not complete the operation.", {
    code: "byok_store_error", statusCode: 500, type: "api_error",
  })
}

function normalizeFrameworkError(error: unknown): unknown {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return new ApiError("The request body is too large.", {
      code: "request_too_large", statusCode: 413, type: "invalid_request_error",
    })
  }
  return error
}

export function registerFacadeErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    const normalized = error instanceof PippitApiError
      ? normalizePippitError(error)
      : error instanceof ReferenceLoadError
        ? normalizeReferenceError(error)
        : error instanceof ByokStoreError
          ? normalizeByokStoreError(error)
          : normalizeFrameworkError(error)
    const response = toOpenRouterError(normalized)
    if (response.statusCode === 401) reply.header("www-authenticate", "Bearer")
    void reply.status(response.statusCode).send(response.body)
  })
}
