import { acquirePrivateFileLock, type OwnedPrivateFileLock, type PrivateFileLockOptions } from "./lock.js"

export async function withPrivateFileTransaction<T>(
  lockPath: string,
  operation: (lock: OwnedPrivateFileLock) => Promise<T>,
  options?: PrivateFileLockOptions,
): Promise<T> {
  const lock = await acquirePrivateFileLock(lockPath, options)
  try {
    return await operation(lock)
  } finally {
    await lock.release()
  }
}

export class PrivateFileLifetimeLock {
  private constructor(private readonly lock: OwnedPrivateFileLock) {}

  static async acquire(path: string, options?: PrivateFileLockOptions): Promise<PrivateFileLifetimeLock> {
    return new PrivateFileLifetimeLock(await acquirePrivateFileLock(path, options))
  }

  async close(): Promise<void> {
    await this.lock.release()
  }
}
