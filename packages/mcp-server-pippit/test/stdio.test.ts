import { spawn } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"

import { describe, expect, it, vi } from "vitest"

import { defaultPippitOutputDirectory } from "../src/options.ts"
import {
  PIPPIT_READ_VIDEO_CHUNK_TOOL_NAME,
  PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_NAME,
  isPippitStdioEntrypoint,
  resolvePippitStdioMediaOutputRoot,
  runPippitStdioServer,
} from "../src/stdio.ts"
import { PIPPIT_RUNTIME_TOOL_DEFINITIONS } from "../src/tools.ts"
import { createInMemoryPippitWidgetLineageStore } from "../src/widget-lineage.ts"
import { createPippitWidgetMediaServer } from "../src/widget-media.ts"
import { PIPPIT_IMAGE_WIDGET_URI } from "../src/image-widget.ts"
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
    const installedRoot = await mkdtemp(join(tmpdir(), "pippit-installed-plugin-"))
    const manifest = JSON.parse(await readFile(join(packageRoot, ".mcp.json"), "utf8")) as {
      mcpServers?: { "pippit-video"?: { args?: string[]; command?: string; tool_timeout_sec?: number } }
    }
    const pluginServer = manifest.mcpServers?.["pippit-video"]
    expect(pluginServer?.command).toBe("/bin/sh")
    expect(pluginServer?.args).toEqual(["./plugin-entry.sh"])
    expect(pluginServer?.tool_timeout_sec).toBe(43_200)

    try {
      await mkdir(join(installedRoot, "dist"), { recursive: true })
      await Promise.all([
        cp(join(packageRoot, "package.json"), join(installedRoot, "package.json")),
        cp(join(packageRoot, "plugin-entry.mjs"), join(installedRoot, "plugin-entry.mjs")),
        cp(join(packageRoot, "plugin-entry.sh"), join(installedRoot, "plugin-entry.sh")),
        cp(join(packageRoot, "dist", "plugin-stdio.mjs"), join(installedRoot, "dist", "plugin-stdio.mjs")),
        cp(join(packageRoot, "dist", "local-facade-daemon.mjs"), join(installedRoot, "dist", "local-facade-daemon.mjs")),
      ])
      const protocol = [
        {
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "isolated-plugin-test", version: "1" },
            protocolVersion: "2025-11-25",
          },
        },
        { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
        {
          id: 3,
          jsonrpc: "2.0",
          method: "resources/read",
          params: { uri: PIPPIT_WIDGET_URI },
        },
      ]

      const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
        const child = spawn(pluginServer!.command!, pluginServer!.args!, {
          cwd: installedRoot,
          env: {
            PATH: "/usr/bin:/bin",
            PIPPIT_FACADE_API_KEY: "runtime-test-key",
            PIPPIT_FACADE_BASE_URL: "http://127.0.0.1:3000",
            PIPPIT_NODE_PATH: process.execPath,
          },
          stdio: ["pipe", "pipe", "pipe"],
        })
        let stderr = ""
        let stdout = ""
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
        child.once("error", reject)
        child.once("close", (code) => resolve({ code, stderr, stdout }))
        child.stdin.end(`${protocol.map((message) => JSON.stringify(message)).join("\n")}\n`)
      })
      expect(result.code).toBe(0)
      expect(result.stderr).toBe("")
      const responses = result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as {
          id: number
          result?: {
            contents?: Array<{ text?: string }>
            serverInfo?: { name?: string }
            tools?: { name?: string }[]
          }
        })
      expect(responses.find((response) => response.id === 1)?.result?.serverInfo?.name).toBe("pippit-video")
      expect(responses.find((response) => response.id === 2)?.result?.tools)
        .toContainEqual(expect.objectContaining({ name: "pippit_generate_image" }))
      expect(responses.find((response) => response.id === 2)?.result?.tools)
        .toContainEqual(expect.objectContaining({ name: "pippit_list_video_models" }))
      expect(responses.find((response) => response.id === 3)?.result?.contents?.[0]?.text)
        .toBe(await readFile(join(packageRoot, "assets/generated/pippit-video-job-v15.html"), "utf8"))
    } finally {
      await rm(installedRoot, { force: true, recursive: true })
    }
  })

  it("exposes generated images through the Codex result widget without a second generation", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "pippit-image-widget-"))
    const input = new PassThrough()
    const output = new PassThrough()
    let stdout = ""
    output.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    const imageDefinition = PIPPIT_RUNTIME_TOOL_DEFINITIONS.find(
      (definition) => definition.name === "pippit_generate_image",
    )
    if (imageDefinition === undefined) throw new Error("Missing image generation definition in test.")
    const generateImage = vi.fn(async () => ({
      content: [
        { text: "Generated 1 image.", type: "text" as const },
        { data: "aW1hZ2U=", mimeType: "image/jpeg", type: "image" as const },
      ],
      structuredContent: {
        created: 1_780_000_000,
        images: [{ media_type: "image/jpeg" }],
        model: "pippit/seedream-5.0",
      },
    }))
    const revealFile = vi.fn(async () => undefined)
    const running = runPippitStdioServer({
      input,
      output,
      runtime: {
        callTool: generateImage,
        listTools: () => [imageDefinition],
      },
      widgetMedia: createPippitWidgetMediaServer({
        artifactRoot: outputRoot,
        backend: { async downloadVideo() { throw new Error("Video download is not used in this test.") } },
        revealFile,
      }),
    })
    try {
      input.write([
        JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-11-25" } }),
        JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list" }),
        JSON.stringify({ id: 3, jsonrpc: "2.0", method: "resources/list" }),
        JSON.stringify({ id: 4, jsonrpc: "2.0", method: "resources/read", params: { uri: PIPPIT_IMAGE_WIDGET_URI } }),
        JSON.stringify({
          id: 5,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { model: "pippit/seedream-5.0", prompt: "A fishing cat" }, name: "pippit_generate_image" },
        }),
        "",
      ].join("\n"))
      await vi.waitFor(() => expect(stdout.trim().split("\n")).toHaveLength(5))
      let responses = stdout.trim().split("\n").map((line) => JSON.parse(line) as {
        id: number
        result: Record<string, unknown>
      })
      const tools = responses.find((response) => response.id === 2)?.result.tools as Array<{
        _meta?: Record<string, unknown>
        name?: string
      }>
      expect(tools[0]?._meta?.["openai/outputTemplate"]).toBe(PIPPIT_IMAGE_WIDGET_URI)
      expect(tools).toContainEqual(expect.objectContaining({
        name: "pippit_get_image",
        _meta: expect.objectContaining({ "openai/outputTemplate": PIPPIT_IMAGE_WIDGET_URI }),
      }))
      expect(tools).toContainEqual(expect.objectContaining({
        name: "pippit_reveal_image",
        _meta: expect.objectContaining({ ui: { visibility: ["app"] } }),
      }))
      expect(responses.find((response) => response.id === 3)?.result.resources).toEqual(
        expect.arrayContaining([expect.objectContaining({ uri: PIPPIT_IMAGE_WIDGET_URI })]),
      )
      expect(responses.find((response) => response.id === 4)?.result).toMatchObject({
        contents: [{ uri: PIPPIT_IMAGE_WIDGET_URI }],
      })
      const callResult = responses.find((response) => response.id === 5)?.result
      if (callResult === undefined) throw new Error("Missing image tools/call result in test.")
      expect(callResult.structuredContent).toMatchObject({
        image_job_id: expect.stringMatching(/^pimg_[a-f0-9]{32}$/u),
        model: "pippit/seedream-5.0",
        status: "in_progress",
      })
      const imageJobId = (callResult.structuredContent as Record<string, string>).image_job_id
      await vi.waitFor(async () => expect(await readdir(outputRoot)).toHaveLength(1))
      let completedResult: Record<string, unknown> | undefined
      for (let attempt = 0; attempt < 20 && completedResult === undefined; attempt += 1) {
        input.write(`${JSON.stringify({
          id: 6,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { image_job_id: imageJobId }, name: "pippit_get_image" },
        })}\n`)
        await vi.waitFor(() => expect(stdout.trim().split("\n")).toHaveLength(6 + attempt))
        responses = stdout.trim().split("\n").map((line) => JSON.parse(line) as {
          id: number
          result: Record<string, unknown>
        })
        const polledResult = responses.filter((response) => response.id === 6).at(-1)?.result
        const status = (polledResult?.structuredContent as Record<string, unknown> | undefined)?.status
        if (polledResult !== undefined && status !== "in_progress") completedResult = polledResult
      }
      if (completedResult === undefined) throw new Error("Missing completed image result in test.")
      expect(completedResult.content).toEqual([{ text: "Generated 1 image.", type: "text" }])
      expect(JSON.stringify(completedResult)).not.toContain("aW1hZ2U=")
      const images = (completedResult._meta as Record<string, unknown>)["pippit/images"] as Array<{
        data?: string
        filename: string
        resource_uri: string
      }>
      expect(images).toEqual([
        expect.objectContaining({
          filename: expect.stringMatching(/^pippit-image-[a-f0-9]{64}\.jpg$/u),
          mime_type: "image/jpeg",
          resource_uri: expect.stringMatching(/^pippit-image:\/\/artifact\/[a-f0-9]{64}\.jpg$/u),
        }),
      ])
      expect(images[0]).not.toHaveProperty("data")
      expect(completedResult.structuredContent).toMatchObject({
        images: [{
          filename: images[0]!.filename,
          media_type: "image/jpeg",
          resource_uri: images[0]!.resource_uri,
        }],
      })
      expect(await readdir(outputRoot)).toEqual([images[0]!.filename])
      expect(await readFile(join(outputRoot, images[0]!.filename))).toEqual(Buffer.from("image"))

      input.write([
        JSON.stringify({
          id: 7,
          jsonrpc: "2.0",
          method: "resources/read",
          params: { uri: images[0]!.resource_uri },
        }),
        JSON.stringify({
          id: 8,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { resource_uri: images[0]!.resource_uri }, name: "pippit_read_image" },
        }),
        JSON.stringify({
          id: 9,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { resource_uri: images[0]!.resource_uri }, name: "pippit_reveal_image" },
        }),
        "",
      ].join("\n"))
      const responseCountAfterPoll = responses.length
      await vi.waitFor(() => expect(stdout.trim().split("\n")).toHaveLength(responseCountAfterPoll + 3))
      input.end()
      await running
      responses = stdout.trim().split("\n").map((line) => JSON.parse(line) as {
        id: number
        result: Record<string, unknown>
      })
      expect(responses.find((response) => response.id === 7)?.result).toMatchObject({
        contents: [{ blob: "aW1hZ2U=", mimeType: "image/jpeg", uri: images[0]!.resource_uri }],
      })
      expect(responses.find((response) => response.id === 8)?.result).toMatchObject({
        structuredContent: {
          blob: "aW1hZ2U=",
          filename: images[0]!.filename,
          mime_type: "image/jpeg",
          resource_uri: images[0]!.resource_uri,
        },
      })
      expect(responses.find((response) => response.id === 9)?.result).toMatchObject({
        structuredContent: { revealed: true },
      })
      expect(revealFile).toHaveBeenCalledWith(join(outputRoot, images[0]!.filename))
      expect(generateImage).toHaveBeenCalledOnce()
    } finally {
      input.end()
      await running.catch(() => undefined)
      await rm(outputRoot, { force: true, recursive: true })
    }
  })

  it("resolves a regenerated descendant after the original widget is recreated", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let stdout = ""
    output.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    const definitions = PIPPIT_RUNTIME_TOOL_DEFINITIONS.filter(definition =>
      definition.name === "pippit_edit_video_segment" || definition.name === "pippit_get_video")
    const running = runPippitStdioServer({
      input,
      output,
      runtime: {
        async callTool(name, args) {
          const jobId = name === "pippit_edit_video_segment"
            ? "job_regenerated"
            : (args as { job_id: string }).job_id
          const job = {
            id: jobId,
            model: "pippit/test",
            polling_url: `/api/v1/videos/${jobId}`,
            status: name === "pippit_edit_video_segment" ? "pending" : "completed",
            ...(name === "pippit_get_video" ? { unsigned_urls: ["private"] } : {}),
          }
          return { content: [{ text: JSON.stringify(job), type: "text" }], structuredContent: job }
        },
        listTools: () => definitions,
      },
      widgetLineage: createInMemoryPippitWidgetLineageStore(),
      widgetMedia: {
        async close() {},
        async listResources() { return { resources: [] } },
        async preparePreview(jobId) {
          return {
            bytes: 8,
            filename: "latest.mp4",
            localPath: "/private/latest.mp4",
            resourceUri: `pippit-video://artifact/${(jobId === "job_regenerated" ? "b" : "a").repeat(64)}`,
          }
        },
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
        params: {
          arguments: {
            annotations: [],
            idempotency_key: "edit-one",
            model: "pippit/test",
            prompt: "Make it blue",
            segment: { end_ms: 5_000, start_ms: 0 },
            source_job_id: "job_original",
          },
          name: "pippit_edit_video_segment",
        },
      }),
      JSON.stringify({
        id: 3,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { anchor_job_id: "job_original" },
          name: PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_NAME,
        },
      }),
      "",
    ].join("\n"))
    await vi.waitFor(() => expect(stdout.trim().split("\n")).toHaveLength(3))
    input.end()
    await running

    const responses = stdout.trim().split("\n").map(line => JSON.parse(line) as {
      id: number
      result: { _meta?: Record<string, unknown>; structuredContent?: { id?: string } }
    })
    const latest = responses.find(response => response.id === 3)?.result
    expect(latest?.structuredContent?.id).toBe("job_regenerated")
    expect((latest?._meta?.["pippit/media"] as Array<{ resource_uri?: string }> | undefined)?.[0]?.resource_uri)
      .toContain("b")
  })

  it("fails latest-video resolution instead of silently restoring the anchor", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let stdout = ""
    output.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    const callTool = vi.fn()
    const running = runPippitStdioServer({
      input,
      output,
      runtime: {
        callTool,
        listTools: () => [],
      },
      widgetLineage: {
        async record() {},
        async resolve() { throw new Error("corrupt state") },
        track() {},
      },
      widgetMedia: {
        async close() {},
        async listResources() { return { resources: [] } },
        async preparePreview() { throw new Error("unexpected preview") },
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
        params: {
          arguments: { anchor_job_id: "job_original" },
          name: PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_NAME,
        },
      }),
      "",
    ].join("\n"))
    await vi.waitFor(() => expect(stdout.trim().split("\n")).toHaveLength(2))
    input.end()
    await running

    const result = (JSON.parse(stdout.trim().split("\n")[1]!) as {
      result: { isError?: boolean; structuredContent?: { error?: { code?: string } } }
    }).result
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "latest_video_state_unavailable" } },
    })
    expect(callTool).not.toHaveBeenCalled()
    expect(stdout).not.toContain("corrupt state")
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
