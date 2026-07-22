import { OPENAPI_IMAGE_BYOK_SCHEMAS } from "./schemas-image-byok.js"
import { OPENAPI_VIDEO_SCHEMAS } from "./schemas-video.js"

export const OPENAPI_COMPONENTS = {
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
    ...OPENAPI_IMAGE_BYOK_SCHEMAS,
    ...OPENAPI_VIDEO_SCHEMAS,
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
} as const
