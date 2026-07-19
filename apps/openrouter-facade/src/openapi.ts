export const OPENAPI_DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "Pippit Bridge",
    version: "0.1.0",
    description:
      "An OpenRouter-compatible asynchronous video API backed by Pippit's immersive short-film generation API. BYOK management follows OpenRouter's management-key boundary; provider=pippit and video generation are explicit extensions of the OpenRouter surface.",
  },
  externalDocs: {
    description: "OpenRouter BYOK documentation",
    url: "https://openrouter.ai/docs/guides/overview/auth/byok",
  },
  tags: [
    { name: "BYOK", description: "Manage encrypted Pippit credentials with a management API key." },
    { name: "Models" },
    { name: "Videos" },
  ],
  paths: {
    "/api/v1/byok": {
      get: {
        operationId: "listByokKeys",
        parameters: [
          { $ref: "#/components/parameters/OptionalFacadeApiKeyHash" },
          {
            in: "query",
            name: "provider",
            required: false,
            schema: { const: "pippit", type: "string" },
            description:
              "Filter by provider. pippit is a facade extension and is not part of OpenRouter's official provider enum.",
          },
          {
            in: "query",
            name: "workspace_id",
            required: false,
            schema: { format: "uuid", type: "string" },
          },
          {
            in: "query",
            name: "offset",
            required: false,
            schema: { default: 0, minimum: 0, type: "integer" },
          },
          {
            in: "query",
            name: "limit",
            required: false,
            schema: { default: 100, maximum: 100, minimum: 1, type: "integer" },
          },
        ],
        responses: {
          "200": {
            content: { "application/json": { schema: { $ref: "#/components/schemas/ByokCredentialList" } } },
            description: "Stored BYOK credentials. Raw and encrypted key material are never returned.",
            headers: { "Cache-Control": { $ref: "#/components/headers/NoStore" } },
          },
          "400": { $ref: "#/components/responses/Error" },
          "401": { $ref: "#/components/responses/Error" },
          "500": { $ref: "#/components/responses/Error" },
        },
        security: [{ managementBearer: [] }],
        summary: "List BYOK credentials",
        tags: ["BYOK"],
      },
      post: {
        operationId: "createByokKey",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ByokCredentialCreate" },
            },
          },
          required: true,
        },
        responses: {
          "201": {
            content: { "application/json": { schema: { $ref: "#/components/schemas/ByokCredentialEnvelope" } } },
            description: "BYOK credential created. The submitted key is write-only.",
            headers: { "Cache-Control": { $ref: "#/components/headers/NoStore" } },
          },
          "400": { $ref: "#/components/responses/Error" },
          "401": { $ref: "#/components/responses/Error" },
          "409": { $ref: "#/components/responses/Error" },
          "500": { $ref: "#/components/responses/Error" },
        },
        security: [{ managementBearer: [] }],
        summary: "Create a BYOK credential",
        tags: ["BYOK"],
      },
    },
    "/api/v1/byok/active": {
      get: {
        operationId: "getActiveByokKey",
        parameters: [{ $ref: "#/components/parameters/FacadeApiKeyHash" }],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ByokActiveSelectionNullableEnvelope" },
              },
            },
            description: "The active credential selection for this facade API key hash, if configured.",
            headers: { "Cache-Control": { $ref: "#/components/headers/NoStore" } },
          },
          "400": { $ref: "#/components/responses/Error" },
          "401": { $ref: "#/components/responses/Error" },
          "500": { $ref: "#/components/responses/Error" },
        },
        security: [{ managementBearer: [] }],
        summary: "Get the active BYOK credential for a facade caller",
        tags: ["BYOK"],
      },
      put: {
        operationId: "setActiveByokKey",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ByokActiveSelectionUpdate" },
            },
          },
          required: true,
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ByokActiveSelectionEnvelope" },
              },
            },
            description: "The caller now resolves only through the selected eligible credential.",
            headers: { "Cache-Control": { $ref: "#/components/headers/NoStore" } },
          },
          "400": { $ref: "#/components/responses/Error" },
          "401": { $ref: "#/components/responses/Error" },
          "404": { $ref: "#/components/responses/Error" },
          "409": { $ref: "#/components/responses/Error" },
          "500": { $ref: "#/components/responses/Error" },
        },
        security: [{ managementBearer: [] }],
        summary: "Switch the active BYOK credential for a facade caller",
        tags: ["BYOK"],
      },
    },
    "/api/v1/byok/{id}": {
      delete: {
        operationId: "deleteByokKey",
        parameters: [
          { $ref: "#/components/parameters/ByokCredentialId" },
          { $ref: "#/components/parameters/OptionalFacadeApiKeyHash" },
        ],
        responses: {
          "200": {
            content: { "application/json": { schema: { $ref: "#/components/schemas/ByokCredentialDelete" } } },
            description: "BYOK credential deleted",
            headers: { "Cache-Control": { $ref: "#/components/headers/NoStore" } },
          },
          "401": { $ref: "#/components/responses/Error" },
          "404": { $ref: "#/components/responses/Error" },
          "409": { $ref: "#/components/responses/Error" },
          "500": { $ref: "#/components/responses/Error" },
        },
        security: [{ managementBearer: [] }],
        summary: "Delete a BYOK credential",
        tags: ["BYOK"],
      },
      get: {
        operationId: "getByokKey",
        parameters: [{ $ref: "#/components/parameters/ByokCredentialId" }],
        responses: {
          "200": {
            content: { "application/json": { schema: { $ref: "#/components/schemas/ByokCredentialEnvelope" } } },
            description: "Stored BYOK credential metadata. Raw and encrypted key material are never returned.",
            headers: { "Cache-Control": { $ref: "#/components/headers/NoStore" } },
          },
          "401": { $ref: "#/components/responses/Error" },
          "404": { $ref: "#/components/responses/Error" },
          "500": { $ref: "#/components/responses/Error" },
        },
        security: [{ managementBearer: [] }],
        summary: "Get a BYOK credential",
        tags: ["BYOK"],
      },
      patch: {
        operationId: "updateByokKey",
        parameters: [{ $ref: "#/components/parameters/ByokCredentialId" }],
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ByokCredentialUpdate" },
            },
          },
          required: true,
        },
        responses: {
          "200": {
            content: { "application/json": { schema: { $ref: "#/components/schemas/ByokCredentialEnvelope" } } },
            description: "BYOK credential updated. A replacement key is write-only.",
            headers: { "Cache-Control": { $ref: "#/components/headers/NoStore" } },
          },
          "400": { $ref: "#/components/responses/Error" },
          "401": { $ref: "#/components/responses/Error" },
          "404": { $ref: "#/components/responses/Error" },
          "500": { $ref: "#/components/responses/Error" },
        },
        security: [{ managementBearer: [] }],
        summary: "Update or rotate a BYOK credential",
        tags: ["BYOK"],
      },
    },
    "/api/v1/models": {
      get: {
        operationId: "listModels",
        responses: {
          "200": { description: "Models exposed by this facade" },
          "401": { $ref: "#/components/responses/Error" },
        },
        security: [{ runtimeBearer: [] }],
        summary: "List provider models",
        tags: ["Models"],
      },
    },
    "/api/v1/videos": {
      post: {
        operationId: "createVideo",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/VideoGenerationRequest" },
            },
          },
          required: true,
        },
        responses: {
          "202": {
            content: { "application/json": { schema: { $ref: "#/components/schemas/VideoGenerationJob" } } },
            description: "Video generation request accepted",
          },
          "400": { $ref: "#/components/responses/Error" },
          "401": { $ref: "#/components/responses/Error" },
          "502": { $ref: "#/components/responses/Error" },
          "503": { $ref: "#/components/responses/Error" },
          "504": { $ref: "#/components/responses/Error" },
        },
        security: [{ runtimeBearer: [] }],
        summary: "Submit a video generation request",
        tags: ["Videos"],
      },
    },
    "/api/v1/videos/edits": {
      post: {
        description:
          "Uses a completed facade job output as the only video reference and uploads it through the same safe reference loader as generation. Segment and normalized region values are provider instruction metadata; this endpoint does not byte-trim the source or apply a pixel mask.",
        operationId: "createVideoEdit",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/VideoEditRequest" },
            },
          },
          required: true,
        },
        responses: {
          "202": {
            content: { "application/json": { schema: { $ref: "#/components/schemas/VideoGenerationJob" } } },
            description: "Localized video edit request accepted",
          },
          "400": { $ref: "#/components/responses/Error" },
          "401": { $ref: "#/components/responses/Error" },
          "404": { $ref: "#/components/responses/Error" },
          "409": { $ref: "#/components/responses/Error" },
          "413": { $ref: "#/components/responses/Error" },
          "422": { $ref: "#/components/responses/Error" },
          "502": { $ref: "#/components/responses/Error" },
          "503": { $ref: "#/components/responses/Error" },
          "504": { $ref: "#/components/responses/Error" },
        },
        security: [{ runtimeBearer: [] }],
        summary: "Submit an instruction-based localized video edit",
        tags: ["Videos"],
      },
    },
    "/api/v1/videos/models": {
      get: {
        operationId: "listVideoModels",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  properties: {
                    data: { items: { $ref: "#/components/schemas/VideoModel" }, type: "array" },
                  },
                  required: ["data"],
                  type: "object",
                },
              },
            },
            description: "Video models and their capabilities",
          },
          "401": { $ref: "#/components/responses/Error" },
        },
        security: [{ runtimeBearer: [] }],
        summary: "List video generation models",
        tags: ["Models", "Videos"],
      },
    },
    "/api/v1/videos/{jobId}": {
      get: {
        operationId: "getVideo",
        parameters: [
          { in: "path", name: "jobId", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            content: { "application/json": { schema: { $ref: "#/components/schemas/VideoGenerationJob" } } },
            description: "Current video generation status",
          },
          "401": { $ref: "#/components/responses/Error" },
          "404": { $ref: "#/components/responses/Error" },
          "409": { $ref: "#/components/responses/Error" },
          "502": { $ref: "#/components/responses/Error" },
        },
        security: [{ runtimeBearer: [] }],
        summary: "Poll video generation status",
        tags: ["Videos"],
      },
    },
    "/api/v1/videos/{jobId}/content": {
      get: {
        operationId: "getVideoContent",
        parameters: [
          { in: "path", name: "jobId", required: true, schema: { type: "string" } },
          { in: "query", name: "index", required: false, schema: { default: 0, minimum: 0, type: "integer" } },
        ],
        responses: {
          "200": {
            content: { "video/mp4": { schema: { format: "binary", type: "string" } } },
            description: "Generated video bytes",
          },
          "206": {
            content: { "video/mp4": { schema: { format: "binary", type: "string" } } },
            description: "Generated video byte range",
          },
          "400": { $ref: "#/components/responses/Error" },
          "401": { $ref: "#/components/responses/Error" },
          "404": { $ref: "#/components/responses/Error" },
          "409": { $ref: "#/components/responses/Error" },
          "416": { $ref: "#/components/responses/Error" },
          "500": { $ref: "#/components/responses/Error" },
          "502": { $ref: "#/components/responses/Error" },
          "504": { $ref: "#/components/responses/Error" },
        },
        security: [{ runtimeBearer: [] }],
        summary: "Download generated video content",
        tags: ["Videos"],
      },
    },
  },
  components: {
    headers: {
      NoStore: {
        description: "BYOK metadata responses are not cacheable.",
        schema: { const: "no-store", type: "string" },
      },
    },
    parameters: {
      ByokCredentialId: {
        description: "BYOK credential identifier",
        in: "path",
        name: "id",
        required: true,
        schema: { format: "uuid", type: "string" },
      },
      FacadeApiKeyHash: {
        description: "Lowercase SHA-256 hash of the runtime facade API key whose active credential is queried.",
        in: "query",
        name: "facade_api_key_hash",
        required: true,
        schema: { pattern: "^[a-f0-9]{64}$", type: "string" },
      },
      OptionalFacadeApiKeyHash: {
        description:
          "Optional MCP caller scope. When present, list and delete operate only on credentials usable without a user identity and whose allowed_api_key_hashes are unrestricted or contain this hash. Omit for the existing global management API semantics.",
        in: "query",
        name: "facade_api_key_hash",
        required: false,
        schema: { pattern: "^[a-f0-9]{64}$", type: "string" },
      },
    },
    responses: {
      Error: {
        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
        description: "OpenRouter-style error response",
      },
    },
    schemas: {
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
            description: "Global edit instruction. The compiled prompt, including annotations, may not exceed 20000 characters.",
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
    },
    securitySchemes: {
      managementBearer: {
        bearerFormat: "Management API Key",
        description:
          "Server management key used only for /api/v1/byok. It is independent from both facade API keys and Pippit AKs.",
        scheme: "bearer",
        type: "http",
      },
      runtimeBearer: {
        bearerFormat: "Facade API Key",
        description:
          "Facade API key used for model discovery and video requests. It is not a Pippit AK; the server resolves an eligible stored BYOK credential.",
        scheme: "bearer",
        type: "http",
      },
    },
  },
} as const
