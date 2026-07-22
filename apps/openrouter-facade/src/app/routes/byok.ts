import type { FastifyInstance } from "fastify"
import { authenticateManagementKey } from "../../auth.js"
import {
  type ByokStore,
} from "../../byok/index.js"
import type { AppConfig } from "../../config.js"
import { ApiError } from "../../errors.js"

import { FACADE_ROUTE_CONTRACTS } from "../route-contracts.js"

function credentialNotFound(): ApiError {
  return new ApiError("The requested BYOK credential does not exist.", {
    code: "byok_credential_not_found",
    param: "id",
    statusCode: 404,
    type: "not_found_error",
  })
}

export function registerByokRoutes(
  app: FastifyInstance,
  input: {
    readonly config: Pick<AppConfig, "BYOK_MANAGEMENT_KEY_SHA256">
    readonly store: ByokStore
  },
): void {
  app.post(FACADE_ROUTE_CONTRACTS.addByok.fastifyPath, async (request, reply) => {
    authenticateManagementKey(request, input.config.BYOK_MANAGEMENT_KEY_SHA256)
    const body = FACADE_ROUTE_CONTRACTS.addByok.body.parse(request.body)
    const credential = await input.store.create(body)
    reply.header("cache-control", "no-store")
    return reply.status(201).send({ data: credential })
  })

  app.get(FACADE_ROUTE_CONTRACTS.listByok.fastifyPath, async (request, reply) => {
    authenticateManagementKey(request, input.config.BYOK_MANAGEMENT_KEY_SHA256)
    const query = FACADE_ROUTE_CONTRACTS.listByok.query.parse(request.query)
    const credentials = await input.store.list(query)
    reply.header("cache-control", "no-store")
    return credentials
  })

  app.get(FACADE_ROUTE_CONTRACTS.getActiveByok.fastifyPath, async (request, reply) => {
    authenticateManagementKey(request, input.config.BYOK_MANAGEMENT_KEY_SHA256)
    const query = FACADE_ROUTE_CONTRACTS.getActiveByok.query.parse(request.query)
    const selection = await input.store.getActiveSelection(query.facade_api_key_hash)
    reply.header("cache-control", "no-store")
    return { data: selection ?? null }
  })

  app.put(FACADE_ROUTE_CONTRACTS.setActiveByok.fastifyPath, async (request, reply) => {
    authenticateManagementKey(request, input.config.BYOK_MANAGEMENT_KEY_SHA256)
    const body = FACADE_ROUTE_CONTRACTS.setActiveByok.body.parse(request.body)
    const selection = await input.store.setActiveSelection(body.facade_api_key_hash, body.credential_id)
    reply.header("cache-control", "no-store")
    return { data: selection }
  })

  app.get(FACADE_ROUTE_CONTRACTS.getByok.fastifyPath, async (request, reply) => {
    authenticateManagementKey(request, input.config.BYOK_MANAGEMENT_KEY_SHA256)
    const { id } = FACADE_ROUTE_CONTRACTS.getByok.params.parse(request.params)
    const credential = await input.store.get(id)
    if (credential === undefined) throw credentialNotFound()
    reply.header("cache-control", "no-store")
    return { data: credential }
  })

  app.patch(FACADE_ROUTE_CONTRACTS.updateByok.fastifyPath, async (request, reply) => {
    authenticateManagementKey(request, input.config.BYOK_MANAGEMENT_KEY_SHA256)
    const { id } = FACADE_ROUTE_CONTRACTS.updateByok.params.parse(request.params)
    const body = FACADE_ROUTE_CONTRACTS.updateByok.body.parse(request.body)
    const credential = await input.store.update(id, body)
    if (credential === undefined) throw credentialNotFound()
    reply.header("cache-control", "no-store")
    return { data: credential }
  })

  app.delete(FACADE_ROUTE_CONTRACTS.deleteByok.fastifyPath, async (request, reply) => {
    authenticateManagementKey(request, input.config.BYOK_MANAGEMENT_KEY_SHA256)
    const { id } = FACADE_ROUTE_CONTRACTS.deleteByok.params.parse(request.params)
    const query = FACADE_ROUTE_CONTRACTS.deleteByok.query.parse(request.query)
    const deleted = await input.store.delete(id, query.facade_api_key_hash)
    if (!deleted) throw credentialNotFound()
    reply.header("cache-control", "no-store")
    return { deleted: true }
  })
}
