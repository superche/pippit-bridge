import type { FastifyInstance } from "fastify"
import { IMAGE_MODELS, publicImageModel, publicVideoModel, VIDEO_MODELS } from "@pippit-bridge/core"
import { authenticateFacadeApiKey } from "../../auth.js"
import type { AppConfig } from "../../config.js"
import { presentGeneralImageModel, presentGeneralVideoModel } from "../presenters/models.js"
import { FACADE_ROUTE_CONTRACTS } from "../route-contracts.js"
import { resolveFacadeImageModel } from "../services/models.js"

export function registerModelRoutes(
  app: FastifyInstance,
  config: Pick<AppConfig, "FACADE_API_KEY_SHA256_ALLOWLIST">,
): void {
  app.get(FACADE_ROUTE_CONTRACTS.listVideoModels.fastifyPath, async (request) => {
    authenticateFacadeApiKey(request, config.FACADE_API_KEY_SHA256_ALLOWLIST)
    return { data: VIDEO_MODELS.map(publicVideoModel) }
  })
  app.get(FACADE_ROUTE_CONTRACTS.listImageModels.fastifyPath, async (request) => {
    authenticateFacadeApiKey(request, config.FACADE_API_KEY_SHA256_ALLOWLIST)
    return { data: IMAGE_MODELS.map(publicImageModel) }
  })
  app.get(FACADE_ROUTE_CONTRACTS.imageModelEndpoints.fastifyPath, async (request) => {
    authenticateFacadeApiKey(request, config.FACADE_API_KEY_SHA256_ALLOWLIST)
    const params = FACADE_ROUTE_CONTRACTS.imageModelEndpoints.params.parse(request.params)
    const model = resolveFacadeImageModel(`${params.provider}/${params.model}`)
    return {
      endpoints: [{
        allowed_passthrough_parameters: ["byok_id", "thread_id"],
        pricing: [],
        provider_name: "Pippit",
        provider_slug: "pippit",
        provider_tag: "pippit",
        supported_parameters: model.supported_parameters,
        supports_streaming: false,
      }],
      id: model.id,
    }
  })
  app.get(FACADE_ROUTE_CONTRACTS.listModels.fastifyPath, async (request) => {
    authenticateFacadeApiKey(request, config.FACADE_API_KEY_SHA256_ALLOWLIST)
    return { data: [...VIDEO_MODELS.map(presentGeneralVideoModel), ...IMAGE_MODELS.map(presentGeneralImageModel)] }
  })
}
