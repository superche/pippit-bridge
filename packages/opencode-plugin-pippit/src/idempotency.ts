import { lstat } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import {
  createPrivateFileIfAbsent,
  ensurePrivateDirectory,
  FileIdempotencyStore,
  readPrivateFile,
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
  let contents: Buffer | undefined
  try {
    contents = await readPrivateFile(path, 4_096)
    const value: unknown = JSON.parse(contents.toString("utf8"))
    if (
      !isRecord(value) ||
      value.schema_version !== 1 ||
      typeof value.idempotency_hmac_key_hex !== "string" ||
      !HEX_KEY_PATTERN.test(value.idempotency_hmac_key_hex)
    ) {
      throw new Error("The OpenCode idempotency secret is invalid.")
    }
    return value as unknown as SecretDocument
  } catch (error) {
    throw new Error("The OpenCode idempotency secret is invalid or unsafe.", { cause: error })
  } finally {
    contents?.fill(0)
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
  const contents = Buffer.from(`${JSON.stringify(value)}\n`, "utf8")
  try {
    await createPrivateFileIfAbsent(path, contents)
  } finally {
    contents.fill(0)
  }
  return readSecret(path)
}

async function openStore(statePath: string): Promise<IdempotencyStore> {
  const directory = join(statePath, "pippit")
  await ensurePrivateDirectory(directory)
  const recordsPath = join(directory, "idempotency-v1.json")
  const secretPath = join(directory, "idempotency-secret-v1.json")
  const secret = await ((await pathExists(secretPath)) ? readSecret(secretPath) : createSecret(secretPath, recordsPath))
  const hmacKey = Buffer.from(secret.idempotency_hmac_key_hex, "hex")
  try {
    return new FileIdempotencyStore({ filePath: recordsPath, hmacKey })
  } finally {
    hmacKey.fill(0)
  }
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
