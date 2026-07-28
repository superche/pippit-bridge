import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { open, rename, unlink, type FileHandle } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { PrivateFileError } from "./errors.js"
import {
  syncPrivateDirectoryAfterMutation,
  type PrivateFileDurabilityOptions,
} from "./durability.js"

export async function atomicReplacePrivateFile(
  path: string,
  contents: Uint8Array,
  options: PrivateFileDurabilityOptions = {},
): Promise<void> {
  const directoryPath = dirname(path)
  const temporaryPath = join(directoryPath, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let handle: FileHandle | undefined
  let renamed = false
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
    await rename(temporaryPath, path)
    renamed = true
    await syncPrivateDirectoryAfterMutation(
      directoryPath,
      "Private file was replaced but directory durability is uncertain.",
      options,
    )
  } catch (error) {
    if (error instanceof PrivateFileError) throw error
    if (renamed) {
      throw new PrivateFileError(
        "DURABILITY_UNCERTAIN",
        "Private file was replaced but directory durability is uncertain.",
      )
    }
    throw new PrivateFileError("PRIVATE_FILE_INVALID", "Private file could not be replaced.")
  } finally {
    await handle?.close().catch(() => undefined)
    if (!renamed) await unlink(temporaryPath).catch(() => undefined)
  }
}
