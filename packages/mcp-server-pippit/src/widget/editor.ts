import type { WidgetDraftAnnotation } from "./state.ts"

export interface WidgetEditPayload {
  annotations: Array<Omit<WidgetDraftAnnotation, "id">>
  model: string
  prompt?: string
  segment: { end_ms: number; start_ms: number }
  source_index: number
  source_job_id: string
}

export function buildWidgetEditPayload(input: {
  annotations: WidgetDraftAnnotation[]
  model: string
  prompt: string
  segmentEndMs: number
  segmentStartMs: number
  sourceIndex: number
  sourceJobId: string
}): WidgetEditPayload {
  const payload: WidgetEditPayload = {
    annotations: input.annotations.map(annotation => ({
      at_ms: annotation.at_ms,
      instruction: annotation.instruction,
      region: annotation.region,
    })),
    model: input.model,
    segment: { end_ms: input.segmentEndMs, start_ms: input.segmentStartMs },
    source_index: input.sourceIndex,
    source_job_id: input.sourceJobId,
  }
  const prompt = input.prompt.trim()
  if (prompt !== "") payload.prompt = prompt
  return payload
}
