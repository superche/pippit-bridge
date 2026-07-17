import { invalidRequest } from "../errors.js"
import type { VideoGenerationStatus } from "./contracts.js"
import type { VideoModelDefinition } from "./models.js"

export interface OutputGeometry {
  readonly aspectRatio?: string
  readonly resolution?: string
}

export function resolveOutputGeometry(
  request: {
    readonly aspect_ratio?: string | undefined
    readonly resolution?: string | undefined
    readonly size?: string | undefined
  },
  model: VideoModelDefinition,
): OutputGeometry {
  if (request.size !== undefined) {
    throw invalidRequest(
      "size is not supported because Pippit only guarantees ratio and resolution, not exact pixel dimensions.",
      "size",
      "unsupported_parameter",
    )
  }
  const aspectRatio = request.aspect_ratio
  const resolution = request.resolution
  if (aspectRatio && !model.supported_aspect_ratios?.includes(aspectRatio)) {
    throw invalidRequest(`Model ${model.id} does not support aspect ratio ${aspectRatio}`, "aspect_ratio", "unsupported_parameter")
  }
  if (resolution && !model.supported_resolutions?.includes(resolution)) {
    throw invalidRequest(`Model ${model.id} does not support resolution ${resolution}`, "resolution", "unsupported_parameter")
  }

  return {
    ...(aspectRatio === undefined ? {} : { aspectRatio }),
    ...(resolution === undefined ? {} : { resolution }),
  }
}

export function pippitStateToOpenRouterStatus(state: number): VideoGenerationStatus {
  switch (state) {
    case 1:
      return "pending"
    case 2:
    case 7:
      return "in_progress"
    case 3:
      return "completed"
    case 4:
      return "failed"
    case 5:
      return "cancelled"
    case 6:
    case 8:
    case 9:
    case 0:
      return "failed"
    default:
      return "failed"
  }
}
