import { spawn } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"

import { describe, expect, it, vi } from "vitest"

import { defaultPippitOutputDirectory } from "../src/options.ts"
import {
  PIPPIT_READ_VIDEO_CHUNK_TOOL_NAME,
  isPippitStdioEntrypoint,
  resolvePippitStdioMediaOutputRoot,
  runPippitStdioServer,
} from "../src/stdio.ts"
import { PIPPIT_RUNTIME_TOOL_DEFINITIONS } from "../src/tools.ts"
import { createPippitWidgetMediaServer } from "../src/widget-media.ts"
import { PIPPIT_WIDGET_URI } from "../src/widget.ts"

describe("Pippit stdio entrypoint", () => {
  it("uses the matching output contract for local and external facades", () => {
    const bridgeHome = join(tmpdir(), "pippit-stdio-output-contract")
    expect(resolvePippitStdioMediaOutputRoot({ PIPPIT_BRIDGE_HOME: bridgeHome }))
      .toBe(join(bridgeHome, "outputs"))
    expect(resolvePippitStdioMediaOutputRoot({
      PIPPIT_BRIDGE_HOME: bridgeHome,
      PIPPIT_FACADE_API_KEY: "external-facade-key",
    })).toBe(defaultPippitOutputDirectory())
  })

  it("starts the Codex plugin shim through the packaged compiled runtime", async () => {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url))
    const manifest = JSON.parse(await readFile(join(packageRoot, ".mcp.json"), "utf8")) as {
      mcpServers?: { "pippit-video"?: { args?: string[]; tool_timeout_sec?: number } }
    }
    expect(manifest.mcpServers?.["pippit-video"]?.args).toEqual(["./plugin-entry.mjs"])
    expect(manifest.mcpServers?.["pippit-video"]?.tool_timeout_sec).toBe(43_200)

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

  it("reports resource failures as internal errors instead of invalid JSON", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let stdout = ""
    output.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    input.end([
      JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-11-25" } }),
      JSON.stringify({ id: 2, jsonrpc: "2.0", method: "resources/read", params: { uri: "pippit-video://artifact/failure?length=1&offset=0" } }),
      "",
    ].join("\n"))
    await runPippitStdioServer({
      input,
      output,
      runtime: { callTool: vi.fn(), listTools: () => [] },
      widgetMedia: {
        async close() {},
        async listResources() { return { resources: [] } },
        async preparePreview() { throw new Error("not used") },
        async readChunk() { return undefined },
        async readResource() { throw new Error("disk read failed") },
      },
    })
    const responses = stdout.trim().split("\n").map(line => JSON.parse(line) as {
      error?: { code: number }
      id: number
    })
    expect(responses).toHaveLength(2)
    expect(responses[1]).toMatchObject({ error: { code: -32603 }, id: 2 })
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

  it("reads the completed local file through MCP resources and recovers it after stdio restart", async () => {
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
    output.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk
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
      await vi.waitFor(() => expect(stdout.trim().split("\n")).toHaveLength(3))
      let responses = stdout.trim().split("\n").map(line => JSON.parse(line) as {
        id: number
        result: { contents?: Array<{ blob?: string }>; _meta?: Record<string, unknown> }
      })
      const previews = responses.find(response => response.id === 3)?.result._meta?.["pippit/media"] as Array<{
        filename: string
        resource_uri: string
      }>
      expect(previews).toHaveLength(1)
      expect(previews[0]?.filename).toMatch(/pippit-video-[a-f0-9]{64}\.mp4$/u)
      expect(JSON.stringify(responses.find(response => response.id === 3)?.result)).not.toContain("local_path")
      expect(JSON.stringify(responses.find(response => response.id === 3)?.result)).not.toContain(outputRoot)
      const localPath = join(outputRoot, previews[0]!.filename)
      expect(new Uint8Array(await readFile(localPath))).toEqual(bytes)
      const chunkUri = new URL(previews[0]!.resource_uri)
      chunkUri.searchParams.set("length", "4")
      chunkUri.searchParams.set("offset", "4")
      input.write(`${JSON.stringify({
        id: 4,
        jsonrpc: "2.0",
        method: "resources/read",
        params: { uri: chunkUri.toString() },
      })}\n`)
      await vi.waitFor(() => expect(stdout.trim().split("\n")).toHaveLength(4))
      responses = stdout.trim().split("\n").map(line => JSON.parse(line) as {
        id: number
        result: { contents?: Array<{ blob?: string }>; _meta?: Record<string, unknown> }
      })
      const chunk = responses.find(response => response.id === 4)?.result.contents?.[0]?.blob
      expect(chunk).toBeDefined()
      expect(new Uint8Array(Buffer.from(chunk ?? "", "base64"))).toEqual(bytes.slice(4))
      input.end()
      await running
      expect(new Uint8Array(await readFile(localPath))).toEqual(bytes)

      const shouldNotDownload = vi.fn(async () => { throw new Error("unexpected download") })
      const restarted = createPippitWidgetMediaServer({
        artifactRoot: outputRoot,
        backend: { downloadVideo: shouldNotDownload },
      })
      const restartedInput = new PassThrough()
      const restartedOutput = new PassThrough()
      let restartedStdout = ""
      restartedOutput.setEncoding("utf8").on("data", (value: string) => {
        restartedStdout += value
      })
      const facadeCall = vi.fn(async () => {
        throw new Error("the facade runtime must not be initialized")
      })
      const restartedRunning = runPippitStdioServer({
        input: restartedInput,
        output: restartedOutput,
        runtime: { callTool: facadeCall, listTools: () => [] },
        widgetMedia: restarted,
      })
      try {
        restartedInput.write([
          JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-11-25" } }),
          JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list" }),
          JSON.stringify({
            id: 3,
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
              arguments: { length: 4, offset: 4, resource_uri: previews[0]!.resource_uri },
              name: PIPPIT_READ_VIDEO_CHUNK_TOOL_NAME,
            },
          }),
          "",
        ].join("\n"))
        await vi.waitFor(() => expect(restartedStdout.trim().split("\n")).toHaveLength(3))
        restartedInput.end()
        await restartedRunning
        const restartedResponses = restartedStdout.trim().split("\n").map(line => JSON.parse(line) as {
          id: number
          result: { structuredContent?: Record<string, unknown>; tools?: Array<Record<string, unknown>> }
        })
        const tools = restartedResponses.find(response => response.id === 2)?.result.tools ?? []
        expect(tools).toContainEqual(expect.objectContaining({
          _meta: {
            ui: { visibility: ["app"] },
            "openai/widgetAccessible": true,
          },
          name: PIPPIT_READ_VIDEO_CHUNK_TOOL_NAME,
        }))
        const recovered = restartedResponses.find(response => response.id === 3)?.result.structuredContent
        expect(recovered).toEqual({
          blob: Buffer.from(bytes.slice(4)).toString("base64"),
          bytes: bytes.byteLength - 4,
          complete: true,
          mime_type: "video/mp4",
          offset: 4,
          resource_uri: previews[0]!.resource_uri,
          total_bytes: bytes.byteLength,
        })
        expect(JSON.stringify(restartedResponses)).not.toContain(outputRoot)
        expect(facadeCall).not.toHaveBeenCalled()
        expect(shouldNotDownload).not.toHaveBeenCalled()
      } finally {
        restartedInput.end()
        await restartedRunning.catch(() => undefined)
      }
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
            resourceUri: `pippit-video://artifact/${String(index).padStart(64, "0")}`,
          }
        },
        async readChunk() { return undefined },
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
        resource_uri: `pippit-video://artifact/${"0".repeat(64)}`,
      },
    ])
    expect(JSON.stringify(callResult)).not.toContain("unsigned_urls")
    expect(JSON.stringify(callResult)).not.toContain("local_path")
    expect(JSON.stringify(callResult)).not.toContain("/Movies/Pippit")
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
        async readChunk() { return undefined },
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
