export const PIPPIT_VIDEO_AGENT_NAME = "pippit_video_part_agent" as const
export const PIPPIT_IMAGE_AGENT_NAME = "pippit_nest_agent" as const
export const PIPPIT_PARTIAL_EDIT_USE_SOURCE_SEGMENT_DURATION_SEC = -1 as const

export const PIPPIT_RUN_STATES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export type PippitRunState = (typeof PIPPIT_RUN_STATES)[number];

export interface UploadedFileInput {
  bytes: Uint8Array;
  filename: string;
  mediaType: string;
}

/** Media references accepted by the video-part tool. */
export interface PippitMediaReference {
  /**
   * EverPhoto/cloud-media asset ID consumed by the video engine.
   * This is a different identifier from pippit_asset_id and the values are not
   * interchangeable.
   */
  asset_id?: string;
  /**
   * Pippit asset-library ID used for ownership and material hydration.
   * This is a different identifier from asset_id and the values are not
   * interchangeable.
   */
  pippit_asset_id: string;
  url?: string;
  security_check_scene?: string[];
}

export interface PippitVideoTimeRange {
  end_time_us: number;
  start_time_us: number;
}

export interface PippitPartialEditVideoReference extends PippitMediaReference {
  asset_id: string;
  time_range: PippitVideoTimeRange;
}

export interface PippitVideoPartToolParam {
  model: string;
  /**
   * Requested output duration. Native partial edits are normalized by the SDK
   * to the provider's source-segment sentinel.
   */
  duration_sec?: number;
  prompt: string;
  language?: string;
  ratio?: string;
  resolution?: string;
  generate_type?: 0 | 1;
  seed?: number;
  images?: PippitMediaReference[];
  imitation_videos?: PippitMediaReference[];
  videos?: PippitMediaReference[];
  audios?: PippitMediaReference[];
  partial_edit_videos?: PippitPartialEditVideoReference[];
  /** Advanced override; ordinary Seedance 2.5 requests default to reference. */
  task_type?: "reference";
}

/** The documented request body, excluding the fixed agent_name field. */
export interface PippitVideoSubmitRunRequest {
  message: string;
  /**
   * Pippit asset-library IDs used by /skill/submit_run to hydrate referenced
   * media. The SDK derives these from media pippit_asset_id values; they are
   * distinct from EverPhoto/cloud-media asset_id values.
   */
  asset_ids: string[];
  video_part_tool_param: PippitVideoPartToolParam;
  thread_id?: string;
}

export type PippitImageModel = "seedream_5.0" | "seedream_5.0_pro"
export type PippitImageResolution = "1K" | "2K" | "4K"

export interface PippitGeneralAgentSettings {
  image_model: PippitImageModel
  generate_image_count?: number
  resolution?: PippitImageResolution
}

export interface PippitImageSubmitRunRequest {
  message: string
  asset_ids?: string[]
  general_agent_settings: PippitGeneralAgentSettings
  thread_id?: string
}

export type PippitSubmitRunRequest = PippitVideoSubmitRunRequest | PippitImageSubmitRunRequest

export interface PippitRun {
  runId: string;
  threadId: string;
  state: PippitRunState;
}

export interface PippitUploadResult {
  /**
   * @deprecated Alias of pippit_asset_id retained for SDK compatibility. This
   * is not the EverPhoto/cloud-media asset_id.
   */
  assetId: string;
  /**
   * EverPhoto/cloud-media asset ID consumed by the video engine. Distinct from
   * pippit_asset_id.
   */
  asset_id?: string;
  /**
   * Pippit asset-library ID used for ownership and material hydration. Distinct
   * from asset_id.
   */
  pippit_asset_id: string;
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

export interface PippitVideoAsset extends PippitMediaReference {
  asset_id: string;
  url: string;
}

export type PippitGenerationResult = PippitVideoResult

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

export interface GetVideoAssetsInput extends PippitRequestOptions {
  threadId: string;
  runId: string;
}

export interface PippitApi {
  getVideoAssets(input: GetVideoAssetsInput): Promise<readonly PippitVideoAsset[]>;
  uploadFile(input: UploadFileInput): Promise<PippitUploadResult>;
  submitRun(input: SubmitRunInput): Promise<PippitSubmitRunResult>;
  queryVideoResult(input: QueryVideoResultInput): Promise<PippitVideoResult>;
}

export type PippitFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface PippitDiagnosticEvent {
  readonly duration_ms?: number;
  readonly event: 'upstream_request_started' | 'upstream_response_received' | 'upstream_request_failed';
  readonly http_status?: number;
  readonly operation: 'get_thread' | 'upload_file' | 'submit_run' | 'query_generate_video_result';
  readonly params?: Readonly<Record<string, boolean | number | string>>;
  readonly path: string;
  readonly request_id: string;
  readonly timestamp: string;
  readonly upstream_code?: string | number;
  readonly upstream_log_id?: string;
  readonly upstream_message?: string;
  readonly error_code?: string;
}

export type PippitDiagnosticSink = (event: PippitDiagnosticEvent) => Promise<void> | void;

export interface PippitClientConfig {
  baseUrl?: string;
  diagnostics?: PippitDiagnosticSink;
  fetchImpl?: PippitFetch;
  timeoutMs?: number;
}
