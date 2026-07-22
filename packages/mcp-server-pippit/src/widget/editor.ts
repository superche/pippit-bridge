import type { WidgetDraftAnnotation } from "./state.ts"

export interface WidgetEditPayload {
  annotations: [Omit<WidgetDraftAnnotation, "id">]
  model: string
  segment: { end_ms: number; start_ms: number }
  source_index: number
  source_job_id: string
}

export function buildWidgetEditPayload(input: {
  annotation: WidgetDraftAnnotation
  model: string
  segmentEndMs: number
  segmentStartMs: number
  sourceIndex: number
  sourceJobId: string
}): WidgetEditPayload {
  const instruction = input.annotation.instruction.trim()
  if (instruction === "") throw new Error("Annotation instruction is required.")
  const payload: WidgetEditPayload = {
    annotations: [{
      at_ms: input.annotation.at_ms,
      instruction,
      region: input.annotation.region,
    }],
    model: input.model,
    segment: { end_ms: input.segmentEndMs, start_ms: input.segmentStartMs },
    source_index: input.sourceIndex,
    source_job_id: input.sourceJobId,
  }
  return payload
}
