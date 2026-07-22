import type { FastifyInstance, FastifyRequest } from "fastify"
import { authenticateFacadeApiKey } from "../auth.js"
import type { ByokStore } from "../byok/index.js"
import type { AppConfig } from "../config.js"
import { createRequestSignal } from "../request-signal.js"
import { presentVideoJob } from "./presenters/jobs.js"
import { registerByokRoutes } from "./routes/byok.js"
import { registerContentRoute } from "./routes/content.js"
import { registerImageRoutes } from "./routes/images.js"
import { registerModelRoutes } from "./routes/models.js"
import { registerSystemRoutes } from "./routes/system.js"
import { registerVideoEditRoutes } from "./routes/video-edits.js"
import { registerVideoRoutes } from "./routes/videos.js"
import type { createContentProxyService } from "./services/content-proxy.js"
import type { createImageGenerationService } from "./services/image-generation.js"
import type { createJobQueryService } from "./services/job-query.js"
import type { createVideoEditService } from "./services/video-edit.js"
import type { createVideoGenerationService } from "./services/video-generation.js"

async function withRequestSignal<T>(request: FastifyRequest, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const requestSignal = createRequestSignal(request)
  try {
    return await task(requestSignal.signal)
  } finally {
    requestSignal.dispose()
  }
}

export function registerFacadeRoutes(
  app: FastifyInstance,
  input: {
    readonly byokStore: ByokStore
    readonly config: AppConfig
    readonly proxyContent: ReturnType<typeof createContentProxyService>
    readonly queryJob: ReturnType<typeof createJobQueryService>
    readonly submitEdit: ReturnType<typeof createVideoEditService>
    readonly submitImage: ReturnType<typeof createImageGenerationService>
    readonly submitVideo: ReturnType<typeof createVideoGenerationService>
  },
): void {
  registerSystemRoutes(app, { store: input.byokStore })
  registerModelRoutes(app, input.config)
  registerByokRoutes(app, { config: input.config, store: input.byokStore })
  registerImageRoutes(app, {
    config: input.config,
    submitImage: (request, caller, body) => withRequestSignal(request, signal => input.submitImage(caller, body, signal)),
  })
  registerVideoRoutes(app, {
    config: input.config,
    getVideo: (request, jobId) => withRequestSignal(request, async signal => {
      const caller = authenticateFacadeApiKey(request, input.config.FACADE_API_KEY_SHA256_ALLOWLIST)
      return presentVideoJob({ config: input.config, jobId, ...await input.queryJob(caller, jobId, signal) })
    }),
    submitVideo: (request, caller, body) => withRequestSignal(request, signal => input.submitVideo(caller, body, signal)),
  })
  registerVideoEditRoutes(app, {
    config: input.config,
    submitEdit: (request, caller, edit) => withRequestSignal(request, signal => input.submitEdit(caller, edit, signal)),
  })
  registerContentRoute(app, {
    proxyContent: input.proxyContent,
    queryJob: async (request, jobId, signal) => {
      const caller = authenticateFacadeApiKey(request, input.config.FACADE_API_KEY_SHA256_ALLOWLIST)
      return input.queryJob(caller, jobId, signal)
    },
  })
}
