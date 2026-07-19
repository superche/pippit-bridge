import { spawn } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"

import { describe, expect, it, vi } from "vitest"

import { isPippitStdioEntrypoint, runPippitStdioServer } from "../src/stdio.ts"
import { PIPPIT_RUNTIME_TOOL_DEFINITIONS } from "../src/tools.ts"
import { createPippitWidgetMediaServer } from "../src/widget-media.ts"
import { PIPPIT_WIDGET_URI } from "../src/widget.ts"

describe("Pippit stdio entrypoint", () => {
  it("starts the Codex plugin shim through the packaged compiled runtime", async () => {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url))
    const manifest = JSON.parse(await readFile(join(packageRoot, ".mcp.json"), "utf8")) as {
      mcpServers?: { "pippit-video"?: { args?: string[] } }
    }
    expect(manifest.mcpServers?.["pippit-video"]?.args).toEqual(["./plugin-entry.mjs"])

    const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [join(packageRoot, "plugin-entry.mjs")], {
        cwd: packageRoot,
        env: {
          PATH: process.env.PATH ?? "",
          PIPPIT_FACADE_API_KEY: "runtime-test-key",
          PIPPIT_FACADE_BASE_URL: "http://127.0.0.1:3000",
        },
        stdio: ["pipe", "pipe", "pipe"],
      })
      let stderr = ""
      let stdout = ""
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
      child.once("error", reject)
      child.once("close", (code) => resolve({ code, stderr, stdout }))
      child.stdin.end()
    })
    expect(result).toEqual({ code: 0, stderr: "", stdout: "" })
  })

  it("recognizes an npm-style bin symlink as the module entrypoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pippit-mcp-bin-"))
    try {
      const modulePath = fileURLToPath(new URL("../src/stdio.ts", import.meta.url))
      const binPath = join(directory, "pippit-mcp")
      await symlink(modulePath, binPath, "file")
      expect(isPippitStdioEntrypoint(binPath, pathToFileURL(modulePath).href)).toBe(true)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("closes runtime resources when stdio reaches EOF", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const close = vi.fn(async () => undefined)
    input.end()
    await runPippitStdioServer({
      input,
      output,
      runtime: {
        callTool: vi.fn(),
        close,
        listTools: () => [],
      },
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it("aborts an unfinished local materialization as soon as stdin reaches EOF", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "pippit-plugin-media-abort-"))
    const input = new PassThrough()
    const output = new PassThrough()
    let resolveStarted: (() => void) | undefined
    const started = new Promise<void>((resolveStart) => { resolveStarted = resolveStart })
    const media = createPippitWidgetMediaServer({
      artifactRoot: outputRoot,
      backend: {
        async downloadVideo(_jobId, options) {
          resolveStarted?.()
          return await new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
          })
        },
      },
    })
    const getDefinition = PIPPIT_RUNTIME_TOOL_DEFINITIONS.find(definition => definition.name === "pippit_get_video")
    if (getDefinition === undefined) throw new Error("Missing get-video definition in test.")
    const running = runPippitStdioServer({
      input,
      output,
      runtime: {
        async callTool() {
          const job = { id: "job_abort", status: "completed", unsigned_urls: ["private"] }
          return { content: [{ text: JSON.stringify(job), type: "text" }], structuredContent: job }
        },
        listTools: () => [getDefinition],
      },
      widgetMedia: media,
    })
    try {
      input.write([
        JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-11-25" } }),
        JSON.stringify({
          id: 2,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { job_id: "job_abort" }, name: "pippit_get_video" },
        }),
        "",
      ].join("\n"))
      await started
      input.end()
      await Promise.race([
        running,
        new Promise((_, reject) => setTimeout(() => reject(new Error("stdio EOF did not abort materialization")), 1_000)),
      ])
      expect(await readdir(outputRoot)).toEqual([])
    } finally {
      input.end()
      await running.catch(() => undefined)
      await rm(outputRoot, { force: true, recursive: true })
    }
  })

  it("serves the completed local file for the whole plugin stdio lifecycle", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "pippit-plugin-media-lifecycle-"))
    const input = new PassThrough()
    const output = new PassThrough()
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])
    const media = createPippitWidgetMediaServer({
      artifactRoot: outputRoot,
      backend: {
        async downloadVideo() {
          return new Response(bytes, { headers: { "content-type": "video/mp4" } })
        },
      },
    })
    let stdout = ""
    let resolveResponses: (() => void) | undefined
    const responsesReady = new Promise<void>((resolveReady) => { resolveResponses = resolveReady })
    output.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk
      if (stdout.trim().split("\n").length >= 3) resolveResponses?.()
    })
    const getDefinition = PIPPIT_RUNTIME_TOOL_DEFINITIONS.find(definition => definition.name === "pippit_get_video")
    if (getDefinition === undefined) throw new Error("Missing get-video definition in test.")
    const running = runPippitStdioServer({
      input,
      output,
      runtime: {
        async callTool() {
          const job = { id: "job_lifecycle", status: "completed", unsigned_urls: ["private"] }
          return { content: [{ text: JSON.stringify(job), type: "text" }], structuredContent: job }
        },
        listTools: () => [getDefinition],
      },
      widgetMedia: media,
    })
    try {
      input.write([
        JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-11-25" } }),
        JSON.stringify({ id: 2, jsonrpc: "2.0", method: "resources/read", params: { uri: PIPPIT_WIDGET_URI } }),
        JSON.stringify({
          id: 3,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { job_id: "job_lifecycle" }, name: "pippit_get_video" },
        }),
        "",
      ].join("\n"))
      await Promise.race([
        responsesReady,
        new Promise((_, reject) => setTimeout(() => reject(new Error("stdio lifecycle response timeout")), 5_000)),
      ])
      const responses = stdout.trim().split("\n").map(line => JSON.parse(line) as {
        id: number
        result: { _meta?: Record<string, unknown> }
      })
      const previews = responses.find(response => response.id === 3)?.result._meta?.["pippit/media"] as Array<{
        local_path: string
        url: string
      }>
      expect(previews).toHaveLength(1)
      expect(previews[0]?.local_path).toMatch(/pippit-video-[a-f0-9]{64}\.mp4$/u)
      expect(new Uint8Array(await readFile(previews[0]!.local_path))).toEqual(bytes)
      const ranged = await fetch(previews[0]!.url, { headers: { range: "bytes=4-7" } })
      expect(ranged.status).toBe(206)
      expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(bytes.slice(4))
      input.end()
      await running
      await expect(fetch(previews[0]!.url)).rejects.toThrow()
      expect(new Uint8Array(await readFile(previews[0]!.local_path))).toEqual(bytes)
    } finally {
      input.end()
      await running.catch(() => undefined)
      await rm(outputRoot, { force: true, recursive: true })
    }
  })

  it("exposes the widget resource and projects completed calls into private previews", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let stdout = ""
    output.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    const widgetClose = vi.fn(async () => undefined)
    const runtimeClose = vi.fn(async () => undefined)
    const getDefinition = PIPPIT_RUNTIME_TOOL_DEFINITIONS.find((definition) => definition.name === "pippit_get_video")
    if (getDefinition === undefined) throw new Error("Missing get-video definition in test.")
    const running = runPippitStdioServer({
      input,
      output,
      runtime: {
        async callTool() {
          const job = {
            id: "job_123",
            status: "completed",
            unsigned_urls: ["/api/v1/videos/job_123/content?index=0"],
          }
          return { content: [{ text: JSON.stringify(job), type: "text" }], structuredContent: job }
        },
        close: runtimeClose,
        listTools: () => [getDefinition],
      },
      widgetMedia: {
        close: widgetClose,
        async listResources() { return { resources: [{ uri: PIPPIT_WIDGET_URI }] } },
        async preparePreview(_jobId, index) {
          return {
            bytes: 123,
            filename: `pippit-video-${index}.mp4`,
            localPath: `/Movies/Pippit/pippit-video-${index}.mp4`,
            url: `http://127.0.0.1:4321/media?token=${index}`,
          }
        },
        async previewUrl(_jobId, index) { return `http://127.0.0.1:4321/media?token=${index}` },
        async readResource(uri) {
          return uri === PIPPIT_WIDGET_URI
            ? { contents: [{ mimeType: "text/html;profile=mcp-app", text: "<main></main>", uri }] }
            : undefined
        },
      },
    })
    input.write([
      JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-11-25" } }),
      JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list" }),
      JSON.stringify({ id: 3, jsonrpc: "2.0", method: "resources/read", params: { uri: PIPPIT_WIDGET_URI } }),
      JSON.stringify({
        id: 4,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { job_id: "job_123" }, name: "pippit_get_video" },
      }),
      "",
    ].join("\n"))
    await vi.waitFor(() => expect(stdout.trim().split("\n")).toHaveLength(4))
    input.end()
    await running

    const responses = stdout.trim().split("\n").map((line) => JSON.parse(line) as {
      id: number
      result: Record<string, unknown>
    })
    expect(responses.find((response) => response.id === 1)?.result).toMatchObject({
      capabilities: { resources: { listChanged: false }, tools: { listChanged: false } },
    })
    const tools = (responses.find((response) => response.id === 2)?.result.tools ?? []) as Array<{
      _meta?: Record<string, unknown>
    }>
    expect(tools[0]?._meta?.["openai/outputTemplate"]).toBe(PIPPIT_WIDGET_URI)
    expect(responses.find((response) => response.id === 3)?.result).toMatchObject({
      contents: [{ uri: PIPPIT_WIDGET_URI }],
    })
    const callResult = responses.find((response) => response.id === 4)?.result
    if (callResult === undefined) throw new Error("Missing tools/call result in test.")
    expect(callResult.structuredContent).toEqual({ id: "job_123", status: "completed" })
    expect((callResult._meta as Record<string, unknown>)["pippit/media"]).toEqual([
      {
        bytes: 123,
        filename: "pippit-video-0.mp4",
        index: 0,
        kind: "video",
        local_path: "/Movies/Pippit/pippit-video-0.mp4",
        url: "http://127.0.0.1:4321/media?token=0",
      },
    ])
    expect(JSON.stringify(callResult)).not.toContain("unsigned_urls")
    expect(widgetClose).toHaveBeenCalledOnce()
    expect(runtimeClose).toHaveBeenCalledOnce()
  })

  it("fails closed when a completed output cannot be materialized locally", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let stdout = ""
    output.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    const getDefinition = PIPPIT_RUNTIME_TOOL_DEFINITIONS.find((definition) => definition.name === "pippit_get_video")
    if (getDefinition === undefined) throw new Error("Missing get-video definition in test.")
    const running = runPippitStdioServer({
      input,
      output,
      runtime: {
        async callTool() {
          const job = { id: "job_failed_save", status: "completed", unsigned_urls: ["private"] }
          return { content: [{ text: JSON.stringify(job), type: "text" }], structuredContent: job }
        },
        listTools: () => [getDefinition],
      },
      widgetMedia: {
        async close() {},
        async listResources() { return { resources: [] } },
        async preparePreview() { throw new Error("disk full") },
        async previewUrl() { throw new Error("disk full") },
        async readResource() { return undefined },
      },
    })
    input.write([
      JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-11-25" } }),
      JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { job_id: "job_failed_save" }, name: "pippit_get_video" },
      }),
      "",
    ].join("\n"))
    await vi.waitFor(() => expect(stdout.trim().split("\n")).toHaveLength(2))
    input.end()
    await running

    const responses = stdout.trim().split("\n").map((line) => JSON.parse(line) as {
      id: number
      result: { isError?: boolean; structuredContent?: { error?: { code?: string } } }
    })
    expect(responses.find((response) => response.id === 2)?.result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "local_media_unavailable" } },
    })
    expect(stdout).not.toContain("disk full")
    expect(stdout).not.toContain("private")
  })
})
