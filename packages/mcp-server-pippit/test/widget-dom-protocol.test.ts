import { describe, expect, it, vi } from "vitest"
import { PIPPIT_WIDGET_HTML } from "../src/widget.ts"

type Listener = (event: Record<string, unknown>) => void

class FakeClassList {
  readonly values = new Set<string>()
  add(value: string): void { this.values.add(value) }
  remove(value: string): void { this.values.delete(value) }
  toggle(value: string, force?: boolean): boolean {
    if (force === false) this.values.delete(value)
    else this.values.add(value)
    return this.values.has(value)
  }
}

class FakeElement {
  readonly children: FakeElement[] = []
  readonly classList = new FakeClassList()
  readonly dataset: Record<string, string> = {}
  readonly listeners = new Map<string, Listener[]>()
  readonly style = { opacity: "", setProperty: vi.fn() }
  checked = false
  className = ""
  currentTime = 0
  disabled = false
  duration = 10
  hidden = false
  offsetWidth = 100
  textContent = ""
  title = ""
  type = ""
  value = ""
  tabIndex = 0
  private attributes = new Map<string, string>()

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  append(...children: FakeElement[]): void { this.children.push(...children) }
  appendChild(child: FakeElement): FakeElement { this.children.push(child); return child }
  focus(): void {}
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  getBoundingClientRect(): { bottom: number; height: number; left: number; top: number; width: number } {
    return { bottom: 100, height: 100, left: 0, top: 0, width: 100 }
  }
  load(): void {}
  pause(): void {}
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(candidate => candidate !== listener))
  }
  removeAttribute(name: string): void { this.attributes.delete(name) }
  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children)
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ currentTarget: this, target: this, ...event })
  }
}

interface WidgetProtocolHarness {
  readonly elements: Map<string, FakeElement>
  readonly notify: (method: string, params: unknown) => void
  readonly posted: Record<string, unknown>[]
  readonly teardown: () => void
}

function launchWidgetProtocolHarness(
  respond: (message: Record<string, unknown>) => unknown | Promise<unknown>,
): WidgetProtocolHarness {
  const ids = [...PIPPIT_WIDGET_HTML.matchAll(/\bid="([^"]+)"/gu)].map(match => match[1]!)
  const elements = new Map(ids.map(id => [id, new FakeElement()]))
  const listeners = new Map<string, Listener[]>()
  const documentListeners = new Map<string, Listener[]>()
  const posted: Record<string, unknown>[] = []
  const documentElement = new FakeElement()
  const body = new FakeElement()
  const dispatch = (type: string, event: Record<string, unknown>): void => {
    for (const listener of listeners.get(type) ?? []) listener(event)
  }
  const parent = {
    postMessage(message: Record<string, unknown>): void {
      posted.push(message)
      if (message.id === undefined) return
      void Promise.resolve(respond(message)).then(
        result => queueMicrotask(() => dispatch("message", {
          data: { id: message.id, jsonrpc: "2.0", result },
          source: parent,
        })),
        error => queueMicrotask(() => dispatch("message", {
          data: { error: { message: error instanceof Error ? error.message : String(error) }, id: message.id, jsonrpc: "2.0" },
          source: parent,
        })),
      )
    },
  }
  const windowValue = {
    addEventListener(type: string, listener: Listener): void {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    atob(value: string): string { return Buffer.from(value, "base64").toString("binary") },
    clearInterval,
    clearTimeout,
    matchMedia(): { addEventListener(): void; matches: boolean; removeEventListener(): void } {
      return { addEventListener() {}, matches: false, removeEventListener() {} }
    },
    parent,
    setInterval,
    setTimeout,
  }
  const documentValue = {
    addEventListener(type: string, listener: Listener): void {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener])
    },
    body,
    createElement(): FakeElement { return new FakeElement() },
    documentElement,
    hidden: false,
    getElementById(id: string): FakeElement {
      const element = elements.get(id)
      if (element === undefined) throw new Error(`Missing fake element ${id}`)
      return element
    },
    querySelectorAll(): FakeElement[] { return [] },
  }
  class HarnessUrl extends URL {
    static override createObjectURL(): string { return "blob:widget-preview" }
    static override revokeObjectURL(): void {}
  }
  const script = /<script>([\s\S]*)<\/script>/u.exec(PIPPIT_WIDGET_HTML)?.[1]
  if (script === undefined) throw new Error("Missing Widget script.")
  const execute = new Function(
    "window",
    "document",
    "URL",
    "Blob",
    "Uint8Array",
    "AbortController",
    "AbortSignal",
    "Headers",
    "crypto",
    "TextEncoder",
    "ResizeObserver",
    script,
  )
  execute(
    windowValue,
    documentValue,
    HarnessUrl,
    Blob,
    Uint8Array,
    AbortController,
    AbortSignal,
    Headers,
    globalThis.crypto,
    TextEncoder,
    undefined,
  )
  return {
    elements,
    notify(method, params) {
      dispatch("message", { data: { jsonrpc: "2.0", method, params }, source: parent })
    },
    posted,
    teardown() {
      dispatch("message", {
        data: { id: 9_999, jsonrpc: "2.0", method: "ui/resource-teardown" },
        source: parent,
      })
    },
  }
}

describe("Widget v15 DOM protocol", () => {
  it("initializes over the standard protocol, renders the dev terminal state, and acknowledges teardown", async () => {
    const ids = [...PIPPIT_WIDGET_HTML.matchAll(/\bid="([^"]+)"/gu)].map(match => match[1]!)
    const elements = new Map(ids.map(id => [id, new FakeElement()]))
    const listeners = new Map<string, Listener[]>()
    const posted: Record<string, unknown>[] = []
    const documentElement = new FakeElement()
    const body = new FakeElement()
    const parent = {
      postMessage(message: Record<string, unknown>): void {
        posted.push(message)
        if (message.method !== "ui/initialize") return
        queueMicrotask(() => dispatch("message", {
          data: {
            id: message.id,
            jsonrpc: "2.0",
            result: { hostCapabilities: { serverResources: true, serverTools: true }, hostContext: { theme: "dark" } },
          },
          source: parent,
        }))
      },
    }
    const windowValue = {
      addEventListener(type: string, listener: Listener): void {
        listeners.set(type, [...(listeners.get(type) ?? []), listener])
      },
      atob(value: string): string { return Buffer.from(value, "base64").toString("binary") },
      clearInterval(): void {},
      clearTimeout(): void {},
      matchMedia(): { addEventListener(): void; matches: boolean; removeEventListener(): void } {
        return { addEventListener() {}, matches: false, removeEventListener() {} }
      },
      parent,
      setInterval(): number { return 1 },
      setTimeout(): number { return 1 },
    }
    const documentValue = {
      addEventListener(): void {},
      body,
      createElement(): FakeElement { return new FakeElement() },
      documentElement,
      hidden: false,
      getElementById(id: string): FakeElement {
        const element = elements.get(id)
        if (element === undefined) throw new Error(`Missing fake element ${id}`)
        return element
      },
      querySelectorAll(): FakeElement[] { return [] },
    }
    function dispatch(type: string, event: Record<string, unknown>): void {
      for (const listener of listeners.get(type) ?? []) listener(event)
    }
    const script = /<script>([\s\S]*)<\/script>/u.exec(PIPPIT_WIDGET_HTML)?.[1]
    if (script === undefined) throw new Error("Missing Widget script.")
    const execute = new Function(
      "window",
      "document",
      "URL",
      "Blob",
      "Uint8Array",
      "AbortController",
      "AbortSignal",
      "Headers",
      "crypto",
      "TextEncoder",
      "ResizeObserver",
      script,
    )
    execute(
      windowValue,
      documentValue,
      URL,
      Blob,
      Uint8Array,
      AbortController,
      AbortSignal,
      Headers,
      globalThis.crypto,
      TextEncoder,
      undefined,
    )
    await vi.waitFor(() => expect(posted).toContainEqual(expect.objectContaining({ method: "ui/notifications/initialized" })))

    dispatch("message", {
      data: {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { structuredContent: { pippit_dev_preview: "error" } },
      },
      source: parent,
    })
    expect(documentElement.dataset.widgetView).toBe("terminal")
    expect(elements.get("terminal-view")?.hidden).toBe(false)
    expect(elements.get("editor")?.hidden).toBe(true)

    dispatch("message", {
      data: { id: 99, jsonrpc: "2.0", method: "ui/resource-teardown" },
      source: parent,
    })
    expect(posted).toContainEqual({ id: 99, jsonrpc: "2.0", result: {} })
  })

  it("polls through the typed controller and fences a late result after teardown", async () => {
    vi.useFakeTimers()
    let resolvePoll: ((value: unknown) => void) | undefined
    const harness = launchWidgetProtocolHarness((message) => {
      if (message.method === "ui/initialize") {
        return { hostCapabilities: { serverResources: true, serverTools: true }, hostContext: {} }
      }
      const params = message.params as { arguments?: unknown; name?: string } | undefined
      if (message.method === "tools/call" && params?.name === "pippit_resolve_latest_video") {
        return { structuredContent: { id: "job-poll", status: "pending" } }
      }
      if (message.method === "tools/call" && params?.name === "pippit_get_video") {
        return new Promise(resolve => { resolvePoll = resolve })
      }
      return {}
    })
    try {
      await vi.waitFor(() => expect(harness.posted).toContainEqual(expect.objectContaining({
        method: "ui/notifications/initialized",
      })))
      harness.notify("ui/notifications/tool-result", {
        structuredContent: { id: "job-poll", status: "pending" },
      })
      await vi.runOnlyPendingTimersAsync()
      await vi.waitFor(() => expect(harness.posted).toContainEqual(expect.objectContaining({
        method: "tools/call",
        params: expect.objectContaining({ name: "pippit_get_video" }),
      })))
      harness.teardown()
      resolvePoll?.({ structuredContent: { id: "job-poll", status: "completed" } })
      await Promise.resolve()
      await Promise.resolve()
      expect(harness.elements.get("editor")?.hidden).toBe(true)
      expect(harness.posted).toContainEqual({ id: 9_999, jsonrpc: "2.0", result: {} })
    } finally {
      vi.useRealTimers()
    }
  })

  it("renews an expiring preview and requests display mode through standard MCP Apps", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-22T00:00:00.000Z"))
    const completed = {
      _meta: {
        "pippit/media": [{
          expires_at: (Date.now() + 31_000) / 1000,
          index: 0,
          kind: "video",
          url: "https://media.example.test/video.mp4",
        }],
      },
      structuredContent: { id: "job-renew", model: "pippit/seedance", status: "completed" },
    }
    const harness = launchWidgetProtocolHarness((message) => {
      if (message.method === "ui/initialize") {
        return { hostCapabilities: { serverResources: true, serverTools: true }, hostContext: {} }
      }
      if (message.method === "ui/request-display-mode") return { mode: "fullscreen" }
      const params = message.params as { name?: string } | undefined
      if (message.method === "tools/call" && params?.name === "pippit_resolve_latest_video") return completed
      if (message.method === "tools/call" && params?.name === "pippit_get_video") return completed
      return {}
    })
    try {
      await vi.waitFor(() => expect(harness.posted).toContainEqual(expect.objectContaining({
        method: "ui/notifications/initialized",
      })))
      harness.notify("ui/notifications/tool-result", completed)
      await vi.waitFor(() => expect(harness.elements.get("editor")?.hidden).toBe(false))
      harness.elements.get("annotate")?.dispatch("click")
      await vi.waitFor(() => expect(harness.posted).toContainEqual(expect.objectContaining({
        method: "ui/request-display-mode",
        params: { mode: "fullscreen" },
      })))
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.waitFor(() => expect(harness.posted).toContainEqual(expect.objectContaining({
        method: "tools/call",
        params: expect.objectContaining({ name: "pippit_get_video" }),
      })))
    } finally {
      harness.teardown()
      vi.useRealTimers()
    }
  })

  it("demotes a malformed resources/read response to the app-visible chunk tool", async () => {
    const resourceUri = `pippit-video://artifact/${"a".repeat(64)}`
    const completed = {
      _meta: { "pippit/media": [{ bytes: 1, index: 0, kind: "video", resource_uri: resourceUri }] },
      structuredContent: { id: "job-local", model: "pippit/seedance", status: "completed" },
    }
    const harness = launchWidgetProtocolHarness((message) => {
      if (message.method === "ui/initialize") {
        return { hostCapabilities: { serverResources: true, serverTools: true }, hostContext: {} }
      }
      if (message.method === "resources/read") return { contents: [] }
      const params = message.params as { arguments?: unknown; name?: string } | undefined
      if (message.method === "tools/call" && params?.name === "pippit_resolve_latest_video") return completed
      if (message.method === "tools/call" && params?.name === "pippit_read_video_chunk") {
        return {
          structuredContent: {
            blob: Buffer.from([1]).toString("base64"),
            bytes: 1,
            complete: true,
            mime_type: "video/mp4",
            offset: 0,
            resource_uri: resourceUri,
            total_bytes: 1,
          },
        }
      }
      return {}
    })
    await vi.waitFor(() => expect(harness.posted).toContainEqual(expect.objectContaining({
      method: "ui/notifications/initialized",
    })))
    harness.notify("ui/notifications/tool-result", completed)
    await vi.waitFor(() => expect(harness.posted).toContainEqual(expect.objectContaining({
      method: "resources/read",
    })))
    await vi.waitFor(() => expect(harness.posted).toContainEqual(expect.objectContaining({
      method: "tools/call",
      params: expect.objectContaining({ name: "pippit_read_video_chunk" }),
    })))
    harness.teardown()
  })
})
