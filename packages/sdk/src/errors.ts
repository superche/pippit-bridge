export type PippitOperation =
  | 'client'
  | 'upload_file'
  | 'submit_run'
  | 'query_generate_video_result';

export type PippitErrorCode =
  | 'INVALID_INPUT'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR'
  | 'UPSTREAM_ERROR'
  | 'INVALID_RESPONSE';

interface PippitApiErrorOptions {
  code: PippitErrorCode;
  logId?: string;
  operation: PippitOperation;
  status?: number;
  upstreamCode?: string | number;
}

function buildMessage(options: PippitApiErrorOptions): string {
  switch (options.code) {
    case 'INVALID_INPUT':
      return `Invalid input for Pippit ${options.operation}`;
    case 'ABORTED':
      return `Pippit ${options.operation} request was aborted`;
    case 'TIMEOUT':
      return `Pippit ${options.operation} request timed out`;
    case 'NETWORK_ERROR':
      return `Pippit ${options.operation} network request failed`;
    case 'HTTP_ERROR':
      return `Pippit ${options.operation} returned HTTP status ${options.status ?? 'unknown'}`;
    case 'UPSTREAM_ERROR':
      return `Pippit ${options.operation} was rejected by the upstream service`;
    case 'INVALID_RESPONSE':
      return `Pippit ${options.operation} returned an invalid response`;
  }
}

/**
 * Sanitized client error. It deliberately retains neither the response body,
 * the Authorization header, nor a fetch error cause.
 */
export class PippitApiError extends Error {
  readonly code: PippitErrorCode;
  readonly logId?: string;
  readonly operation: PippitOperation;
  readonly status?: number;
  readonly upstreamCode?: string | number;

  constructor(options: PippitApiErrorOptions) {
    super(buildMessage(options));
    this.name = 'PippitApiError';
    this.code = options.code;
    if (options.logId !== undefined) {
      this.logId = options.logId;
    }
    this.operation = options.operation;
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.upstreamCode !== undefined) {
      this.upstreamCode = options.upstreamCode;
    }
  }
}
