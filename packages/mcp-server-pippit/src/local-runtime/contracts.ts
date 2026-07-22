export const PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION = 1
// Advance only when the bundled daemon changes; the package/plugin version may move independently.
export const PIPPIT_LOCAL_RUNTIME_VERSION = "0.2.6"

export interface LocalRuntimeSecrets {
  readonly bootstrap_proof_key_hex: string
  readonly byok_encryption_key_hex: string
  readonly chatgpt_media_signing_key_hex: string
  readonly created_at: string
  readonly facade_api_key: string
  readonly job_signing_key_hex: string
  readonly management_api_key: string
  readonly schema_version: 1
}

export interface LocalRuntimeReadyPayload {
  readonly instance_id: string
  readonly pid: number
  readonly port: number
  readonly runtime_version: string
  readonly schema_version: 1
  readonly started_at: string
}

export interface LocalRuntimeIdempotencySecret {
  readonly idempotency_hmac_key_hex: string
  readonly schema_version: 1
}

export interface LocalRuntimeReadyDescriptor extends LocalRuntimeReadyPayload {
  readonly signature: string
}

export interface BootstrapLockPayload {
  readonly created_at: string
  readonly pid: number
  readonly schema_version: 1
}

export interface ByokStoreLockPayload { readonly pid: number }

export interface PippitLocalRuntimePaths {
  readonly bootstrapLockPath: string
  readonly byokDirectory: string
  readonly byokStorePath: string
  readonly configPath: string
  readonly dataRoot: string
  readonly idempotencyDirectory: string
  readonly idempotencySecretPath: string
  readonly idempotencyStorePath: string
  readonly outputRoot: string
  readonly readyPath: string
}

export interface PippitResolvedRuntimeEnvironment {
  readonly environment: NodeJS.ProcessEnv
  readonly local?: { readonly dataRoot: string; readonly mediaSigningKeyHex: string }
  readonly mode: "external" | "local"
}

export class PippitLocalRuntimeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "PippitLocalRuntimeError"
    this.code = code
  }
}

export interface LocalRuntimeReadyConnection {
  readonly baseUrl: string
  readonly descriptor: LocalRuntimeReadyDescriptor
}
