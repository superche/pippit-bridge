#!/usr/bin/env node

import { stat, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, relative, resolve, sep } from "node:path"
import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"
import { acquirePrivateFileLock } from "@pippit-bridge/core"
import { createDevMcpGateway, type DevWorkerRequest, type DevWorkerResult, type FrozenDevContract } from "./dev-gateway.ts"
import {
  activatedGenerationStatus,
  assertRecoverableActiveGeneration,
  assertDesiredGeneration,
  candidateSubjectHash,
  devStatusLockPath,
  reviewDecisionHash,
  verifyStagedArtifact,
  type CandidateManifest,
} from "./dev-manifest.ts"
import { DevGatewayError, DevWorkerPool } from "./dev-supervisor.ts"
import { ChildMcpWorkerGeneration } from "./dev-worker-process.ts"

interface DevPointer {
  readonly capability: string
  readonly contractHash: string
  readonly daemonArtifactHash: string
  readonly frozenContractPath: string
  readonly hostArtifactHash: string
  readonly productionContractPath: string
  readonly repoRoot: string
  readonly runtimeRoot: string
  readonly statusPath: string
  readonly version: 1
}

interface DevStatus {
  readonly activeGeneration?: string
  readonly activeImplementationHash?: string
  readonly baseImplementationHash?: string
  readonly candidateManifest?: CandidateManifest
  readonly desiredGeneration?: string
  readonly desiredGenerationRoot?: string
  readonly migrationEpoch?: number
  readonly observedGeneration?: string
  readonly phase?: string
  readonly review?: {
    readonly classification: "cold" | "hot-compatible"
    readonly migrationEpoch: number
    readonly storageBackwardCompatible: boolean
    readonly subjectHash: string
  }
  readonly reviewDecisionHash?: string
  readonly storageBackwardCompatible?: boolean
  readonly subjectHash?: string
}

function contained(root: string, path: string): boolean {
  const value = relative(root, path)
  return value !== ".." && !value.startsWith(`..${sep}`) && !resolve(path).startsWith(`${root}${sep}..${sep}`)
}

async function readSecureJson<T>(path: string, containingRoot?: string): Promise<T> {
  const actual = await realpath(path)
  if (containingRoot && !contained(containingRoot, actual)) throw new Error("DEV_POINTER_PATH_REJECTED")
  const metadata = await stat(actual)
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error("DEV_POINTER_OWNER_REJECTED")
  if ((metadata.mode & 0o022) !== 0) throw new Error("DEV_POINTER_MODE_REJECTED")
  return JSON.parse(await readFile(actual, "utf8")) as T
}

async function atomicStatus(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

async function withStatusLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lock = await acquirePrivateFileLock(devStatusLockPath(path), {
    instanceId: `codex-dev-gateway-${process.pid}`,
    retryAttempts: 200,
    retryDelayMs: 10,
  })
  try {
    return await operation()
  } finally {
    await lock.release()
  }
}

async function run(): Promise<void> {
  const pointerPath = resolve(process.env.PIPPIT_DEV_POINTER ?? resolve(homedir(), ".pippit-bridge/dev-v1/pointer.json"))
  const dataRoot = await realpath(dirname(pointerPath))
  const pointer = await readSecureJson<DevPointer>(pointerPath, dataRoot)
  if (pointer.version !== 1 || !/^[a-f0-9]{64}$/u.test(pointer.capability) || !/^[a-f0-9]{64}$/u.test(pointer.contractHash)) {
    throw new Error("DEV_POINTER_INVALID")
  }
  const runtimeRoot = await realpath(pointer.runtimeRoot)
  if (!contained(dataRoot, runtimeRoot)) throw new Error("DEV_RUNTIME_PATH_REJECTED")
  const runtimeMetadata = await stat(runtimeRoot)
  if (typeof process.getuid === "function" && runtimeMetadata.uid !== process.getuid()) throw new Error("DEV_RUNTIME_OWNER_REJECTED")
  if ((runtimeMetadata.mode & 0o022) !== 0) throw new Error("DEV_RUNTIME_MODE_REJECTED")
  const frozen = await readSecureJson<FrozenDevContract>(pointer.frozenContractPath, dataRoot)
  const productionContract = await readSecureJson<FrozenDevContract>(pointer.productionContractPath, dataRoot)
  const pool = new DevWorkerPool<DevWorkerRequest, DevWorkerResult>(pointer.contractHash)
  const gateway = createDevMcpGateway({ contract: frozen, pool })
  let observedGeneration: string | undefined
  let activating = false

  const activateCurrent = async (): Promise<void> => {
    if (activating) return
    activating = true
    try {
      const status = await readSecureJson<DevStatus>(pointer.statusPath, dataRoot)
      if (
        (status.phase !== "desired" && status.phase !== "active")
        || !status.desiredGeneration
        || !status.desiredGenerationRoot
        || status.desiredGeneration === observedGeneration
        || !status.candidateManifest
        || !status.review
        || !status.reviewDecisionHash
        || !status.subjectHash
        || !status.baseImplementationHash
      ) return
      const baseImplementationHash = status.baseImplementationHash
      const candidateManifest = status.candidateManifest
      const desiredGeneration = status.desiredGeneration
      const recoveringActiveGeneration = status.phase === "active"
      const subjectHash = status.subjectHash
      const expectedSubjectHash = candidateSubjectHash({
        activationClass: status.review.classification,
        baseImplementationHash,
        candidateManifest,
      })
      if (
        status.review.classification !== "hot-compatible"
        || status.review.subjectHash !== expectedSubjectHash
        || subjectHash !== expectedSubjectHash
        || reviewDecisionHash(status.review) !== status.reviewDecisionHash
      ) {
        throw new DevGatewayError("DEV_SEMANTIC_REVIEW_REQUIRED", "Candidate review is not bound to the staged artifact.")
      }
      if (recoveringActiveGeneration) {
        try {
          assertRecoverableActiveGeneration(status, {
            generationId: desiredGeneration,
            implementationHash: candidateManifest.workerArtifactHash,
            subjectHash,
          })
        } catch {
          throw new DevGatewayError("DEV_CANDIDATE_SUPERSEDED", "The recorded active generation cannot be recovered safely.")
        }
      }
      const entryPath = await realpath(resolve(status.desiredGenerationRoot, "dist/plugin-stdio.mjs"))
      if (!contained(dataRoot, entryPath)) throw new Error("DEV_GENERATION_PATH_REJECTED")
      try {
        await verifyStagedArtifact(entryPath, candidateManifest.workerArtifactHash)
      } catch {
        throw new DevGatewayError("DEV_CANDIDATE_SUPERSEDED", "Staged worker artifact changed after review.")
      }
      const daemonPath = await realpath(resolve(status.desiredGenerationRoot, "dist/local-facade-daemon.mjs"))
      if (!contained(dataRoot, daemonPath)) throw new Error("DEV_GENERATION_PATH_REJECTED")
      try {
        await verifyStagedArtifact(daemonPath, candidateManifest.daemonArtifactHash)
      } catch {
        throw new DevGatewayError("DEV_CANDIDATE_SUPERSEDED", "Staged Facade daemon artifact changed after review.")
      }
      const started = await ChildMcpWorkerGeneration.start({
        contractHash: pointer.contractHash,
        entryPath,
        env: {
          ...process.env,
          PIPPIT_BRIDGE_HOME: runtimeRoot,
          PIPPIT_DEV_CAPABILITY: pointer.capability,
        },
        generationId: desiredGeneration,
        implementationHash: candidateManifest.workerArtifactHash,
        migrationEpoch: status.migrationEpoch ?? 1,
        storageBackwardCompatible: status.storageBackwardCompatible === true,
      })
      if (JSON.stringify(started.contract) !== JSON.stringify(productionContract)) {
        await started.worker.close()
        throw new DevGatewayError("DEV_CONTRACT_MISMATCH", "Candidate discovery differs from the frozen gateway contract.")
      }
      let activated = false
      try {
        await withStatusLock(pointer.statusPath, async () => {
          const beforeActivation = await readSecureJson<DevStatus>(pointer.statusPath, dataRoot)
          const expectedGeneration = {
            baseImplementationHash,
            generationId: desiredGeneration,
            subjectHash,
          }
          try {
            if (recoveringActiveGeneration) {
              assertRecoverableActiveGeneration(beforeActivation, {
                generationId: desiredGeneration,
                implementationHash: candidateManifest.workerArtifactHash,
                subjectHash,
              })
            } else {
              assertDesiredGeneration(beforeActivation, expectedGeneration)
            }
          } catch {
            throw new DevGatewayError(
              "DEV_CANDIDATE_SUPERSEDED",
              recoveringActiveGeneration
                ? "The recorded active generation changed before recovery."
                : "A newer desired generation replaced the candidate before activation.",
            )
          }
          try {
            await verifyStagedArtifact(entryPath, candidateManifest.workerArtifactHash)
            await verifyStagedArtifact(daemonPath, candidateManifest.daemonArtifactHash)
          } catch {
            throw new DevGatewayError("DEV_CANDIDATE_SUPERSEDED", "Staged artifacts changed during candidate startup.")
          }
          await pool.activate(started.worker, {
            behaviorTestsPassed: true,
            contractHash: pointer.contractHash,
            subjectHash,
            semanticClassification: "hot-compatible",
          })
          activated = true
          if (!recoveringActiveGeneration) {
            await atomicStatus(pointer.statusPath, activatedGenerationStatus(
              beforeActivation,
              expectedGeneration,
              candidateManifest.workerArtifactHash,
              new Date().toISOString(),
            ))
          }
        })
      } catch (error) {
        if (!activated) await started.worker.close()
        throw error
      }
      observedGeneration = desiredGeneration
    } catch (error) {
      process.stderr.write(`${error instanceof DevGatewayError ? error.code : "DEV_SUPERVISOR_UNAVAILABLE"}: ${error instanceof Error ? error.message : String(error)}\n`)
    } finally {
      activating = false
    }
  }

  await activateCurrent()
  const interval = setInterval(() => { void activateCurrent() }, 250)
  const lines = createInterface({ crlfDelay: Infinity, input: process.stdin, terminal: false })
  try {
    for await (const line of lines) {
      let message: unknown
      try { message = JSON.parse(line) as unknown } catch {
        process.stdout.write(`${JSON.stringify({ error: { code: -32700, message: "Parse error." }, id: null, jsonrpc: "2.0" })}\n`)
        continue
      }
      try {
        const response = await gateway.handle(message)
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
      } catch (error) {
        const id = typeof message === "object" && message !== null && "id" in message ? (message as { id: unknown }).id : null
        const code = error instanceof DevGatewayError ? error.code : "DEV_SUPERVISOR_UNAVAILABLE"
        process.stdout.write(`${JSON.stringify({ error: { code: -32000, data: { code }, message: error instanceof Error ? error.message : String(error) }, id, jsonrpc: "2.0" })}\n`)
      }
    }
  } finally {
    clearInterval(interval)
    await pool.close()
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await run()
}
