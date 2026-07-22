import type { FastifyInstance, FastifyRequest } from "fastify"
import { authenticateFacadeApiKey, type AuthenticatedApiKey } from "../../auth.js"
import type { AppConfig } from "../../config.js"
import type { ImageGenerationRequest, ImageGenerationResponse } from "../../openrouter/contracts.js"
import { FACADE_ROUTE_CONTRACTS } from "../route-contracts.js"

export function registerImageRoutes(
  app: FastifyInstance,
  input: {
    readonly config: Pick<AppConfig, "FACADE_API_KEY_SHA256_ALLOWLIST">
    readonly submitImage: (
      request: FastifyRequest,
      caller: AuthenticatedApiKey,
      body: ImageGenerationRequest,
    ) => Promise<ImageGenerationResponse>
  },
): void {
  app.post(FACADE_ROUTE_CONTRACTS.generateImage.fastifyPath, async request => {
    const caller = authenticateFacadeApiKey(request, input.config.FACADE_API_KEY_SHA256_ALLOWLIST)
    const body = FACADE_ROUTE_CONTRACTS.generateImage.body.parse(request.body)
    return input.submitImage(request, caller, body)
  })
}
