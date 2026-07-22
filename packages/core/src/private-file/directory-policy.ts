import { lstat, mkdir } from "node:fs/promises"
import { PrivateFileError } from "./errors.js"

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true })
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private storage parent must be a real directory.")
  }
  if (process.platform !== "win32") {
    if ((metadata.mode & 0o077) !== 0) {
      throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private storage directory must use permissions 0700 or stricter.")
    }
    if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
      throw new PrivateFileError("PRIVATE_FILE_UNSAFE", "Private storage directory must be owned by the current user.")
    }
  }
}
