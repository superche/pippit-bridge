import { createHmac, timingSafeEqual } from "node:crypto"
import {
  PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION,
  PippitLocalRuntimeError,
  type LocalRuntimeReadyDescriptor,
  type LocalRuntimeReadyPayload,
} from "./contracts.ts"
import { HEX_KEY_PATTERN, isRecord } from "./state-files.ts"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
export const RUNTIME_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

function readyPayload(value: LocalRuntimeReadyDescriptor): LocalRuntimeReadyPayload {
  return {
    instance_id: value.instance_id, pid: value.pid, port: value.port,
    runtime_version: value.runtime_version, schema_version: value.schema_version, started_at: value.started_at,
  }
}

function readyPayloadString(value: LocalRuntimeReadyPayload): string {
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

export function createLocalRuntimeProof(instanceId: string, challenge: string, proofKeyHex: string): string {
  const key = Buffer.from(proofKeyHex, "hex")
  try {
    return createHmac("sha256", key)
      .update(`pippit-local-runtime\nv1\n${instanceId}\n${challenge}`, "utf8").digest("hex")
  } finally {
    key.fill(0)
  }
}

export function parseReadyDescriptor(value: unknown, proofKeyHex: string): LocalRuntimeReadyDescriptor {
  if (!isRecord(value)) throw new PippitLocalRuntimeError("invalid_ready_descriptor", "Local runtime readiness state is invalid.")
  const candidate = value as Partial<LocalRuntimeReadyDescriptor>
  if (candidate.schema_version !== PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION
    || typeof candidate.runtime_version !== "string" || candidate.runtime_version.length > 64
    || !RUNTIME_VERSION_PATTERN.test(candidate.runtime_version)
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
