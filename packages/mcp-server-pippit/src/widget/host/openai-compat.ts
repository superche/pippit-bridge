export interface OpenAiWidgetCompat {
  readonly callTool?: (name: string, input: unknown) => unknown
  readonly requestDisplayMode?: (input: { mode: string }) => unknown
  readonly theme?: unknown
  readonly toolOutput?: unknown
  readonly toolResponseMetadata?: unknown
  readonly widgetState?: unknown
  readonly setWidgetState?: (state: unknown) => unknown
}

export function openAiWidgetToolAvailable(value: OpenAiWidgetCompat | undefined): boolean {
  return typeof value?.callTool === "function"
}

export function readOpenAiWidgetBootstrap(
  value: OpenAiWidgetCompat | undefined,
): { readonly _meta: unknown; readonly structuredContent: unknown } | undefined {
  if (value === undefined || (value.toolOutput === undefined && value.toolResponseMetadata === undefined)) {
    return undefined
  }
  return {
    _meta: value.toolResponseMetadata ?? {},
    structuredContent: value.toolOutput,
  }
}

export async function requestOpenAiWidgetDisplayMode(
  value: OpenAiWidgetCompat | undefined,
  mode: string,
): Promise<string | undefined> {
  if (typeof value?.requestDisplayMode !== "function") return undefined
  const result = await value.requestDisplayMode({ mode })
  return typeof result === "object" && result !== null && "mode" in result && typeof result.mode === "string"
    ? result.mode
    : undefined
}
