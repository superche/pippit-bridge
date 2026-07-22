import type { WidgetEvent } from "./reducer.ts"

export interface WidgetEpochTicket {
  epoch: number
  jobId?: string
  kind: "generation" | "preview"
}

export function createWidgetEpochTicket(
  kind: WidgetEpochTicket["kind"],
  epoch: number,
  jobId?: string,
): WidgetEpochTicket {
  return jobId === undefined ? { epoch, kind } : { epoch, jobId, kind }
}

export function isWidgetEpochTicketCurrent(
  ticket: WidgetEpochTicket,
  currentEpoch: number,
  activeJobId: string | undefined,
  destroyed: boolean,
): boolean {
  return !destroyed && ticket.epoch === currentEpoch && (
    ticket.jobId === undefined || ticket.jobId === activeJobId
  )
}

export interface WidgetControllerPorts {
  callTool(name: string, argumentsValue: unknown): Promise<unknown>
  dispatch(event: WidgetEvent): void
  persistActiveJobId(jobId: string): Promise<void> | void
  requestLegacyDisplayMode(mode: string): Promise<string | undefined>
  requestStandardDisplayMode(mode: string): Promise<string | undefined>
}

export class WidgetController {
  readonly ports: WidgetControllerPorts

  constructor(ports: WidgetControllerPorts) {
    this.ports = ports
  }

  async callTool(name: string, argumentsValue: unknown): Promise<unknown> {
    return await this.ports.callTool(name, argumentsValue)
  }

  async poll(jobId: string, epoch: number): Promise<unknown> {
    this.ports.dispatch({ epoch, type: "poll-started" })
    try {
      return await this.callTool("pippit_get_video", { job_id: jobId })
    } finally {
      this.ports.dispatch({ epoch, type: "poll-finished" })
    }
  }

  previewRenewalDelay(expiresAtMs: number, nowMs: number): number | undefined {
    if (!Number.isFinite(expiresAtMs)) {
      this.ports.dispatch({ type: "preview-renewal-scheduled" })
      return undefined
    }
    this.ports.dispatch({ expiresAtMs, type: "preview-renewal-scheduled" })
    return Math.max(0, expiresAtMs - nowMs - 30_000)
  }

  async persistActiveJobId(jobId: string): Promise<void> {
    await this.ports.persistActiveJobId(jobId)
    this.ports.dispatch({ activeJobId: jobId, type: "state-persisted" })
  }

  async requestDisplayMode(mode: string, standardAvailable: boolean): Promise<string | undefined> {
    let selected: string | undefined
    if (standardAvailable) {
      try { selected = await this.ports.requestStandardDisplayMode(mode) } catch {}
    }
    if (selected !== mode) {
      try { selected = await this.ports.requestLegacyDisplayMode(mode) ?? selected } catch {}
    }
    if (selected !== undefined) this.ports.dispatch({ mode: selected, type: "display-mode" })
    return selected
  }
}
