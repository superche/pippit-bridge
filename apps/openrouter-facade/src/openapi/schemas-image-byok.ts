export const OPENAPI_IMAGE_BYOK_SCHEMAS = {
  ImageGenerationRequest: {
    additionalProperties: false,
    properties: {
      input_references: { items: { $ref: "#/components/schemas/ImageGenerationReference" }, maxItems: 9, type: "array" },
      model: { default: "pippit/seedream-5.0", enum: ["pippit/seedream-5.0", "pippit/seedream-5.0-pro"], type: "string" },
      n: { default: 1, maximum: 10, minimum: 1, type: "integer" },
      prompt: { maxLength: 20000, minLength: 1, type: "string" },
      provider: { $ref: "#/components/schemas/ProviderRouting" },
      resolution: { description: "Seedream 5.0 Pro only; omit for Seedream 5.0.", enum: ["1K", "2K", "4K"], type: "string" },
    },
    required: ["prompt"],
    type: "object",
  },
  ImageGenerationResponse: {
    additionalProperties: false,
    properties: {
      created: { minimum: 0, type: "integer" },
      data: {
        items: {
          additionalProperties: false,
          properties: {
            b64_json: { contentEncoding: "base64", type: "string" },
            media_type: { pattern: "^image/", type: "string" },
          },
          required: ["b64_json"],
          type: "object",
        },
        minItems: 1,
        type: "array",
      },
      model: { type: "string" },
      usage: {
        additionalProperties: false,
        properties: { cost: { type: ["number", "null"] }, is_byok: { const: true, type: "boolean" } },
        required: ["cost", "is_byok"],
        type: "object",
      },
    },
    required: ["created", "data", "model", "usage"],
    type: "object",
  },
  ImageGenerationReference: {
    additionalProperties: false,
    properties: {
      image_url: {
        additionalProperties: false,
        properties: {
          url: {
            description: "HTTP(S) image URL or supported base64 image data URL.",
            format: "uri",
            type: "string",
          },
        },
        required: ["url"],
        type: "object",
      },
      type: { const: "image_url" },
    },
    required: ["type", "image_url"],
    type: "object",
  },
  ImageModel: {
    additionalProperties: false,
    properties: {
      architecture: { type: "object" },
      canonical_slug: { type: "string" },
      created: { type: "number" },
      description: { type: "string" },
      endpoints: { type: "string" },
      id: { type: "string" },
      name: { type: "string" },
      supported_parameters: { type: "object" },
      supports_streaming: { const: false, type: "boolean" },
    },
    required: ["architecture", "canonical_slug", "created", "description", "endpoints", "id", "name", "supported_parameters", "supports_streaming"],
    type: "object",
  },
  ProviderRouting: {
    additionalProperties: false,
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
  ByokActiveSelection: {
    additionalProperties: false,
    description:
      "Persistent caller-scoped active credential metadata. Integrations should not expose facade_api_key_hash to end users.",
    properties: {
      credential_id: { format: "uuid", type: "string" },
      facade_api_key_hash: { pattern: "^[a-f0-9]{64}$", type: "string" },
      updated_at: { format: "date-time", type: "string" },
    },
    required: ["credential_id", "facade_api_key_hash", "updated_at"],
    type: "object",
  },
  ByokActiveSelectionEnvelope: {
    additionalProperties: false,
    properties: { data: { $ref: "#/components/schemas/ByokActiveSelection" } },
    required: ["data"],
    type: "object",
  },
  ByokActiveSelectionNullableEnvelope: {
    additionalProperties: false,
    properties: {
      data: {
        anyOf: [
          { $ref: "#/components/schemas/ByokActiveSelection" },
          { type: "null" },
        ],
      },
    },
    required: ["data"],
    type: "object",
  },
  ByokActiveSelectionUpdate: {
    additionalProperties: false,
    properties: {
      credential_id: { format: "uuid", type: "string" },
      facade_api_key_hash: { pattern: "^[a-f0-9]{64}$", type: "string" },
    },
    required: ["credential_id", "facade_api_key_hash"],
    type: "object",
  },
  ByokApiKeyHashes: {
    description:
      "Optional facade extension restricting this credential to runtime facade API keys identified by lowercase SHA-256 hashes.",
    items: { pattern: "^[a-f0-9]{64}$", type: "string" },
    maxItems: 100,
    type: ["array", "null"],
    uniqueItems: true,
  },
  ByokCredential: {
    additionalProperties: false,
    description:
      "Public BYOK credential metadata. This schema intentionally has no key, ciphertext, fingerprint, or key-version field.",
    properties: {
      allowed_api_key_hashes: { $ref: "#/components/schemas/ByokApiKeyHashes" },
      allowed_models: {
        items: { minLength: 1, type: "string" },
        maxItems: 100,
        type: ["array", "null"],
        uniqueItems: true,
      },
      allowed_user_ids: {
        items: { minLength: 1, type: "string" },
        maxItems: 100,
        type: ["array", "null"],
        uniqueItems: true,
      },
      created_at: { format: "date-time", readOnly: true, type: "string" },
      disabled: { type: "boolean" },
      id: { format: "uuid", readOnly: true, type: "string" },
      is_fallback: { type: "boolean" },
      label: {
        description: "Masked display label derived from the Pippit AK; never the raw key.",
        readOnly: true,
        type: "string",
      },
      name: { type: ["string", "null"] },
      provider: {
        const: "pippit",
        description:
          "Facade extension. pippit is not part of OpenRouter's official provider enum.",
        type: "string",
      },
      sort_order: { minimum: 0, readOnly: true, type: "integer" },
      workspace_id: { format: "uuid", type: "string" },
    },
    required: [
      "allowed_api_key_hashes",
      "allowed_models",
      "allowed_user_ids",
      "created_at",
      "disabled",
      "id",
      "is_fallback",
      "label",
      "name",
      "provider",
      "sort_order",
      "workspace_id",
    ],
    type: "object",
  },
  ByokCredentialCreate: {
    additionalProperties: false,
    properties: {
      allowed_api_key_hashes: { $ref: "#/components/schemas/ByokApiKeyHashes" },
      allowed_models: {
        default: null,
        items: { maxLength: 256, minLength: 1, type: "string" },
        maxItems: 100,
        type: ["array", "null"],
        uniqueItems: true,
      },
      allowed_user_ids: {
        default: null,
        items: { maxLength: 256, minLength: 1, type: "string" },
        maxItems: 100,
        type: ["array", "null"],
        uniqueItems: true,
      },
      disabled: { default: false, type: "boolean" },
      is_fallback: { default: false, type: "boolean" },
      key: {
        description: "Pippit AK issued by Pippit. Accepted only on the management API and never returned.",
        maxLength: 4096,
        minLength: 1,
        pattern: "^[\\x21-\\x7e]+$",
        type: "string",
        writeOnly: true,
      },
      name: { default: null, maxLength: 128, minLength: 1, type: ["string", "null"] },
      provider: {
        const: "pippit",
        description:
          "Required facade extension. pippit is not part of OpenRouter's official provider enum.",
        type: "string",
      },
      workspace_id: {
        default: "00000000-0000-0000-0000-000000000000",
        format: "uuid",
        type: "string",
      },
    },
    required: ["key", "provider"],
    type: "object",
  },
  ByokCredentialDelete: {
    additionalProperties: false,
    properties: { deleted: { const: true, type: "boolean" } },
    required: ["deleted"],
    type: "object",
  },
  ByokCredentialEnvelope: {
    additionalProperties: false,
    properties: { data: { $ref: "#/components/schemas/ByokCredential" } },
    required: ["data"],
    type: "object",
  },
  ByokCredentialList: {
    additionalProperties: false,
    properties: {
      data: { items: { $ref: "#/components/schemas/ByokCredential" }, type: "array" },
      total_count: { minimum: 0, type: "integer" },
    },
    required: ["data", "total_count"],
    type: "object",
  },
  ByokCredentialUpdate: {
    additionalProperties: false,
    minProperties: 1,
    properties: {
      allowed_api_key_hashes: { $ref: "#/components/schemas/ByokApiKeyHashes" },
      allowed_models: {
        items: { maxLength: 256, minLength: 1, type: "string" },
        maxItems: 100,
        type: ["array", "null"],
        uniqueItems: true,
      },
      allowed_user_ids: {
        items: { maxLength: 256, minLength: 1, type: "string" },
        maxItems: 100,
        type: ["array", "null"],
        uniqueItems: true,
      },
      disabled: { type: "boolean" },
      is_fallback: { type: "boolean" },
      key: {
        description: "Replacement Pippit AK. Accepted only on the management API and never returned.",
        maxLength: 4096,
        minLength: 1,
        pattern: "^[\\x21-\\x7e]+$",
        type: "string",
        writeOnly: true,
      },
      name: { maxLength: 128, minLength: 1, type: ["string", "null"] },
    },
    type: "object",
  },
  ErrorResponse: {
    properties: {
      error: {
        properties: {
          code: { type: "integer" },
          message: { type: "string" },
          metadata: { additionalProperties: true, type: "object" },
          param: { type: ["string", "null"] },
          type: { type: "string" },
        },
        required: ["code", "message", "param", "type"],
        type: "object",
      },
    },
    required: ["error"],
    type: "object",
  },
} as const
