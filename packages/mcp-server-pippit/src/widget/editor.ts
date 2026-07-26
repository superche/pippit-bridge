import type { WidgetDraftAnnotation } from "./state.ts"

export interface WidgetEditPayload {
  guidance_annotations: [{
    at_time_us: number
    instruction: string
    region: WidgetDraftAnnotation["region"]
  }]
  model: string
  source_index: number
  source_job_id: string
  time_range: { end_time_us: number; start_time_us: number }
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
    guidance_annotations: [{
      at_time_us: input.annotation.at_ms * 1_000,
      instruction,
      region: input.annotation.region,
    }],
    model: input.model,
    source_index: input.sourceIndex,
    source_job_id: input.sourceJobId,
    time_range: {
      end_time_us: input.segmentEndMs * 1_000,
      start_time_us: input.segmentStartMs * 1_000,
    },
  }
  return payload
}
