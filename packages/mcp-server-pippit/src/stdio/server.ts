#!/usr/bin/env node

import { realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolvePippitLocalRuntimePaths } from "../local-runtime.ts"
import { createPippitMcpMessageHandler } from "../protocol.ts"
import type { PippitToolRuntime } from "../tools.ts"
import { createPippitWidgetMediaServer, type PippitWidgetMediaServer } from "../widget-media.ts"
import {
  createPersistentPippitWidgetLineageStore,
  type PippitWidgetLineageStore,
} from "../widget-lineage.ts"
import { createLazyPippitToolRuntime } from "./lazy-runtime.ts"
import { serveJsonRpcLines } from "./transport.ts"
import { withWidgetRuntime } from "./widget-runtime.ts"

export {
  createLazyPippitToolRuntime,
  resolvePippitStdioMediaOutputRoot,
} from "./lazy-runtime.ts"
export {
  PIPPIT_GET_IMAGE_TOOL_NAME,
  PIPPIT_READ_IMAGE_TOOL_NAME,
  PIPPIT_READ_VIDEO_CHUNK_TOOL_NAME,
  PIPPIT_RESOLVE_LATEST_VIDEO_TOOL_NAME,
  PIPPIT_REVEAL_IMAGE_TOOL_NAME,
} from "./widget-tools.ts"

export interface PippitStdioServerOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly input?: NodeJS.ReadableStream
  readonly output?: NodeJS.WritableStream
  readonly runtime?: PippitToolRuntime
  readonly widgetLineage?: PippitWidgetLineageStore
  readonly widgetMedia?: PippitWidgetMediaServer
}

export async function runPippitStdioServer(options: PippitStdioServerOptions = {}): Promise<void> {
  const env = options.env ?? process.env
  const lazy = options.runtime === undefined
    ? createLazyPippitToolRuntime(env)
    : {
        mediaBackend: {
          async downloadVideo(): Promise<Response> {
            throw new Error("The injected runtime did not provide a widget media backend.")
          },
        },
        async resolveMediaOutputRoot(): Promise<string> {
          return resolvePippitLocalRuntimePaths(env).outputRoot
        },
        async resolveLineageScope(): Promise<string> { return "injected-runtime" },
        runtime: options.runtime,
      }
  const widgetMedia = options.widgetMedia ?? createPippitWidgetMediaServer({
    artifactRoot: lazy.resolveMediaOutputRoot,
    backend: lazy.mediaBackend,
  })
  const runtimePaths = resolvePippitLocalRuntimePaths(env)
  const widgetLineage = options.widgetLineage ?? createPersistentPippitWidgetLineageStore({
    root: join(runtimePaths.dataRoot, "widget-state", "lineage-v1"),
    scope: lazy.resolveLineageScope,
  })
  const runtime = withWidgetRuntime(lazy.runtime, widgetMedia, widgetLineage)
  await serveJsonRpcLines({
    handler: createPippitMcpMessageHandler(runtime, widgetMedia),
    readable: options.input ?? process.stdin,
    runtime,
    writable: options.output ?? process.stdout,
  })
}

export function isPippitStdioEntrypoint(
  argvPath: string | undefined = process.argv[1],
  moduleUrl = import.meta.url,
): boolean {
  if (argvPath === undefined) return false
  try {
    return realpathSync(resolve(argvPath)) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return pathToFileURL(resolve(argvPath)).href === moduleUrl
  }
}
