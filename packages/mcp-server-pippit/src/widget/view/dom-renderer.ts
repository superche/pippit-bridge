export interface WidgetViewElements {
  readonly documentElement: { readonly dataset: Record<string, string | undefined> }
  readonly editor: { hidden: boolean }
  readonly loading: { hidden: boolean }
  readonly status: { textContent: string | null }
  readonly terminal: { hidden: boolean }
}

export function renderWidgetView(
  elements: WidgetViewElements,
  model: { loadingText?: string; view: "editor" | "loading" | "terminal" },
): void {
  const { loadingText, view } = model
  elements.documentElement.dataset.widgetView = view
  elements.loading.hidden = view !== "loading"
  elements.editor.hidden = view !== "editor"
  elements.terminal.hidden = view !== "terminal"
  if (view === "loading" && loadingText !== undefined) elements.status.textContent = loadingText
}
