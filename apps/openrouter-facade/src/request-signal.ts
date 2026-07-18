import type { FastifyRequest } from "fastify"

export interface RequestSignal {
  readonly dispose: () => void
  readonly signal: AbortSignal
}

export function createRequestSignal(request: FastifyRequest): RequestSignal {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const socket = request.raw.socket

  if (request.raw.aborted) controller.abort()
  else {
    request.raw.once("aborted", abort)
    socket.once("close", abort)
  }

  return {
    dispose: () => {
      request.raw.removeListener("aborted", abort)
      socket.removeListener("close", abort)
    },
    signal: controller.signal,
  }
}
