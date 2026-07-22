import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, open, unlink, type FileHandle } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import {
  syncPrivateDirectoryAfterMutation,
  type PrivateFileDurabilityOptions,
} from "./durability.js"
import { PrivateFileError } from "./errors.js"

function nodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

async function waitForPeerLink(path: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const metadata = await lstat(path).catch((error: unknown) => {
      if (nodeError(error, "ENOENT")) return undefined
      throw error
    })
    if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink <= 1) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

export async function createPrivateFileIfAbsent(
  path: string,
  contents: Uint8Array,
  options: PrivateFileDurabilityOptions = {},
): Promise<"created" | "exists"> {
  const directoryPath = dirname(path)
  const temporaryPath = join(directoryPath, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let handle: FileHandle | undefined
  let linked = false
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    await handle.writeFile(contents)
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      await link(temporaryPath, path)
    } catch (error) {
      if (nodeError(error, "EEXIST")) {
        await waitForPeerLink(path)
        return "exists"
      }
      throw error
    }
    linked = true
    await syncPrivateDirectoryAfterMutation(
      directoryPath,
      "Private file was created but directory durability is uncertain.",
      options,
    )
    return "created"
  } catch (error) {
    if (error instanceof PrivateFileError) throw error
    if (linked) {
      throw new PrivateFileError(
        "DURABILITY_UNCERTAIN",
        "Private file was created but directory durability is uncertain.",
      )
    }
    throw new PrivateFileError("PRIVATE_FILE_INVALID", "Private file could not be created safely.")
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
  }
}
