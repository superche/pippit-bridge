import { constants, type Stats } from "node:fs"
import { lstat, open, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import {
  syncPrivateDirectoryAfterMutation,
  type PrivateFileDurabilityOptions,
} from "./durability.js"
import { PrivateFileError } from "./errors.js"

function sameFile(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function safeMetadata(metadata: Stats, maxBytes: number): boolean {
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1
    && metadata.size > 0
    && metadata.size <= maxBytes
    && (process.platform === "win32"
      || ((metadata.mode & 0o077) === 0
        && (process.getuid === undefined || metadata.uid === process.getuid())))
}

export async function removePrivateFileIf(
  path: string,
  maxBytes: number,
  predicate: (contents: Buffer) => boolean,
  options: PrivateFileDurabilityOptions = {},
): Promise<boolean> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw new PrivateFileError("PRIVATE_FILE_INVALID", "Private file could not be opened for removal.")
  }
  try {
    const opened = await handle.stat()
    if (!safeMetadata(opened, maxBytes)) {
      throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private file metadata is unsafe for removal.")
    }
    if (!predicate(await handle.readFile())) return false
    const current = await lstat(path)
    if (!safeMetadata(current, maxBytes) || !sameFile(opened, current)) {
      throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private file changed before removal.")
    }
    await unlink(path)
    await syncPrivateDirectoryAfterMutation(
      dirname(path),
      "Private file was removed but directory durability is uncertain.",
      options,
    )
    return true
  } finally {
    await handle.close()
  }
}
