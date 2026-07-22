import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { PrivateFileError } from "./errors.js"

export interface PrivateFileDurabilityOptions {
  readonly syncDirectory?: (directoryPath: string) => Promise<void>
}

export async function syncPrivateDirectoryAfterMutation(
  directoryPath: string,
  message: string,
  options: PrivateFileDurabilityOptions = {},
): Promise<void> {
  try {
    if (options.syncDirectory !== undefined) {
      await options.syncDirectory(directoryPath)
      return
    }
    if (process.platform === "win32") return
    const directory = await open(directoryPath, constants.O_RDONLY)
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch {
    throw new PrivateFileError("DURABILITY_UNCERTAIN", message)
  }
}
