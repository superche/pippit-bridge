type OpenApiResponse = Readonly<Record<string, unknown>>

const noStoreHeader = { "Cache-Control": { $ref: "#/components/headers/NoStore" } } as const
const jsonResponse = (schema: string, description: string, noStore = false): OpenApiResponse => ({
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
  description,
  ...(noStore ? { headers: noStoreHeader } : {}),
})

export const FACADE_SUCCESS_RESPONSE_CONTRACTS = {
  createByokKey: { 201: jsonResponse("ByokCredentialEnvelope", "BYOK credential created. The submitted key is write-only.", true) },
  createImage: { 200: jsonResponse("ImageGenerationResponse", "Completed image generation response with base64 image data") },
  createVideo: { 202: jsonResponse("VideoGenerationJob", "Video generation request accepted") },
  createVideoEdit: { 202: jsonResponse("VideoGenerationJob", "Reference-guided video generation request accepted") },
  deleteByokKey: { 200: jsonResponse("ByokCredentialDelete", "BYOK credential deleted", true) },
  getActiveByokKey: { 200: jsonResponse("ByokActiveSelectionNullableEnvelope", "The active credential selection for this facade API key hash, if configured.", true) },
  getByokKey: { 200: jsonResponse("ByokCredentialEnvelope", "Stored BYOK credential metadata. Raw and encrypted key material are never returned.", true) },
  getVideo: { 200: jsonResponse("VideoGenerationJob", "Current video generation status") },
  getVideoContent: {
    200: { content: { "video/mp4": { schema: { format: "binary", type: "string" } } }, description: "Generated video bytes" },
    206: { content: { "video/mp4": { schema: { format: "binary", type: "string" } } }, description: "Generated video byte range" },
  },
  listByokKeys: { 200: jsonResponse("ByokCredentialList", "Stored BYOK credentials. Raw and encrypted key material are never returned.", true) },
  listImageModelEndpoints: { 200: { description: "Pippit endpoint capability and pricing metadata" } },
  listImageModels: {
    200: {
      content: { "application/json": { schema: { properties: { data: { items: { $ref: "#/components/schemas/ImageModel" }, type: "array" } }, required: ["data"], type: "object" } } },
      description: "Seedream image models and capability descriptors",
    },
  },
  listModels: { 200: { description: "Models exposed by this facade" } },
  listVideoModels: {
    200: {
      content: { "application/json": { schema: { properties: { data: { items: { $ref: "#/components/schemas/VideoModel" }, type: "array" } }, required: ["data"], type: "object" } } },
      description: "Video models and their capabilities",
    },
  },
  setActiveByokKey: { 200: jsonResponse("ByokActiveSelectionEnvelope", "The caller now resolves only through the selected eligible credential.", true) },
  updateByokKey: { 200: jsonResponse("ByokCredentialEnvelope", "BYOK credential updated. A replacement key is write-only.", true) },
} as const satisfies Readonly<Record<string, Readonly<Record<number, OpenApiResponse>>>>

export function successResponsesFor(
  operationId: keyof typeof FACADE_SUCCESS_RESPONSE_CONTRACTS,
): Readonly<Record<number, OpenApiResponse>> {
  return FACADE_SUCCESS_RESPONSE_CONTRACTS[operationId]
}
