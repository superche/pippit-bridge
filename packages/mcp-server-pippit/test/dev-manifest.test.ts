import { chmod, link, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  activatedGenerationStatus,
  assertActiveGenerationBase,
  assertDesiredGeneration,
  assertHotArtifactBinding,
  assertRecoverableActiveGeneration,
  candidateSubjectHash,
  canonicalJson,
  devStatusLockPath,
  reviewDecisionHash,
  sha256,
  verifyStagedArtifact,
  type CandidateManifest,
} from "../src/dev-manifest.ts"

const manifest = {
  buildRecipeHash: "recipe",
  daemonArtifactHash: "daemon",
  hostContractHash: "host-contract",
  migrationEpoch: 1,
  sourceGraphHash: "source-graph",
  storageSchemaEpoch: 1,
  testEvidenceHash: "tests",
  workerArtifactHash: "worker-n",
  workerContractHash: "worker-contract",
} satisfies CandidateManifest

describe("development candidate identity", () => {
  test("uses one status lock pathname for controller and gateway transactions", () => {
    expect(devStatusLockPath("/isolated/dev/status.json")).toBe("/isolated/dev/status.json.lock")
  })

  test("canonicalizes object key order before hashing", () => {
    expect(canonicalJson({ z: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"z":1}')
  })

  test("does not let the review for N authorize N+1", () => {
    const reviewed = candidateSubjectHash({
      activationClass: "hot-compatible",
      baseImplementationHash: "base",
      candidateManifest: manifest,
    })
    const changed = candidateSubjectHash({
      activationClass: "hot-compatible",
      baseImplementationHash: "base",
      candidateManifest: { ...manifest, workerArtifactHash: "worker-n-plus-one" },
    })
    expect(changed).not.toBe(reviewed)
  })

  test("binds the decision to migration and storage compatibility", () => {
    const subjectHash = candidateSubjectHash({
      activationClass: "hot-compatible",
      baseImplementationHash: "base",
      candidateManifest: manifest,
    })
    const decision = {
      classification: "hot-compatible" as const,
      migrationEpoch: 1,
      storageBackwardCompatible: true,
      subjectHash,
    }
    expect(reviewDecisionHash({ ...decision, migrationEpoch: 2 })).not.toBe(reviewDecisionHash(decision))
    expect(reviewDecisionHash({ ...decision, storageBackwardCompatible: false })).not.toBe(reviewDecisionHash(decision))
  })

  test("preserves gateway observations while staging from the actual active generation", () => {
    const current = {
      activeGeneration: "n",
      activeImplementationHash: "worker-n",
      observedGeneration: "n",
      phase: "active",
      supervisorHeartbeat: "preserve-me",
    } as const
    expect(() => assertActiveGenerationBase(current, "worker-n")).not.toThrow()
    expect(() => assertActiveGenerationBase(current, "worker-old")).toThrow("DEV_BASE_GENERATION_CHANGED")
    expect(current).toMatchObject({ observedGeneration: "n", supervisorHeartbeat: "preserve-me" })
  })

  test("rejects a superseded desired generation and commits only the locked candidate", () => {
    const expected = { baseImplementationHash: "worker-n", generationId: "n-plus-one", subjectHash: "subject-n-plus-one" }
    const desired = {
      ...expected,
      desiredGeneration: expected.generationId,
      phase: "desired",
      supervisorHeartbeat: "preserve-me",
    }
    expect(() => assertDesiredGeneration(desired, expected)).not.toThrow()
    expect(() => assertDesiredGeneration({ ...desired, desiredGeneration: "n-plus-two" }, expected))
      .toThrow("DEV_CANDIDATE_SUPERSEDED")
    expect(activatedGenerationStatus(desired, expected, "worker-n-plus-one", "2026-07-22T00:00:00.000Z"))
      .toMatchObject({
        activeGeneration: "n-plus-one",
        activeImplementationHash: "worker-n-plus-one",
        baseImplementationHash: "worker-n-plus-one",
        observedGeneration: "n-plus-one",
        phase: "active",
        supervisorHeartbeat: "preserve-me",
      })
  })

  test("recovers only the exact persisted active generation after a gateway restart", () => {
    const expected = {
      generationId: "n",
      implementationHash: "worker-n",
      subjectHash: "subject-n",
    }
    const active = {
      activeGeneration: "n",
      activeImplementationHash: "worker-n",
      baseImplementationHash: "worker-n",
      desiredGeneration: "n",
      observedGeneration: "n",
      phase: "active",
      subjectHash: "subject-n",
    } as const
    expect(() => assertRecoverableActiveGeneration(active, expected)).not.toThrow()
    for (const changed of [
      { ...active, activeGeneration: "old" },
      { ...active, activeImplementationHash: "worker-old" },
      { ...active, baseImplementationHash: "worker-old" },
      { ...active, desiredGeneration: "next" },
      { ...active, observedGeneration: "old" },
      { ...active, phase: "desired" },
      { ...active, subjectHash: "subject-old" },
    ]) {
      expect(() => assertRecoverableActiveGeneration(changed, expected)).toThrow("DEV_ACTIVE_GENERATION_CHANGED")
    }
  })

  test("requires explicit host bootstrap or daemon restart before worker activation", () => {
    const frozen = { daemonArtifactHash: "daemon-n", hostArtifactHash: "host-n" }
    expect(() => assertHotArtifactBinding(frozen, frozen)).not.toThrow()
    expect(() => assertHotArtifactBinding({ ...frozen, hostArtifactHash: "host-n-plus-one" }, frozen))
      .toThrow("DEV_HOST_REBOOTSTRAP_REQUIRED")
    expect(() => assertHotArtifactBinding({ ...frozen, daemonArtifactHash: "daemon-n-plus-one" }, frozen))
      .toThrow("DEV_DAEMON_RESTART_REQUIRED")
  })

  test("rejects staged artifact tampering and unsafe links or modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pippit-staged-artifact-"))
    try {
      const artifact = join(root, "worker.mjs")
      await writeFile(artifact, "export const generation = 1\n", { mode: 0o700 })
      const expectedHash = sha256("export const generation = 1\n")
      await expect(verifyStagedArtifact(artifact, expectedHash)).resolves.toBeUndefined()

      await writeFile(artifact, "export const generation = 2\n", { mode: 0o700 })
      await expect(verifyStagedArtifact(artifact, expectedHash)).rejects.toThrow("HASH_MISMATCH")

      await chmod(artifact, 0o722)
      await expect(verifyStagedArtifact(artifact, sha256("export const generation = 2\n")))
        .rejects.toThrow("UNSAFE")

      await chmod(artifact, 0o700)
      await link(artifact, join(root, "outside-link.mjs"))
      await expect(verifyStagedArtifact(artifact, sha256("export const generation = 2\n")))
        .rejects.toThrow("UNSAFE")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
