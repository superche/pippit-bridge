export interface ParsedWidgetJob {
  readonly id: string
  readonly status: string
  readonly [key: string]: unknown
}

export function findWidgetJob(value: unknown, depth = 0): ParsedWidgetJob | undefined {
  if (!value || typeof value !== "object" || depth > 5) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id === "string" && typeof record.status === "string") {
    return record as ParsedWidgetJob
  }
  if (typeof record.job_id === "string" && typeof record.status === "string") {
    return { ...record, id: record.job_id } as ParsedWidgetJob
  }
  const keys = Object.keys(record)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (key === undefined) continue
    const nested = findWidgetJob(record[key], depth + 1)
    if (nested) return nested
  }
  return undefined
}

export function widgetTextContent(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined
  const content = (result as { readonly content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const block = content.find(item => {
    return item && typeof item === "object"
      && (item as Record<string, unknown>).type === "text"
      && typeof (item as Record<string, unknown>).text === "string"
  }) as Record<string, unknown> | undefined
  return typeof block?.text === "string" ? block.text : undefined
}
