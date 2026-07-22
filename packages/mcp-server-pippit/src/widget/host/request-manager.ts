export interface WidgetTimerPort {
  clearTimeout(timer: unknown): void
  setTimeout(callback: () => void, timeoutMs: number): unknown
}

interface PendingWidgetRequest {
  readonly reject: (error: Error) => void
  readonly resolve: (value: unknown) => void
  readonly timer: unknown
}

export class WidgetRequestManager {
  private readonly clientRequests = new Set<{ cancel(error: Error): void }>()
  private readonly pending = new Map<number, PendingWidgetRequest>()

  constructor(private readonly timers: WidgetTimerPort) {}

  request(
    id: number,
    method: string,
    params: unknown,
    timeoutMs: number,
    post: (message: unknown) => void,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        reject: error => {
          this.timers.clearTimeout(timer)
          reject(error)
        },
        resolve: value => {
          this.timers.clearTimeout(timer)
          resolve(value)
        },
        timer,
      })
      post({ id, jsonrpc: "2.0", method, params })
    })
  }

  runClient<T>(task: () => T | PromiseLike<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false
      const state = {
        cancel: (error: Error): void => {
          if (settled) return
          settled = true
          this.clientRequests.delete(state)
          this.timers.clearTimeout(timer)
          reject(error)
        },
      }
      const timer = this.timers.setTimeout(
        () => state.cancel(new Error("tools/call timed out")),
        timeoutMs,
      )
      this.clientRequests.add(state)
      let result: T | PromiseLike<T>
      try {
        result = task()
      } catch (error) {
        state.cancel(error instanceof Error ? error : new Error(String(error)))
        return
      }
      Promise.resolve(result).then(value => {
        if (settled) return
        settled = true
        this.clientRequests.delete(state)
        this.timers.clearTimeout(timer)
        resolve(value)
      }, error => state.cancel(error instanceof Error ? error : new Error(String(error))))
    })
  }

  settle(id: number, result: unknown, error?: string): boolean {
    const request = this.pending.get(id)
    if (request === undefined) return false
    this.pending.delete(id)
    if (error === undefined) request.resolve(result)
    else request.reject(new Error(error))
    return true
  }

  cancelAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
    for (const request of this.clientRequests) request.cancel(error)
    this.clientRequests.clear()
  }
}
