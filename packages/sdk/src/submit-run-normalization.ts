import { randomInt } from "node:crypto"
import {
  PIPPIT_PARTIAL_EDIT_USE_SOURCE_SEGMENT_DURATION_SEC,
  type PippitMediaReference,
  type PippitSubmitRunRequest,
  type PippitVideoPartToolParam,
  type PippitVideoSubmitRunRequest,
} from "./types.js"

const PIPPIT_DEFAULT_VIDEO_DURATION_SEC = 5
const PIPPIT_SEEDANCE_2_5_DEFAULT_VIDEO_DURATION_SEC = 10
const PIPPIT_SEEDANCE_2_5_MODEL = "Seedance_2.5"
const PIPPIT_MAX_SEED_EXCLUSIVE = 2 ** 32
const PIPPIT_SEEDANCE_USER_INPUT_VIDEO_SECURITY_CHECK_SCENE =
  "pippit_seedance2_0_user_input_video"

function normalizeVideoReference<T extends PippitMediaReference>(reference: T): T {
  return {
    ...reference,
    security_check_scene: reference.security_check_scene ??
      [PIPPIT_SEEDANCE_USER_INPUT_VIDEO_SECURITY_CHECK_SCENE],
  }
}

function normalizeVideoPartToolParam(param: PippitVideoPartToolParam): PippitVideoPartToolParam {
  const isPartialEdit = param.partial_edit_videos !== undefined
  const isSeedance25 = param.model.trim() === PIPPIT_SEEDANCE_2_5_MODEL
  const normalized: PippitVideoPartToolParam = {
    ...param,
    duration_sec: isPartialEdit
      ? PIPPIT_PARTIAL_EDIT_USE_SOURCE_SEGMENT_DURATION_SEC
      : param.duration_sec ?? (
          isSeedance25
            ? PIPPIT_SEEDANCE_2_5_DEFAULT_VIDEO_DURATION_SEC
            : PIPPIT_DEFAULT_VIDEO_DURATION_SEC
        ),
    ...(isPartialEdit ? { ratio: "adaptive", videos: [] } : {}),
    ...(!isPartialEdit && param.videos !== undefined
      ? { videos: param.videos.map(normalizeVideoReference) }
      : {}),
    ...(param.partial_edit_videos === undefined
      ? {}
      : {
          partial_edit_videos: param.partial_edit_videos.map(normalizeVideoReference),
        }),
  }

  if (!isSeedance25) return normalized

  normalized.audios = param.audios ?? []
  normalized.images = param.images ?? []
  normalized.imitation_videos = param.imitation_videos ?? []
  normalized.language = param.language ?? "zh"
  normalized.seed = param.seed ?? randomInt(0, PIPPIT_MAX_SEED_EXCLUSIVE)
  normalized.videos = isPartialEdit ? [] : (param.videos ?? []).map(normalizeVideoReference)
  if (isPartialEdit) {
    delete normalized.task_type
  } else {
    normalized.task_type = param.task_type ?? "reference"
  }
  return normalized
}

function collectTopLevelPippitAssetIds(
  explicitAssetIds: readonly string[],
  param: PippitVideoPartToolParam,
): string[] {
  // /skill/submit_run resolves top-level asset_ids through the Pippit asset
  // library before hydrating the linked EverPhoto records. The nested
  // asset_id is the distinct EverPhoto/cloud ID used by the video engine, so
  // copying it into this top-level list makes material hydration fail.
  const assetIds = new Set(explicitAssetIds)
  for (const references of [
    param.images,
    param.imitation_videos,
    param.videos,
    param.audios,
    param.partial_edit_videos,
  ]) {
    for (const reference of references ?? []) {
      assetIds.add(reference.pippit_asset_id)
    }
  }
  return [...assetIds]
}

export function normalizeSubmitRunRequest(request: PippitSubmitRunRequest): PippitSubmitRunRequest {
  if ("general_agent_settings" in request) return request
  const videoPartToolParam = normalizeVideoPartToolParam(request.video_part_tool_param)
  const videoRequest: PippitVideoSubmitRunRequest = {
    ...request,
    asset_ids: collectTopLevelPippitAssetIds(request.asset_ids, videoPartToolParam),
    video_part_tool_param: videoPartToolParam,
  }
  return videoRequest
}
