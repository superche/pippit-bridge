import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { PrivateFileError } from "./errors.js"

function nodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

async function readPrivateFileInternal(path: string, maxBytes: number, allowMissing: boolean): Promise<Buffer | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    if (allowMissing && nodeError(error, "ENOENT")) return undefined
    throw new PrivateFileError("PRIVATE_FILE_INVALID", "Private file could not be opened.")
  })
  if (handle === undefined) return undefined
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > maxBytes) {
      throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private file metadata is unsafe.")
    }
    if (process.platform !== "win32") {
      if ((metadata.mode & 0o077) !== 0 || (process.getuid !== undefined && metadata.uid !== process.getuid())) {
        throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private file permissions or owner are unsafe.")
      }
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

export async function readPrivateFile(path: string, maxBytes: number): Promise<Buffer> {
  const contents = await readPrivateFileInternal(path, maxBytes, false)
  if (contents === undefined) throw new PrivateFileError("PRIVATE_FILE_INVALID", "Private file could not be opened.")
  return contents
}

export async function readPrivateFileIfExists(path: string, maxBytes: number): Promise<Buffer | undefined> {
  return await readPrivateFileInternal(path, maxBytes, true)
}
