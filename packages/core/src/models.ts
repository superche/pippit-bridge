export class UnknownVideoModelError extends Error {
  readonly modelId: string

  constructor(modelId: string) {
    super(`Unknown video model: ${modelId}`)
    this.name = "UnknownVideoModelError"
    this.modelId = modelId
  }
}

export class UnknownImageModelError extends Error {
  readonly modelId: string

  constructor(modelId: string) {
    super(`Unknown image model: ${modelId}`)
    this.name = "UnknownImageModelError"
    this.modelId = modelId
  }
}

export interface ImageModelDefinition {
  readonly architecture: {
    readonly input_modalities: readonly ("text" | "image")[]
    readonly output_modalities: readonly ["image"]
  }
  readonly canonical_slug: string
  readonly created: number
  readonly description: string
  readonly endpoints: string
  readonly id: string
  readonly name: string
  readonly supported_parameters: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly supports_streaming: false
  readonly upstreamModel: "seedream_5.0" | "seedream_5.0_pro"
}

const imageCommon = {
  architecture: {
    input_modalities: ["text", "image"] as const,
    output_modalities: ["image"] as const,
  },
  created: 0,
  supports_streaming: false as const,
}

export const IMAGE_MODELS: readonly ImageModelDefinition[] = [
  {
    ...imageCommon,
    canonical_slug: "pippit/seedream-5.0",
    description: "Pippit Seedream 5.0 text-to-image and reference-image generation model.",
    endpoints: "/api/v1/images/models/pippit/seedream-5.0/endpoints",
    id: "pippit/seedream-5.0",
    name: "Pippit: Seedream 5.0",
    supported_parameters: {
      input_references: { type: "boolean" },
      n: { max: 10, min: 1, type: "range" },
    },
    upstreamModel: "seedream_5.0",
  },
  {
    ...imageCommon,
    canonical_slug: "pippit/seedream-5.0-pro",
    description: "Pippit Seedream 5.0 Pro text-to-image and reference-image generation model with selectable resolution.",
    endpoints: "/api/v1/images/models/pippit/seedream-5.0-pro/endpoints",
    id: "pippit/seedream-5.0-pro",
    name: "Pippit: Seedream 5.0 Pro",
    supported_parameters: {
      input_references: { type: "boolean" },
      n: { max: 10, min: 1, type: "range" },
      resolution: { type: "enum", values: ["1K", "2K", "4K"] },
    },
    upstreamModel: "seedream_5.0_pro",
  },
]

const imageAliases = new Map<string, ImageModelDefinition>()
for (const model of IMAGE_MODELS) {
  imageAliases.set(model.id, model)
  imageAliases.set(model.upstreamModel, model)
}

export function resolveImageModel(modelId: string): ImageModelDefinition {
  const model = imageAliases.get(modelId)
  if (!model) throw new UnknownImageModelError(modelId)
  return model
}

export function publicImageModel(model: ImageModelDefinition): Omit<ImageModelDefinition, "upstreamModel"> {
  const { upstreamModel: _upstreamModel, ...result } = model
  return result
}

export interface VideoModelDefinition {
  readonly allowed_passthrough_parameters: readonly string[]
  readonly canonical_slug: string
  readonly created: number
  readonly description: string
  readonly generate_audio: boolean | null
  readonly id: string
  readonly name: string
  readonly pricing_skus: null
  readonly seed: boolean | null
  readonly supported_aspect_ratios: readonly string[] | null
  readonly supported_durations: readonly number[] | null
  readonly supported_frame_images: readonly ("first_frame" | "last_frame")[] | null
  readonly supported_resolutions: readonly string[] | null
  readonly supported_sizes: readonly string[] | null
  readonly upstreamModel: string
}

const common = {
  allowed_passthrough_parameters: ["thread_id"] as const,
  created: 0,
  generate_audio: null,
  pricing_skus: null,
  seed: true,
  supported_aspect_ratios: ["16:9", "9:16", "4:3", "3:4", "1:1"] as const,
  supported_durations: null,
  supported_frame_images: ["first_frame", "last_frame"] as const,
  supported_sizes: null,
}

export const VIDEO_MODELS: readonly VideoModelDefinition[] = [
  {
    ...common,
    canonical_slug: "pippit/seedance-2.0-fast",
    description:
      "Pippit Seedance 2.0 Fast immersive-video model. Supports uploaded image, video, and audio references.",
    id: "pippit/seedance-2.0-fast",
    name: "Pippit: Seedance 2.0 Fast",
    supported_resolutions: ["480p", "720p"],
    upstreamModel: "seedance2.0_fast_vision",
  },
  {
    ...common,
    canonical_slug: "pippit/seedance-2.0",
    description:
      "Pippit Seedance 2.0 immersive-video model. Supports uploaded image, video, and audio references.",
    id: "pippit/seedance-2.0",
    name: "Pippit: Seedance 2.0",
    supported_resolutions: ["480p", "720p", "1080p"],
    upstreamModel: "seedance2.0_vision",
  },
  {
    ...common,
    canonical_slug: "pippit/seedance-2.0-mini",
    description:
      "Pippit Seedance 2.0 Mini immersive-video model. Supports uploaded image, video, and audio references.",
    id: "pippit/seedance-2.0-mini",
    name: "Pippit: Seedance 2.0 Mini",
    supported_resolutions: ["480p", "720p"],
    upstreamModel: "Seedance_2.0_mini",
  },
  {
    ...common,
    canonical_slug: "pippit/seedance-2.0-mini-lite",
    description:
      "Pippit Seedance 2.0 Mini Lite immersive-video model. Supports uploaded image, video, and audio references.",
    id: "pippit/seedance-2.0-mini-lite",
    name: "Pippit: Seedance 2.0 Mini Lite",
    supported_resolutions: ["480p", "720p"],
    upstreamModel: "Seedance_2.0_mini_lite",
  },
]

const aliases = new Map<string, VideoModelDefinition>()
for (const model of VIDEO_MODELS) {
  aliases.set(model.id, model)
  aliases.set(model.upstreamModel, model)
}

export function resolveVideoModel(modelId: string): VideoModelDefinition {
  const model = aliases.get(modelId)
  if (!model) {
    throw new UnknownVideoModelError(modelId)
  }
  return model
}

export function publicVideoModel(model: VideoModelDefinition): Omit<VideoModelDefinition, "upstreamModel"> {
  const { upstreamModel: _upstreamModel, ...result } = model
  return result
}
