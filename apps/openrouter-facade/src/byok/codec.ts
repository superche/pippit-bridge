import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { z } from "zod"
import { ByokStoreError, type FileByokStoreOptions } from "./contracts.js"
import { storedStateSchema, type StoredState } from "./state.js"

const STORE_FORMAT = "pippit-byok-store"
const STORE_VERSION = 1
const DEFAULT_KEY_ID = "v1"
const DEFAULT_AAD_CONTEXT = "pippit-bridge"
const GCM_NONCE_BYTES = 12
const GCM_TAG_BYTES = 16

const envelopeSchema = z.object({
  ciphertext: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/u),
  format: z.literal(STORE_FORMAT),
  key_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u),
  nonce: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/u),
  tag: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/u),
  version: z.literal(STORE_VERSION),
}).strict()

function decodeBase64Url(value: string, expectedLength: number | undefined): Buffer {
  const decoded = Buffer.from(value, "base64url")
  if (decoded.toString("base64url") !== value ||
    (expectedLength !== undefined && decoded.length !== expectedLength)) {
    throw new ByokStoreError("STORE_CORRUPT", "The BYOK credential store envelope is malformed.")
  }
  return decoded
}

function normalizeMasterKey(value: Uint8Array, label: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new ByokStoreError("INVALID_CONFIGURATION", `${label} must contain exactly 32 bytes.`)
  }
  return Buffer.from(value)
}

export interface DecodedByokEnvelope {
  readonly keyId: string
  readonly state: StoredState
}

export class ByokEnvelopeCodec {
  readonly activeKeyId: string
  private readonly aadContext: string
  private readonly activeKey: Buffer
  private readonly keys = new Map<string, Buffer>()

  constructor(options: Pick<FileByokStoreOptions, "aadContext" | "keyId" | "masterKey" | "previousMasterKeys">) {
    this.activeKeyId = options.keyId ?? DEFAULT_KEY_ID
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(this.activeKeyId)) {
      throw new ByokStoreError("INVALID_CONFIGURATION", "The active BYOK key id is invalid.")
    }
    this.aadContext = options.aadContext ?? DEFAULT_AAD_CONTEXT
    const containsControlCharacter = [...this.aadContext].some(character => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint < 32 || codePoint === 127
    })
    if (this.aadContext.length < 1 || this.aadContext.length > 256 || containsControlCharacter) {
      throw new ByokStoreError("INVALID_CONFIGURATION", "The BYOK AAD context is invalid.")
    }
    this.activeKey = normalizeMasterKey(options.masterKey, "masterKey")
    this.keys.set(this.activeKeyId, this.activeKey)
    for (const [keyId, key] of Object.entries(options.previousMasterKeys ?? {})) {
      if (!/^[A-Za-z0-9._-]{1,128}$/u.test(keyId) || keyId === this.activeKeyId) {
        throw new ByokStoreError("INVALID_CONFIGURATION", "A previous BYOK key id is invalid or duplicated.")
      }
      this.keys.set(keyId, normalizeMasterKey(key, `previousMasterKeys.${keyId}`))
    }
  }

  decode(contents: Buffer): DecodedByokEnvelope {
    let envelope: z.output<typeof envelopeSchema>
    try {
      const raw: unknown = JSON.parse(contents.toString("utf8"))
      envelope = envelopeSchema.parse(raw)
    } catch {
      throw new ByokStoreError("STORE_CORRUPT", "The BYOK credential store envelope is malformed.")
    }
    const key = this.keys.get(envelope.key_id)
    if (key === undefined) {
      throw new ByokStoreError("STORE_CORRUPT", "The BYOK credential store uses an unavailable master key.")
    }
    const nonce = decodeBase64Url(envelope.nonce, GCM_NONCE_BYTES)
    const tag = decodeBase64Url(envelope.tag, GCM_TAG_BYTES)
    const ciphertext = decodeBase64Url(envelope.ciphertext, undefined)
    let plaintext: Buffer | undefined
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: GCM_TAG_BYTES })
      decipher.setAAD(this.aad(envelope.key_id))
      decipher.setAuthTag(tag)
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      const raw: unknown = JSON.parse(plaintext.toString("utf8"))
      return { keyId: envelope.key_id, state: storedStateSchema.parse(raw) }
    } catch {
      throw new ByokStoreError("STORE_CORRUPT", "The BYOK credential store failed authentication.")
    } finally {
      plaintext?.fill(0)
      nonce.fill(0)
      tag.fill(0)
      ciphertext.fill(0)
    }
  }

  encode(state: StoredState, maxFileBytes: number): Buffer {
    const nonce = randomBytes(GCM_NONCE_BYTES)
    const plaintext = Buffer.from(JSON.stringify(state), "utf8")
    try {
      const cipher = createCipheriv("aes-256-gcm", this.activeKey, nonce, { authTagLength: GCM_TAG_BYTES })
      cipher.setAAD(this.aad(this.activeKeyId))
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      const tag = cipher.getAuthTag()
      const output = Buffer.from(JSON.stringify({
        ciphertext: ciphertext.toString("base64url"),
        format: STORE_FORMAT,
        key_id: this.activeKeyId,
        nonce: nonce.toString("base64url"),
        tag: tag.toString("base64url"),
        version: STORE_VERSION,
      }), "utf8")
      ciphertext.fill(0)
      tag.fill(0)
      if (output.length > maxFileBytes) {
        output.fill(0)
        throw new ByokStoreError("CREDENTIAL_LIMIT_EXCEEDED", "The encrypted BYOK store exceeds its file-size limit.")
      }
      return output
    } finally {
      plaintext.fill(0)
      nonce.fill(0)
    }
  }

  destroy(): void {
    for (const key of this.keys.values()) key.fill(0)
    this.keys.clear()
  }

  private aad(keyId: string): Buffer {
    return Buffer.from(`${STORE_FORMAT}\u0000${STORE_VERSION}\u0000${keyId}\u0000${this.aadContext}`, "utf8")
  }
}
