import { createHash, randomUUID } from "node:crypto"

export const DEV_GATEWAY_PROTOCOL_VERSION = 1
export const DEV_WORKER_IPC_VERSION = 1

export type DevStableErrorCode =
  | "DEV_CANDIDATE_SUPERSEDED"
  | "DEV_CONTRACT_MISMATCH"
  | "DEV_POST_ACTIVATION_UNSAFE_ROLLBACK"
  | "DEV_SEMANTIC_REVIEW_REQUIRED"
  | "DEV_SUPERVISOR_UNAVAILABLE"
  | "DEV_WORKER_NOT_READY"

export class DevGatewayError extends Error {
  constructor(readonly code: DevStableErrorCode, message: string) {
    super(message)
    this.name = "DevGatewayError"
  }
}

export interface DevWorkerGeneration<TRequest, TResult> {
  readonly contractHash: string
  readonly generationId: string
  readonly implementationHash: string
  readonly ipcVersion: number
  readonly migrationEpoch: number
  readonly ready: boolean
  readonly storageBackwardCompatible: boolean
  invoke(request: TRequest, signal: AbortSignal): Promise<TResult>
  close(): Promise<void>
}

interface GenerationState<TRequest, TResult> {
  readonly worker: DevWorkerGeneration<TRequest, TResult>
  inFlight: number
  wroteState: boolean
}

export interface DevCandidateReview {
  readonly behaviorTestsPassed: boolean
  readonly contractHash: string
  readonly semanticClassification: "cold" | "hot-compatible" | "unreviewed"
}

export class DevWorkerPool<TRequest, TResult> {
  readonly contractHash: string
  #active: GenerationState<TRequest, TResult> | undefined
  #draining = new Set<GenerationState<TRequest, TResult>>()
  #migrationEpoch = 0

  constructor(contractHash: string) {
    this.contractHash = contractHash
  }

  get status() {
    return {
      activeGeneration: this.#active?.worker.generationId,
      contractHash: this.contractHash,
      draining: [...this.#draining].map(state => ({ generationId: state.worker.generationId, inFlight: state.inFlight })),
      migrationEpoch: this.#migrationEpoch,
    }
  }

  async activate(worker: DevWorkerGeneration<TRequest, TResult>, review: DevCandidateReview): Promise<void> {
    if (worker.contractHash !== this.contractHash || review.contractHash !== this.contractHash) {
      throw new DevGatewayError("DEV_CONTRACT_MISMATCH", "Candidate requires release and a new task.")
    }
    if (worker.ipcVersion !== DEV_WORKER_IPC_VERSION || !worker.ready) {
      throw new DevGatewayError("DEV_WORKER_NOT_READY", "Candidate worker failed readiness or IPC compatibility.")
    }
    if (review.semanticClassification !== "hot-compatible" || !review.behaviorTestsPassed) {
      throw new DevGatewayError("DEV_SEMANTIC_REVIEW_REQUIRED", "Candidate lacks hot-compatible semantic evidence.")
    }
    if (worker.migrationEpoch < this.#migrationEpoch) {
      throw new DevGatewayError("DEV_WORKER_NOT_READY", "Candidate migration epoch is stale.")
    }
    const previous = this.#active
    this.#active = { worker, inFlight: 0, wroteState: false }
    this.#migrationEpoch = worker.migrationEpoch
    if (previous) {
      this.#draining.add(previous)
      await this.#closeWhenDrained(previous)
    }
  }

  async invoke(request: TRequest, options: { readonly signal?: AbortSignal; readonly writesState?: boolean } = {}): Promise<TResult> {
    const pinned = this.#active
    if (!pinned) throw new DevGatewayError("DEV_SUPERVISOR_UNAVAILABLE", "No compatible active worker generation is available.")
    pinned.inFlight += 1
    if (options.writesState) pinned.wroteState = true
    try {
      return await pinned.worker.invoke(request, options.signal ?? new AbortController().signal)
    } finally {
      pinned.inFlight -= 1
      await this.#closeWhenDrained(pinned)
    }
  }

  async rollback(previous: DevWorkerGeneration<TRequest, TResult>): Promise<void> {
    const current = this.#active
    if (!current) throw new DevGatewayError("DEV_SUPERVISOR_UNAVAILABLE", "No active generation exists.")
    if (current.wroteState && (!current.worker.storageBackwardCompatible || previous.migrationEpoch !== current.worker.migrationEpoch)) {
      throw new DevGatewayError("DEV_POST_ACTIVATION_UNSAFE_ROLLBACK", "State changed under an incompatible migration epoch.")
    }
    await this.activate(previous, { behaviorTestsPassed: true, contractHash: this.contractHash, semanticClassification: "hot-compatible" })
  }

  async close(): Promise<void> {
    const workers = [
      ...(this.#active ? [this.#active] : []),
      ...this.#draining,
    ]
    this.#active = undefined
    this.#draining.clear()
    await Promise.all(workers.map(state => state.worker.close()))
  }

  async #closeWhenDrained(state: GenerationState<TRequest, TResult>): Promise<void> {
    if (!this.#draining.has(state) || state.inFlight !== 0) return
    this.#draining.delete(state)
    await state.worker.close()
  }
}

export class DevWorkerSupervisor<TRequest, TResult> {
  #pools = new Map<string, DevWorkerPool<TRequest, TResult>>()

  pool(contractHash: string): DevWorkerPool<TRequest, TResult> {
    const existing = this.#pools.get(contractHash)
    if (existing) return existing
    const created = new DevWorkerPool<TRequest, TResult>(contractHash)
    this.#pools.set(contractHash, created)
    return created
  }

  status() {
    return [...this.#pools.values()].map(pool => pool.status)
  }
}

export interface DevGatewayHandshake {
  readonly capability: string
  readonly connectionId: string
  readonly frozenMcpContractHash: string
  readonly gatewayProtocolVersion: number
  readonly pluginContractHash: string
  readonly releaseEpoch: number
}

export function createDevGatewayHandshake(mcpHash: string, pluginHash: string, releaseEpoch: number): DevGatewayHandshake {
  return {
    capability: createHash("sha256").update(randomUUID()).digest("hex"),
    connectionId: randomUUID(),
    frozenMcpContractHash: mcpHash,
    gatewayProtocolVersion: DEV_GATEWAY_PROTOCOL_VERSION,
    pluginContractHash: pluginHash,
    releaseEpoch,
  }
}
