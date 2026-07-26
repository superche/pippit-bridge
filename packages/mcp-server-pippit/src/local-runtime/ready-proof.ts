import { createHmac, timingSafeEqual } from "node:crypto"
import { isAbsolute, resolve } from "node:path"
import {
  PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION,
  PippitLocalRuntimeError,
  type LocalRuntimeReadyDescriptor,
  type LocalRuntimeReadyPayload,
} from "./contracts.ts"
import { HEX_KEY_PATTERN, isRecord } from "./state-files.ts"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
export const RUNTIME_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
const ARTIFACT_HASH_PATTERN = /^[a-f0-9]{64}$/u

function hasArtifactIdentity(
  value: Partial<LocalRuntimeReadyPayload>,
): value is Partial<LocalRuntimeReadyPayload> & {
  readonly daemon_artifact_sha256: string
  readonly daemon_entry: string
} {
  return typeof value.daemon_artifact_sha256 === "string" && typeof value.daemon_entry === "string"
}

function readyPayload(value: LocalRuntimeReadyDescriptor): LocalRuntimeReadyPayload {
  return {
    ...(hasArtifactIdentity(value)
      ? {
          daemon_artifact_sha256: value.daemon_artifact_sha256,
          daemon_entry: value.daemon_entry,
        }
      : {}),
    instance_id: value.instance_id, pid: value.pid, port: value.port,
    runtime_version: value.runtime_version, schema_version: value.schema_version, started_at: value.started_at,
  }
}

function readyPayloadString(value: LocalRuntimeReadyPayload): string {
  if (hasArtifactIdentity(value)) {
    return JSON.stringify([
      "pippit-local-runtime-ready",
      2,
      value.schema_version,
      value.runtime_version,
      value.daemon_artifact_sha256,
      value.daemon_entry,
      value.pid,
      value.port,
      value.instance_id,
      value.started_at,
    ])
  }
  return [value.schema_version, value.runtime_version, value.pid, value.port, value.instance_id, value.started_at].join("\n")
}

export function signLocalRuntimeReadyPayload(payload: LocalRuntimeReadyPayload, proofKeyHex: string): string {
  const key = Buffer.from(proofKeyHex, "hex")
  try {
    return createHmac("sha256", key).update(readyPayloadString(payload), "utf8").digest("hex")
  } finally {
    key.fill(0)
  }
}

export function createLocalRuntimeProof(
  instanceId: string,
  challenge: string,
  proofKeyHex: string,
  identity?: { readonly artifactHash: string; readonly entryPath: string },
): string {
  const key = Buffer.from(proofKeyHex, "hex")
  try {
    return createHmac("sha256", key)
      .update(identity === undefined
        ? `pippit-local-runtime\nv1\n${instanceId}\n${challenge}`
        : JSON.stringify([
            "pippit-local-runtime-proof",
            2,
            instanceId,
            challenge,
            identity.artifactHash,
            identity.entryPath,
          ]), "utf8").digest("hex")
  } finally {
    key.fill(0)
  }
}

export function createLocalRuntimeShutdownProof(
  instanceId: string,
  challenge: string,
  proofKeyHex: string,
  identity: { readonly artifactHash: string; readonly entryPath: string },
): string {
  const key = Buffer.from(proofKeyHex, "hex")
  try {
    return createHmac("sha256", key)
      .update(JSON.stringify([
        "pippit-local-runtime-shutdown",
        1,
        instanceId,
        challenge,
        identity.artifactHash,
        identity.entryPath,
      ]), "utf8").digest("hex")
  } finally {
    key.fill(0)
  }
}

export function parseReadyDescriptor(value: unknown, proofKeyHex: string): LocalRuntimeReadyDescriptor {
  if (!isRecord(value)) throw new PippitLocalRuntimeError("invalid_ready_descriptor", "Local runtime readiness state is invalid.")
  const candidate = value as Partial<LocalRuntimeReadyDescriptor>
  const hasArtifactHash = candidate.daemon_artifact_sha256 !== undefined
  const hasDaemonEntry = candidate.daemon_entry !== undefined
  if (candidate.schema_version !== PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION
    || typeof candidate.runtime_version !== "string" || candidate.runtime_version.length > 64
    || !RUNTIME_VERSION_PATTERN.test(candidate.runtime_version)
    || hasArtifactHash !== hasDaemonEntry
    || (hasArtifactHash && (
      typeof candidate.daemon_artifact_sha256 !== "string"
      || !ARTIFACT_HASH_PATTERN.test(candidate.daemon_artifact_sha256)
      || typeof candidate.daemon_entry !== "string"
      || candidate.daemon_entry.length > 4_096
      || !isAbsolute(candidate.daemon_entry)
      || resolve(candidate.daemon_entry) !== candidate.daemon_entry
    ))
    || typeof candidate.pid !== "number" || !Number.isSafeInteger(candidate.pid) || candidate.pid < 1
    || typeof candidate.port !== "number" || !Number.isSafeInteger(candidate.port) || candidate.port < 1 || candidate.port > 65_535
    || typeof candidate.instance_id !== "string" || !UUID_PATTERN.test(candidate.instance_id)
    || typeof candidate.started_at !== "string" || !Number.isFinite(Date.parse(candidate.started_at))
    || typeof candidate.signature !== "string" || !HEX_KEY_PATTERN.test(candidate.signature)) {
    throw new PippitLocalRuntimeError("invalid_ready_descriptor", "Local runtime readiness state is invalid.")
  }
  const expected = Buffer.from(signLocalRuntimeReadyPayload(readyPayload(candidate as LocalRuntimeReadyDescriptor), proofKeyHex), "hex")
  const actual = Buffer.from(candidate.signature, "hex")
  try {
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new PippitLocalRuntimeError("invalid_ready_signature", "Local runtime readiness state is not authentic.")
    }
  } finally {
    expected.fill(0)
    actual.fill(0)
  }
  return candidate as LocalRuntimeReadyDescriptor
}
