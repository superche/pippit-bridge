import { IMAGE_MODELS, VIDEO_MODELS } from "@pippit-bridge/core"

export function presentGeneralVideoModel(model: (typeof VIDEO_MODELS)[number]): Record<string, unknown> {
  return {
    architecture: {
      input_modalities: ["text", "image", "video", "audio"],
      instruct_type: null,
      modality: "text+image+video+audio->video",
      output_modalities: ["video"],
      tokenizer: "Other",
    },
    canonical_slug: model.canonical_slug,
    context_length: 0,
    created: model.created,
    default_parameters: null,
    description: model.description,
    expiration_date: null,
    id: model.id,
    knowledge_cutoff: null,
    links: { details: "/api/v1/videos/models" },
    name: model.name,
    per_request_limits: null,
    pricing: { completion: "0", image: "0", prompt: "0", request: "0" },
    supported_parameters: [
      "prompt",
      "duration",
      "resolution",
      "aspect_ratio",
      "frame_images",
      "input_references",
      "seed",
      "provider",
    ],
    supported_voices: null,
    top_provider: { context_length: 0, is_moderated: true, max_completion_tokens: 0 },
  }
}

export function presentGeneralImageModel(model: (typeof IMAGE_MODELS)[number]): Record<string, unknown> {
  return {
    architecture: {
      input_modalities: [...model.architecture.input_modalities],
      instruct_type: null,
      modality: "text+image->image",
      output_modalities: ["image"],
      tokenizer: "Other",
    },
    canonical_slug: model.canonical_slug,
    context_length: 0,
    created: model.created,
    default_parameters: null,
    description: model.description,
    expiration_date: null,
    id: model.id,
    knowledge_cutoff: null,
    links: { details: "/api/v1/images/models" },
    name: model.name,
    per_request_limits: null,
    pricing: { completion: "0", image: "0", prompt: "0", request: "0" },
    supported_parameters: ["prompt", ...Object.keys(model.supported_parameters), "provider"],
    supported_voices: null,
    top_provider: { context_length: 0, is_moderated: true, max_completion_tokens: 0 },
  }
}
