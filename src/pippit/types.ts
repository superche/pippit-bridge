export const PIPPIT_VIDEO_AGENT_NAME = 'pippit_video_part_agent' as const;

export const PIPPIT_RUN_STATES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export type PippitRunState = (typeof PIPPIT_RUN_STATES)[number];

export interface UploadedFileInput {
  bytes: Uint8Array;
  filename: string;
  mediaType: string;
}

/**
 * Media references accepted by the video-part tool. Callers should prefer the
 * pippit_asset_id returned by uploadFile over transient URLs.
 */
export interface PippitMediaReference {
  asset_id?: string;
  pippit_asset_id: string;
  url?: string;
  security_check_scene?: string[];
}

export interface PippitVideoPartToolParam {
  model: string;
  duration_sec: number;
  prompt: string;
  ratio?: string;
  resolution?: string;
  generate_type?: 0 | 1;
  seed?: number;
  images?: PippitMediaReference[];
  videos?: PippitMediaReference[];
  audios?: PippitMediaReference[];
}

/** The documented request body, excluding the fixed agent_name field. */
export interface PippitSubmitRunRequest {
  message: string;
  asset_ids: string[];
  video_part_tool_param: PippitVideoPartToolParam;
  thread_id?: string;
}

export interface PippitRun {
  runId: string;
  threadId: string;
  state: PippitRunState;
}

export interface PippitUploadResult {
  assetId: string;
}

export interface PippitSubmitRunResult {
  run: PippitRun;
  webThreadLink?: string;
}

export interface PippitFailReasonObject {
  code?: number;
  message?: string;
  extra?: Record<string, string>;
  is_not_retryable?: boolean;
  starling_key?: string;
  payload?: string;
  fallback_message?: string;
  detail?: string;
}

export type PippitFailReason = string | PippitFailReasonObject;

export interface PippitVideoResult {
  runState: PippitRunState;
  videoUrls: string[];
  imageUrls: string[];
  failReason?: PippitFailReason;
}

export interface PippitRequestOptions {
  accessKey: string;
  signal?: AbortSignal;
}

export interface UploadFileInput extends PippitRequestOptions {
  file: UploadedFileInput;
}

export interface SubmitRunInput extends PippitRequestOptions {
  request: PippitSubmitRunRequest;
}

export interface QueryVideoResultInput extends PippitRequestOptions {
  threadId: string;
  runId: string;
}

export interface PippitApi {
  uploadFile(input: UploadFileInput): Promise<PippitUploadResult>;
  submitRun(input: SubmitRunInput): Promise<PippitSubmitRunResult>;
  queryVideoResult(input: QueryVideoResultInput): Promise<PippitVideoResult>;
}

export type PippitFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface PippitClientConfig {
  baseUrl?: string;
  fetchImpl?: PippitFetch;
  timeoutMs?: number;
}
