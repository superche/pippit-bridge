import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { isRecord, ToolInputError } from "./inputs.ts"

function inside(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined
}

async function ensureSafeOutputParent(root: string, segments: readonly string[]): Promise<string> {
  let current = root
  for (const segment of segments) {
    const next = resolve(current, segment)
    if (!inside(root, next)) throw new ToolInputError("output_path escapes PIPPIT_MCP_OUTPUT_ROOT.")
    try {
      await mkdir(next, { mode: 0o700 })
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
    const stats = await lstat(next)
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new ToolInputError("output_path contains a symbolic link or non-directory parent.")
    }
    current = await realpath(next)
    if (!inside(root, current)) {
      throw new ToolInputError("output_path escapes PIPPIT_MCP_OUTPUT_ROOT through a symbolic link.")
    }
  }
  return current
}

export async function writeDownload(input: {
  readonly maxBytes: number
  readonly outputRoot: string
  readonly relativePath: string
  readonly response: Response
}): Promise<{ readonly bytes: number; readonly mediaType: string }> {
  const declared = input.response.headers.get("content-length")
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > input.maxBytes)) {
    throw new ToolInputError("The video output exceeds the configured download byte limit.")
  }
  if (input.response.body === null) throw new ToolInputError("Pippit facade returned an empty video body.")
  await mkdir(input.outputRoot, { recursive: true })
  const root = await realpath(input.outputRoot)
  const relativeSegments = input.relativePath.split("/")
  const lexicalTarget = resolve(root, ...relativeSegments)
  if (!inside(root, lexicalTarget)) throw new ToolInputError("output_path escapes PIPPIT_MCP_OUTPUT_ROOT.")
  const parent = await ensureSafeOutputParent(root, relativeSegments.slice(0, -1))
  const target = resolve(parent, relativeSegments.at(-1) as string)
  const handle = await open(target, "wx", 0o600)
  let bytes = 0
  let succeeded = false
  try {
    const reader = input.response.body.getReader()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > input.maxBytes) {
          await reader.cancel()
          throw new ToolInputError("The video output exceeds the configured download byte limit.")
        }
        let offset = 0
        while (offset < chunk.value.byteLength) {
          const written = await handle.write(chunk.value, offset, chunk.value.byteLength - offset)
          offset += written.bytesWritten
        }
      }
    } finally {
      reader.releaseLock()
    }
    await handle.sync()
    succeeded = true
  } finally {
    await handle.close()
    if (!succeeded) await unlink(target).catch(() => undefined)
  }
  const mediaType = input.response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  return {
    bytes,
    mediaType: mediaType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)
      ? mediaType
      : "video/mp4",
  }
}
