import { constants } from "node:fs"
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import {
  FileIdempotencyStore,
  type IdempotencyBeginInput,
  type IdempotencyBeginResult,
  type IdempotencyStore,
} from "@pippit-bridge/core"

const HEX_KEY_PATTERN = /^[a-f0-9]{64}$/u

interface SecretDocument {
  readonly idempotency_hmac_key_hex: string
  readonly schema_version: 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false
    throw error
  }
}

async function readSecret(path: string): Promise<SecretDocument> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 4_096) {
      throw new Error("The OpenCode idempotency secret is not a private bounded file.")
    }
    const value: unknown = JSON.parse(await handle.readFile("utf8"))
    if (
      !isRecord(value) ||
      value.schema_version !== 1 ||
      typeof value.idempotency_hmac_key_hex !== "string" ||
      !HEX_KEY_PATTERN.test(value.idempotency_hmac_key_hex)
    ) {
      throw new Error("The OpenCode idempotency secret is invalid.")
    }
    return value as unknown as SecretDocument
  } finally {
    await handle.close()
  }
}

async function createSecret(path: string, recordsPath: string): Promise<SecretDocument> {
  if (await pathExists(recordsPath)) {
    throw new Error("An OpenCode idempotency store exists without its HMAC key; refusing to replace the key.")
  }
  const value = {
    idempotency_hmac_key_hex: randomBytes(32).toString("hex"),
    schema_version: 1,
  } as const
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`
  const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await link(temporaryPath, path)
    await chmod(path, 0o600)
    const directory = await open(dirname(path), constants.O_RDONLY)
    try { await directory.sync() } finally { await directory.close() }
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error
  } finally {
    await unlink(temporaryPath).catch(() => {})
  }
  return readSecret(path)
}

async function openStore(statePath: string): Promise<IdempotencyStore> {
  const directory = join(statePath, "pippit")
  await mkdir(directory, { mode: 0o700, recursive: true })
  await chmod(directory, 0o700)
  const recordsPath = join(directory, "idempotency-v1.json")
  const secretPath = join(directory, "idempotency-secret-v1.json")
  const secret = await ((await pathExists(secretPath)) ? readSecret(secretPath) : createSecret(secretPath, recordsPath))
  return new FileIdempotencyStore({
    filePath: recordsPath,
    hmacKey: Buffer.from(secret.idempotency_hmac_key_hex, "hex"),
  })
}

export class LazyOpenCodeIdempotencyStore implements IdempotencyStore {
  readonly #statePath: () => Promise<string>
  #storePromise: Promise<IdempotencyStore> | undefined

  constructor(statePath: () => Promise<string>) {
    this.#statePath = statePath
  }

  async #store(): Promise<IdempotencyStore> {
    this.#storePromise ??= this.#statePath().then((statePath) => openStore(statePath))
    return this.#storePromise
  }

  async begin(input: IdempotencyBeginInput): Promise<IdempotencyBeginResult> {
    return (await this.#store()).begin(input)
  }

  async markFailed(recordId: string, errorCode: string): Promise<void> {
    await (await this.#store()).markFailed(recordId, errorCode)
  }

  async markIndeterminate(recordId: string): Promise<void> {
    await (await this.#store()).markIndeterminate(recordId)
  }

  async markPreparing(recordId: string): Promise<void> {
    await (await this.#store()).markPreparing(recordId)
  }

  async markSubmitted(recordId: string, response: unknown): Promise<void> {
    await (await this.#store()).markSubmitted(recordId, response)
  }

  async markSubmitting(recordId: string): Promise<void> {
    await (await this.#store()).markSubmitting(recordId)
  }

  async close(): Promise<void> {
    if (this.#storePromise !== undefined) await (await this.#storePromise).close()
  }
}
