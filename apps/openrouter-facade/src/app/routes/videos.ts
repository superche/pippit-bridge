import type { FastifyInstance, FastifyRequest } from "fastify"
import { authenticateFacadeApiKey, type AuthenticatedApiKey } from "../../auth.js"
import type { AppConfig } from "../../config.js"
import type { VideoGenerationJob, VideoGenerationRequest } from "../../openrouter/contracts.js"
import { FACADE_ROUTE_CONTRACTS } from "../route-contracts.js"

export function registerVideoRoutes(
  app: FastifyInstance,
  input: {
    readonly config: Pick<AppConfig, "FACADE_API_KEY_SHA256_ALLOWLIST">
    readonly getVideo: (request: FastifyRequest, jobId: string) => Promise<VideoGenerationJob>
    readonly submitVideo: (
      request: FastifyRequest,
      caller: AuthenticatedApiKey,
      body: VideoGenerationRequest,
    ) => Promise<VideoGenerationJob>
  },
): void {
  app.post(FACADE_ROUTE_CONTRACTS.generateVideo.fastifyPath, async (request, reply) => {
    const caller = authenticateFacadeApiKey(request, input.config.FACADE_API_KEY_SHA256_ALLOWLIST)
    const body = FACADE_ROUTE_CONTRACTS.generateVideo.body.parse(request.body)
    return reply.status(202).send(await input.submitVideo(request, caller, body))
  })
  app.get(FACADE_ROUTE_CONTRACTS.getVideo.fastifyPath, async request => {
    const { jobId } = FACADE_ROUTE_CONTRACTS.getVideo.params.parse(request.params)
    return input.getVideo(request, jobId)
  })
}
