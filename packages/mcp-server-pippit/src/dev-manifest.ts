import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"

export interface DevArtifactIdentity {
  readonly artifactHash: string
  readonly buildRecipeHash: string
  readonly kind: "dev-host" | "facade-daemon" | "worker-generation"
  readonly sourceGraphHash: string
  readonly version: 1
}

export interface CandidateManifest {
  readonly buildRecipeHash: string
  readonly daemonArtifactHash: string
  readonly hostContractHash: string
  readonly migrationEpoch: number
  readonly sourceGraphHash: string
  readonly storageSchemaEpoch: number
  readonly testEvidenceHash: string
  readonly workerArtifactHash: string
  readonly workerContractHash: string
}

export interface DevGenerationStatus {
  readonly activeGeneration?: string
  readonly activeImplementationHash?: string
  readonly baseImplementationHash?: string
  readonly desiredGeneration?: string
  readonly observedGeneration?: string
  readonly phase?: string
  readonly subjectHash?: string
  readonly updatedAt?: string
}

export interface DesiredGenerationIdentity {
  readonly baseImplementationHash: string
  readonly generationId: string
  readonly subjectHash: string
}

export interface ActiveGenerationIdentity {
  readonly generationId: string
  readonly implementationHash: string
  readonly subjectHash: string
}

export interface DevHostArtifactBinding {
  readonly daemonArtifactHash: string
  readonly hostArtifactHash: string
}

export type DevActivationClass = "cold" | "hot-compatible"

export interface CandidateSubject {
  readonly activationClass: DevActivationClass
  readonly baseImplementationHash: string
  readonly candidateManifest: CandidateManifest
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value))
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function candidateSubjectHash(subject: CandidateSubject): string {
  return sha256(canonicalJson(subject))
}

export function reviewDecisionHash(review: {
  readonly classification: DevActivationClass
  readonly migrationEpoch: number
  readonly storageBackwardCompatible: boolean
  readonly subjectHash: string
}): string {
  return sha256(canonicalJson(review))
}

export function assertActiveGenerationBase(status: DevGenerationStatus, expectedImplementationHash: string): void {
  if (status.phase !== "active" || status.activeImplementationHash !== expectedImplementationHash) {
    throw new Error("DEV_BASE_GENERATION_CHANGED")
  }
}

export function assertDesiredGeneration(status: DevGenerationStatus, expected: DesiredGenerationIdentity): void {
  if (
    status.phase !== "desired"
    || status.desiredGeneration !== expected.generationId
    || status.subjectHash !== expected.subjectHash
    || status.baseImplementationHash !== expected.baseImplementationHash
  ) throw new Error("DEV_CANDIDATE_SUPERSEDED")
}

export function assertRecoverableActiveGeneration(
  status: DevGenerationStatus,
  expected: ActiveGenerationIdentity,
): void {
  if (
    status.phase !== "active"
    || status.activeGeneration !== expected.generationId
    || status.desiredGeneration !== expected.generationId
    || status.observedGeneration !== expected.generationId
    || status.activeImplementationHash !== expected.implementationHash
    || status.baseImplementationHash !== expected.implementationHash
    || status.subjectHash !== expected.subjectHash
  ) throw new Error("DEV_ACTIVE_GENERATION_CHANGED")
}

export function activatedGenerationStatus(
  status: DevGenerationStatus,
  expected: DesiredGenerationIdentity,
  implementationHash: string,
  updatedAt: string,
): DevGenerationStatus {
  assertDesiredGeneration(status, expected)
  return {
    ...status,
    activeGeneration: expected.generationId,
    activeImplementationHash: implementationHash,
    baseImplementationHash: implementationHash,
    observedGeneration: expected.generationId,
    phase: "active",
    updatedAt,
  }
}

export function assertHotArtifactBinding(
  candidate: DevHostArtifactBinding,
  frozen: DevHostArtifactBinding,
): void {
  if (candidate.hostArtifactHash !== frozen.hostArtifactHash) throw new Error("DEV_HOST_REBOOTSTRAP_REQUIRED")
  if (candidate.daemonArtifactHash !== frozen.daemonArtifactHash) throw new Error("DEV_DAEMON_RESTART_REQUIRED")
}

export function devStatusLockPath(statusPath: string): string {
  return `${statusPath}.lock`
}

export async function verifyStagedArtifact(
  path: string,
  expectedHash: string,
  maxBytes = 16 * 1024 * 1024,
): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.size < 1
      || metadata.size > maxBytes
      || (process.platform !== "win32" && (metadata.mode & 0o022) !== 0)
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) throw new Error("DEV_STAGED_ARTIFACT_UNSAFE")
    if (sha256(await handle.readFile()) !== expectedHash) {
      throw new Error("DEV_STAGED_ARTIFACT_HASH_MISMATCH")
    }
  } finally {
    await handle.close()
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}
