export const OPENAPI_VIDEO_SCHEMAS = {
  FrameImage: {
    additionalProperties: false,
    properties: {
      frame_type: { enum: ["first_frame", "last_frame"], type: "string" },
      image_url: {
        additionalProperties: false,
        properties: { url: { format: "uri", pattern: "^https?://", type: "string" } },
        required: ["url"],
        type: "object",
      },
      type: { const: "image_url" },
    },
    required: ["type", "image_url", "frame_type"],
    type: "object",
  },
  ImageReference: {
    additionalProperties: false,
    properties: {
      image_url: { properties: { url: { format: "uri", pattern: "^https?://", type: "string" } }, required: ["url"], type: "object" },
      type: { const: "image_url" },
    },
    required: ["type", "image_url"],
    type: "object",
  },
  AudioReference: {
    additionalProperties: false,
    properties: {
      audio_url: { properties: { url: { format: "uri", pattern: "^https?://", type: "string" } }, required: ["url"], type: "object" },
      type: { const: "audio_url" },
    },
    required: ["type", "audio_url"],
    type: "object",
  },
  VideoReference: {
    additionalProperties: false,
    properties: {
      type: { const: "video_url" },
      video_url: { properties: { url: { format: "uri", pattern: "^https?://", type: "string" } }, required: ["url"], type: "object" },
    },
    required: ["type", "video_url"],
    type: "object",
  },
  VideoEditAnnotation: {
    additionalProperties: false,
    description: "A normalized region instruction whose timestamp must fall inside the requested segment.",
    properties: {
      at_ms: { minimum: 0, type: "integer" },
      instruction: { maxLength: 2000, minLength: 1, type: "string" },
      region: { $ref: "#/components/schemas/VideoEditRegion" },
    },
    required: ["at_ms", "region", "instruction"],
    type: "object",
  },
  VideoEditRegion: {
    additionalProperties: false,
    description:
      "Normalized edit-guidance region. Runtime validation also requires x + width <= 1 and y + height <= 1.",
    properties: {
      height: { exclusiveMinimum: 0, maximum: 1, type: "number" },
      width: { exclusiveMinimum: 0, maximum: 1, type: "number" },
      x: { maximum: 1, minimum: 0, type: "number" },
      y: { maximum: 1, minimum: 0, type: "number" },
    },
    required: ["x", "y", "width", "height"],
    type: "object",
  },
  VideoEditRequest: {
    additionalProperties: false,
    anyOf: [
      { required: ["prompt"] },
      {
        properties: { annotations: { minItems: 1 } },
        required: ["annotations"],
      },
    ],
    properties: {
      annotations: {
        default: [],
        items: { $ref: "#/components/schemas/VideoEditAnnotation" },
        maxItems: 20,
        type: "array",
      },
      model: { maxLength: 256, minLength: 1, type: "string" },
      prompt: {
        description: "Overall regeneration instruction. The compiled prompt, including annotations, may not exceed 20000 characters.",
        maxLength: 20000,
        minLength: 1,
        type: "string",
      },
      provider: {
        additionalProperties: false,
        description: "OpenRouter-style provider options; pippit.byok_id explicitly overrides caller active selection.",
        properties: {
          options: {
            additionalProperties: { additionalProperties: true, type: "object" },
            properties: {
              pippit: {
                additionalProperties: false,
                properties: {
                  byok_id: { format: "uuid", type: "string" },
                  thread_id: { minLength: 1, type: "string" },
                },
                type: "object",
              },
            },
            type: "object",
          },
        },
        type: "object",
      },
      resolution: { maxLength: 64, minLength: 1, type: "string" },
      seed: { maximum: 4294967295, minimum: -1, type: "integer" },
      segment: { $ref: "#/components/schemas/VideoEditSegment" },
      source_index: { default: 0, maximum: 1000, minimum: 0, type: "integer" },
      source_job_id: {
        description: "Completed job id issued to the same facade API key as this edit request.",
        maxLength: 16384,
        minLength: 1,
        type: "string",
      },
    },
    required: ["model", "segment", "source_job_id"],
    type: "object",
  },
  VideoEditSegment: {
    additionalProperties: false,
    description:
      "Instruction segment in the source timeline. end_ms must be greater than start_ms and their difference may not exceed 30000 ms.",
    properties: {
      end_ms: { minimum: 1, type: "integer" },
      start_ms: { minimum: 0, type: "integer" },
    },
    required: ["start_ms", "end_ms"],
    type: "object",
  },
  VideoGenerationJob: {
    properties: {
      error: { type: "string" },
      generation_id: { type: ["string", "null"] },
      id: { type: "string" },
      model: { type: ["string", "null"] },
      polling_url: { type: "string" },
      status: {
        enum: ["pending", "in_progress", "completed", "failed", "cancelled", "expired"],
        type: "string",
      },
      unsigned_urls: { items: { type: "string" }, type: "array" },
      usage: {
        properties: { cost: { type: ["number", "null"] }, is_byok: { type: "boolean" } },
        type: "object",
      },
    },
    required: ["id", "polling_url", "status"],
    type: "object",
  },
  VideoGenerationRequest: {
    additionalProperties: false,
    properties: {
      aspect_ratio: { type: "string" },
      callback_url: {
        deprecated: true,
        description: "Present in OpenRouter, but rejected because the Pippit API only documents polling.",
        format: "uri",
        type: "string",
      },
      duration: { maximum: 3600, minimum: 1, type: "integer" },
      frame_images: { items: { $ref: "#/components/schemas/FrameImage" }, maxItems: 2, type: "array" },
      generate_audio: {
        deprecated: true,
        description: "Rejected because the documented Pippit API does not expose this control.",
        type: "boolean",
      },
      input_references: {
        items: {
          oneOf: [
            { $ref: "#/components/schemas/ImageReference" },
            { $ref: "#/components/schemas/AudioReference" },
            { $ref: "#/components/schemas/VideoReference" },
          ],
        },
        maxItems: 15,
        type: "array",
      },
      model: { type: "string" },
      prompt: { maxLength: 20000, minLength: 1, type: "string" },
      provider: {
        additionalProperties: false,
        description:
          "OpenRouter-style provider options. The pippit option namespace is a facade extension.",
        properties: {
          options: {
            additionalProperties: { additionalProperties: true, type: "object" },
            properties: {
              pippit: {
                additionalProperties: false,
                description:
                  "Pippit-specific facade options. These fields are not part of the official OpenRouter video contract.",
                properties: {
                  byok_id: {
                    description:
                      "Select an eligible stored Pippit BYOK credential by id. The runtime caller must still use a facade API key.",
                    format: "uuid",
                    type: "string",
                  },
                  thread_id: {
                    description:
                      "Continue an existing Pippit thread. byok_id is required when more than one credential is eligible.",
                    minLength: 1,
                    type: "string",
                  },
                },
                type: "object",
              },
            },
            type: "object",
          },
        },
        type: "object",
      },
      resolution: { type: "string" },
      seed: { maximum: 4294967295, minimum: -1, type: "integer" },
      size: {
        deprecated: true,
        description: "Rejected because Pippit does not guarantee exact pixel dimensions; use resolution and aspect_ratio.",
        pattern: "^[1-9]\\d{1,4}x[1-9]\\d{1,4}$",
        type: "string",
      },
    },
    required: ["model", "prompt"],
    type: "object",
  },
  VideoModel: {
    properties: {
      allowed_passthrough_parameters: { items: { type: "string" }, type: "array" },
      canonical_slug: { type: "string" },
      created: { type: "integer" },
      description: { type: ["string", "null"] },
      generate_audio: { type: ["boolean", "null"] },
      id: { type: "string" },
      name: { type: "string" },
      pricing_skus: { type: ["object", "null"] },
      seed: { type: ["boolean", "null"] },
      supported_aspect_ratios: { type: ["array", "null"], items: { type: "string" } },
      supported_durations: { type: ["array", "null"], items: { type: "number" } },
      supported_frame_images: { type: ["array", "null"], items: { type: "string" } },
      supported_resolutions: { type: ["array", "null"], items: { type: "string" } },
      supported_sizes: { type: ["array", "null"], items: { type: "string" } },
    },
    required: [
      "id",
      "canonical_slug",
      "name",
      "created",
      "supported_resolutions",
      "supported_aspect_ratios",
      "supported_sizes",
      "supported_durations",
      "supported_frame_images",
      "generate_audio",
      "seed",
      "allowed_passthrough_parameters",
    ],
    type: "object",
  },
} as const
