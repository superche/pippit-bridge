import { z } from "zod"
import {
  byokActiveSelectionQueryContract,
  byokActiveSelectionUpdateContract,
  byokCredentialCreateContract,
  byokCredentialDeleteQueryContract,
  byokCredentialListQueryContract,
  byokCredentialUpdateContract,
  imageGenerationRequestContract,
  runtimeContract,
  videoEditRequestContract,
  videoGenerationRequestContract,
  type RuntimeContract,
} from "@pippit-bridge/contracts"
import { FACADE_SUCCESS_RESPONSE_CONTRACTS, successResponsesFor } from "./route-response-contracts.js"

type HttpMethod = "delete" | "get" | "patch" | "post" | "put"

export interface FacadeRouteContract {
  readonly auth: "management" | "none" | "runtime"
  readonly body?: RuntimeContract<unknown>
  readonly cacheControl?: "no-store"
  readonly fastifyPath: string
  readonly method: HttpMethod
  readonly openApi?: {
    readonly operationId: string
    readonly path: string
  }
  readonly params?: RuntimeContract<unknown>
  readonly query?: RuntimeContract<unknown>
  readonly responseStatuses: readonly number[]
  readonly successResponses?: Readonly<Record<number, Readonly<Record<string, unknown>>>>
}

type PublicOperationId = keyof typeof FACADE_SUCCESS_RESPONSE_CONTRACTS

const jobParamsContract = runtimeContract(z.object({ jobId: z.string().min(1) }))
const byokParamsContract = runtimeContract(z.object({ id: z.uuid() }))
const contentQueryContract = runtimeContract(z.object({ index: z.coerce.number().int().min(0).default(0) }))
const imageEndpointParamsContract = runtimeContract(z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
}))

function publicRoute<const Input extends object>(
  method: HttpMethod,
  fastifyPath: string,
  operationId: PublicOperationId,
  responseStatuses: readonly number[],
  input: Input,
  openApiPath = fastifyPath.replace(/:([^/]+)/gu, "{$1}"),
): Input & {
  readonly fastifyPath: string
  readonly method: HttpMethod
  readonly openApi: { readonly operationId: string; readonly path: string }
  readonly auth: "management" | "runtime"
  readonly cacheControl?: "no-store"
  readonly responseStatuses: readonly number[]
  readonly successResponses: Readonly<Record<number, Readonly<Record<string, unknown>>>>
} {
  const management = fastifyPath.startsWith("/api/v1/byok")
  return {
    ...input,
    auth: management ? "management" : "runtime",
    ...(management ? { cacheControl: "no-store" as const } : {}),
    fastifyPath,
    method,
    openApi: { operationId, path: openApiPath },
    responseStatuses,
    successResponses: successResponsesFor(operationId),
  }
}

export const FACADE_ROUTE_CONTRACTS = {
  addByok: publicRoute("post", "/api/v1/byok", "createByokKey", [201, 400, 401, 409, 500], { body: byokCredentialCreateContract }),
  deleteByok: publicRoute("delete", "/api/v1/byok/:id", "deleteByokKey", [200, 401, 404, 409, 500], {
    params: byokParamsContract,
    query: byokCredentialDeleteQueryContract,
  }),
  editVideo: publicRoute("post", "/api/v1/videos/edits", "createVideoEdit", [202, 400, 401, 404, 409, 413, 422, 502, 503, 504], { body: videoEditRequestContract }),
  generateImage: publicRoute("post", "/api/v1/images", "createImage", [200, 400, 401, 413, 502, 503, 504], { body: imageGenerationRequestContract }),
  generateVideo: publicRoute("post", "/api/v1/videos", "createVideo", [202, 400, 401, 502, 503, 504], { body: videoGenerationRequestContract }),
  getActiveByok: publicRoute("get", "/api/v1/byok/active", "getActiveByokKey", [200, 400, 401, 500], {
    query: byokActiveSelectionQueryContract,
  }),
  getByok: publicRoute("get", "/api/v1/byok/:id", "getByokKey", [200, 401, 404, 500], { params: byokParamsContract }),
  getVideo: publicRoute("get", "/api/v1/videos/:jobId", "getVideo", [200, 401, 404, 409, 502], { params: jobParamsContract }),
  getVideoContent: publicRoute("get", "/api/v1/videos/:jobId/content", "getVideoContent", [200, 206, 400, 401, 404, 409, 416, 500, 502, 504], {
    params: jobParamsContract,
    query: contentQueryContract,
  }),
  health: { auth: "none", fastifyPath: "/health", method: "get", responseStatuses: [200] },
  imageModelEndpoints: publicRoute(
    "get",
    "/api/v1/images/models/:provider/:model/endpoints",
    "listImageModelEndpoints",
    [200, 401, 404],
    { params: imageEndpointParamsContract },
  ),
  listByok: publicRoute("get", "/api/v1/byok", "listByokKeys", [200, 400, 401, 500], { query: byokCredentialListQueryContract }),
  listImageModels: publicRoute("get", "/api/v1/images/models", "listImageModels", [200, 401], {}),
  listModels: publicRoute("get", "/api/v1/models", "listModels", [200, 401], {}),
  listVideoModels: publicRoute("get", "/api/v1/videos/models", "listVideoModels", [200, 401], {}),
  openApi: { auth: "none", fastifyPath: "/openapi.json", method: "get", responseStatuses: [200] },
  setActiveByok: publicRoute("put", "/api/v1/byok/active", "setActiveByokKey", [200, 400, 401, 404, 409, 500], {
    body: byokActiveSelectionUpdateContract,
  }),
  updateByok: publicRoute("patch", "/api/v1/byok/:id", "updateByokKey", [200, 400, 401, 404, 500], {
    body: byokCredentialUpdateContract,
    params: byokParamsContract,
  }),
} as const satisfies Readonly<Record<string, FacadeRouteContract>>

export function facadeRouteContracts(): readonly FacadeRouteContract[] {
  return Object.values(FACADE_ROUTE_CONTRACTS)
}

export function facadeRouteContractFor(
  method: string,
  fastifyPath: string,
): FacadeRouteContract | undefined {
  const normalizedMethod = method.toLowerCase()
  return facadeRouteContracts().find(
    route => route.method === normalizedMethod && route.fastifyPath === fastifyPath,
  )
}

export function assertRegisteredFacadeRoutes(registered: ReadonlySet<string>): void {
  const expected = new Set(facadeRouteContracts().map(route => `${route.method.toUpperCase()} ${route.fastifyPath}`))
  const missing = [...expected].filter(key => !registered.has(key))
  const extra = [...registered].filter(key => !expected.has(key))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`Facade route contracts do not match registration (missing=${missing.join(",")}; extra=${extra.join(",")}).`)
  }
}
