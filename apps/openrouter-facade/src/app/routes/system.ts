import type { FastifyInstance } from "fastify"
import type { ByokStore } from "../../byok/index.js"
import { OPENAPI_DOCUMENT } from "../../openapi.js"
import { FACADE_ROUTE_CONTRACTS } from "../route-contracts.js"

export function registerSystemRoutes(
  app: FastifyInstance,
  input: { readonly store: ByokStore },
): void {
  app.get(FACADE_ROUTE_CONTRACTS.health.fastifyPath, async () => {
    await input.store.getWorkspaceId()
    return { status: "ok" }
  })
  app.get(FACADE_ROUTE_CONTRACTS.openApi.fastifyPath, async () => OPENAPI_DOCUMENT)
}
