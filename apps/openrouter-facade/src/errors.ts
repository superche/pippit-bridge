import { ZodError } from "zod"

export type ApiErrorType =
  | "authentication_error"
  | "invalid_request_error"
  | "not_found_error"
  | "upstream_error"
  | "api_error"

export interface ApiErrorOptions {
  readonly cause?: unknown
  readonly code: string
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>
  readonly param?: string | null
  readonly statusCode: number
  readonly type: ApiErrorType
}

export class ApiError extends Error {
  readonly code: string
  readonly metadata: Readonly<Record<string, string | number | boolean | null>> | undefined
  readonly param: string | null
  readonly statusCode: number
  readonly type: ApiErrorType

  constructor(message: string, options: ApiErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "ApiError"
    this.code = options.code
    this.metadata = options.metadata
    this.param = options.param ?? null
    this.statusCode = options.statusCode
    this.type = options.type
  }
}

export interface OpenRouterErrorBody {
  readonly error: {
    readonly code: number
    readonly message: string
    readonly metadata?: Readonly<Record<string, string | number | boolean | null>>
    readonly param: string | null
    readonly type: ApiErrorType
  }
}

export function invalidRequest(message: string, param: string | null, code = "invalid_request"): ApiError {
  return new ApiError(message, {
    code,
    param,
    statusCode: 400,
    type: "invalid_request_error",
  })
}

export function toOpenRouterError(error: unknown): { readonly body: OpenRouterErrorBody; readonly statusCode: number } {
  if (error instanceof ApiError) {
    const metadata = { internal_code: error.code, ...error.metadata }
    return {
      body: {
        error: {
          code: error.statusCode,
          message: error.message,
          metadata,
          param: error.param,
          type: error.type,
        },
      },
      statusCode: error.statusCode,
    }
  }

  if (error instanceof ZodError) {
    const issue = error.issues[0]
    const param = issue?.path.map(String).join(".") || null
    return {
      body: {
        error: {
          code: 400,
          message: issue?.message ?? "The request body is invalid.",
          metadata: { internal_code: "invalid_request" },
          param,
          type: "invalid_request_error",
        },
      },
      statusCode: 400,
    }
  }

  return {
    body: {
      error: {
        code: 500,
        message: "The server could not process the request.",
        metadata: { internal_code: "internal_error" },
        param: null,
        type: "api_error",
      },
    },
    statusCode: 500,
  }
}
