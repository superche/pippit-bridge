import { OPENAPI_COMPONENTS } from "./components.js"

export const OPENAPI_BASE_DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "Pippit Bridge",
    version: "0.1.0",
    description:
      "An OpenRouter-compatible image and asynchronous video API backed by Pippit. BYOK management follows OpenRouter's management-key boundary; provider=pippit is an explicit facade extension.",
  },
  externalDocs: {
    description: "OpenRouter BYOK documentation",
    url: "https://openrouter.ai/docs/guides/overview/auth/byok",
  },
  tags: [
    { name: "BYOK", description: "Manage encrypted Pippit credentials with a management API key." },
    { name: "Models" },
    { name: "Images" },
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
    "/api/v1/images": {
      post: {
        operationId: "createImage",
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/ImageGenerationRequest" } } },
          required: true,
        },
        responses: {
          "200": {
            content: { "application/json": { schema: { $ref: "#/components/schemas/ImageGenerationResponse" } } },
            description: "Completed image generation response with base64 image data",
          },
          "400": { $ref: "#/components/responses/Error" },
          "401": { $ref: "#/components/responses/Error" },
          "413": { $ref: "#/components/responses/Error" },
          "502": { $ref: "#/components/responses/Error" },
          "503": { $ref: "#/components/responses/Error" },
          "504": { $ref: "#/components/responses/Error" },
        },
        security: [{ runtimeBearer: [] }],
        summary: "Generate images",
        tags: ["Images"],
      },
    },
    "/api/v1/images/models": {
      get: {
        operationId: "listImageModels",
        responses: {
          "200": {
            content: { "application/json": { schema: {
              properties: { data: { items: { $ref: "#/components/schemas/ImageModel" }, type: "array" } },
              required: ["data"],
              type: "object",
            } } },
            description: "Seedream image models and capability descriptors",
          },
          "401": { $ref: "#/components/responses/Error" },
        },
        security: [{ runtimeBearer: [] }],
        summary: "List image generation models",
        tags: ["Images", "Models"],
      },
    },
    "/api/v1/images/models/{provider}/{model}/endpoints": {
      get: {
        operationId: "listImageModelEndpoints",
        parameters: [
          { in: "path", name: "provider", required: true, schema: { type: "string" } },
          { in: "path", name: "model", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Pippit endpoint capability and pricing metadata" },
          "401": { $ref: "#/components/responses/Error" },
          "404": { $ref: "#/components/responses/Error" },
        },
        security: [{ runtimeBearer: [] }],
        summary: "List endpoint records for an image model",
        tags: ["Images", "Models"],
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
          "Regenerates a video using one completed facade job output as the only video reference. The source is uploaded through the same safe reference loader as generation. Segment and normalized region values are prompt guidance; this endpoint does not byte-trim the source or apply a pixel mask.",
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
            description: "Reference-guided video generation request accepted",
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
        summary: "Regenerate a video from a completed result",
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
  components: OPENAPI_COMPONENTS,
} as const
