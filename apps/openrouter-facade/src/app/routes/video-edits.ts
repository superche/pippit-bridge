import type { FastifyInstance, FastifyRequest } from "fastify"
import { authenticateFacadeApiKey, type AuthenticatedApiKey } from "../../auth.js"
import type { AppConfig } from "../../config.js"
import type { VideoEditRequest, VideoGenerationJob } from "../../openrouter/contracts.js"
import { FACADE_ROUTE_CONTRACTS } from "../route-contracts.js"

export function registerVideoEditRoutes(
  app: FastifyInstance,
  input: {
    readonly config: Pick<AppConfig, "FACADE_API_KEY_SHA256_ALLOWLIST">
    readonly submitEdit: (
      request: FastifyRequest,
      caller: AuthenticatedApiKey,
      edit: VideoEditRequest,
    ) => Promise<VideoGenerationJob>
  },
): void {
  app.post(FACADE_ROUTE_CONTRACTS.editVideo.fastifyPath, async (request, reply) => {
    const caller = authenticateFacadeApiKey(request, input.config.FACADE_API_KEY_SHA256_ALLOWLIST)
    const edit = FACADE_ROUTE_CONTRACTS.editVideo.body.parse(request.body)
    return reply.status(202).send(await input.submitEdit(request, caller, edit))
  })
}
