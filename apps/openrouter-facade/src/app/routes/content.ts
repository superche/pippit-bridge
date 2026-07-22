import type { FastifyInstance, FastifyRequest } from "fastify"
import type { QueriedJob } from "../services/job-query.js"
import type { ContentProxyResponse } from "../services/content-proxy.js"
import { FACADE_ROUTE_CONTRACTS } from "../route-contracts.js"

export function registerContentRoute(
  app: FastifyInstance,
  input: {
    readonly proxyContent: (request: {
      readonly index: number
      readonly onCleanup: () => void
      readonly queried: QueriedJob
      readonly range?: string
      readonly signal: AbortSignal
    }) => Promise<ContentProxyResponse>
    readonly queryJob: (request: FastifyRequest, jobId: string, signal: AbortSignal) => Promise<QueriedJob>
  },
): void {
  app.get(FACADE_ROUTE_CONTRACTS.getVideoContent.fastifyPath, async (request, reply) => {
    const { jobId } = FACADE_ROUTE_CONTRACTS.getVideoContent.params.parse(request.params)
    const { index } = FACADE_ROUTE_CONTRACTS.getVideoContent.query.parse(request.query)
    const downstreamController = new AbortController()
    const abortDownstream = (): void => downstreamController.abort()
    request.raw.socket.once("close", abortDownstream)
    reply.raw.once("close", abortDownstream)
    let cleaned = false
    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      request.raw.socket.removeListener("close", abortDownstream)
      reply.raw.removeListener("close", abortDownstream)
    }
    try {
      const queried = await input.queryJob(request, jobId, downstreamController.signal)
      const range = request.headers.range
      const proxied = await input.proxyContent({
        index,
        onCleanup: cleanup,
        queried,
        ...(range === undefined ? {} : { range }),
        signal: downstreamController.signal,
      })
      reply.status(proxied.statusCode)
      for (const [name, value] of Object.entries(proxied.headers)) reply.header(name, value)
      return reply.send(proxied.body)
    } catch (error) {
      cleanup()
      throw error
    }
  })
}
