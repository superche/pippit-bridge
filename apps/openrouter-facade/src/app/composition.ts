import { resolve } from "node:path"
import Fastify, { type FastifyInstance } from "fastify"
import {
  classifyReleaseEpoch,
  createPublicHttpFetcher,
  createReferenceLoader,
  PIPPIT_RELEASE_EPOCH_HEADER,
  type ReferenceLoader,
  type ReferenceLookup,
  type ReferenceTransport,
} from "@pippit-bridge/core"
import { PippitClient, type PippitApi } from "@pippit-bridge/sdk"
import { authenticateFacadeApiKey, authenticateManagementKey } from "../auth.js"
import { FileByokStore, type ByokStore } from "../byok/index.js"
import { loadConfig, mergeConfig, parseConfig, type AppConfig } from "../config.js"
import { ApiError } from "../errors.js"
import { createReferenceWorkGate } from "../media/prepare-references.js"
import { registerFacadeErrorHandler } from "./error-handler.js"
import { registerFacadeRoutes } from "./register-routes.js"
import { createImageGenerationService } from "./services/image-generation.js"
import { createContentProxyService } from "./services/content-proxy.js"
import { createJobQueryService } from "./services/job-query.js"
import { createVideoEditService } from "./services/video-edit.js"
import { createVideoGenerationService } from "./services/video-generation.js"
import { assertRegisteredFacadeRoutes, facadeRouteContractFor } from "./route-contracts.js"

export interface BuildAppOptions {
  readonly byokStore?: ByokStore
  readonly config?: Partial<AppConfig>
  readonly contentLookup?: ReferenceLookup
  readonly contentTransport?: ReferenceTransport
  readonly logger?: boolean
  readonly pippit?: PippitApi
  readonly referenceLoader?: ReferenceLoader
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config === undefined
    ? loadConfig()
    : mergeConfig(parseConfig({}), options.config)
  const byokStore = options.byokStore ?? new FileByokStore({
    filePath: resolve(config.BYOK_STORE_PATH),
    masterKey: Buffer.from(config.BYOK_ENCRYPTION_KEY_HEX, "hex"),
  })
  const contentFetcher = createPublicHttpFetcher({
    ...(options.contentLookup === undefined ? {} : { lookup: options.contentLookup }),
    maxRedirects: config.REFERENCE_MAX_REDIRECTS,
    ...(options.contentTransport === undefined ? {} : { transport: options.contentTransport }),
  })
  const pippit = options.pippit ?? new PippitClient({
    baseUrl: config.PIPPIT_BASE_URL,
    timeoutMs: config.PIPPIT_REQUEST_TIMEOUT_MS,
  })
  const referenceLoader = options.referenceLoader ?? createReferenceLoader({
    allowPrivateUrls: config.ALLOW_PRIVATE_REFERENCE_URLS,
    maxBytesByKind: {
      audio: config.REFERENCE_MAX_AUDIO_BYTES,
      image: config.REFERENCE_MAX_IMAGE_BYTES,
      video: config.REFERENCE_MAX_VIDEO_BYTES,
    },
    maxRedirects: config.REFERENCE_MAX_REDIRECTS,
    timeoutMs: config.REFERENCE_FETCH_TIMEOUT_MS,
  })
  const referenceGate = createReferenceWorkGate(config.REFERENCE_GLOBAL_CONCURRENCY)
  const queryJob = createJobQueryService({ byokStore, config, pippit })
  const submitVideo = createVideoGenerationService({ byokStore, config, pippit, referenceGate, referenceLoader })
  const submitImage = createImageGenerationService({ byokStore, config, pippit, referenceGate, referenceLoader })
  const submitEdit = createVideoEditService({ queryJob, submitVideo })
  const proxyContent = createContentProxyService({ config, fetcher: contentFetcher })

  const app = Fastify({
    logger: options.logger ? { redact: ["req.headers.authorization", "req.body.key"] } : false,
    routerOptions: { maxParamLength: 16 * 1024 },
  })
  const registeredRoutes = new Set<string>()
  app.addHook("onRoute", route => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const method of methods) {
      if (method !== "HEAD") registeredRoutes.add(`${method} ${route.url}`)
    }
  })

  app.addHook("onRequest", async request => {
    const rawEpoch = request.headers[PIPPIT_RELEASE_EPOCH_HEADER]
    const epoch = Array.isArray(rawEpoch) ? rawEpoch[0] : rawEpoch
    if (classifyReleaseEpoch(epoch) === "stale") {
      throw new ApiError("This plugin task is outside the supported compatibility window. Start a new task.", {
        code: "PLUGIN_TASK_STALE",
        statusCode: 409,
        type: "invalid_request_error",
      })
    }
  })
  app.addHook("onReady", async () => { await byokStore.getWorkspaceId() })
  app.addHook("onRequest", async (request, reply) => {
    const routePath = request.routeOptions.url
    if (routePath === undefined) return
    const contract = facadeRouteContractFor(request.method, routePath)
    if (contract === undefined) return
    if (contract.cacheControl !== undefined) reply.header("cache-control", contract.cacheControl)
    if (contract.auth === "management") {
      authenticateManagementKey(request, config.BYOK_MANAGEMENT_KEY_SHA256)
    } else if (contract.auth === "runtime") {
      authenticateFacadeApiKey(request, config.FACADE_API_KEY_SHA256_ALLOWLIST)
    }
  })
  app.addHook("onClose", async () => { await byokStore.close() })
  registerFacadeErrorHandler(app)

  registerFacadeRoutes(app, {
    byokStore,
    config,
    proxyContent,
    queryJob,
    submitEdit,
    submitImage,
    submitVideo,
  })
  assertRegisteredFacadeRoutes(registeredRoutes)
  return app
}
