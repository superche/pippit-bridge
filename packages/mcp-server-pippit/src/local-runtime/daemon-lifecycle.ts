import { spawn } from "node:child_process"
import { createHash, timingSafeEqual } from "node:crypto"
import { type Stats } from "node:fs"
import { lstat, readFile, realpath, type FileHandle } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  PIPPIT_LOCAL_RUNTIME_VERSION,
  PippitLocalRuntimeError,
  type LocalFacadeArtifactIdentity,
  type LocalRuntimeReadyConnection,
  type LocalRuntimeReadyDescriptor,
  type LocalRuntimeSecrets,
  type PippitLocalRuntimePaths,
} from "./contracts.ts"
import {
  processIsAlive,
  removeFileIfUnchanged,
} from "./bootstrap-lock.ts"
import {
  HEX_KEY_PATTERN,
  isRecord,
  openPrivateFile,
  pathExists,
  randomHexKey,
} from "./state-files.ts"
import {
  createLocalRuntimeProof,
  createLocalRuntimeShutdownProof,
  parseReadyDescriptor,
} from "./ready-proof.ts"

const BOOTSTRAP_TIMEOUT_MS = 15_000
const PROOF_TIMEOUT_MS = 1_500
const INCOMPATIBLE_DAEMON_STOP_TIMEOUT_MS = 5_000
const PROOF_PATH = "/.well-known/pippit-bridge-local-runtime"
const SHUTDOWN_PATH = `${PROOF_PATH}/shutdown`
const LEGACY_PROOF_WITHOUT_PID_VERSIONS = new Set(["0.2.0"])

export interface LocalRuntimeLifecycleEvidence {
  previousPid?: number
  previousPidStopped?: boolean
}

async function rejectOrRemoveUnverifiedDaemon(
  paths: PippitLocalRuntimePaths,
  descriptor: LocalRuntimeReadyDescriptor,
  stats: Stats,
): Promise<undefined> {
  if (!processIsAlive(descriptor.pid)) {
    try {
      await removeFileIfUnchanged(paths.readyPath, stats)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return undefined
  }
  throw new PippitLocalRuntimeError(
    "live_daemon_verification_failed",
    "A live local Pippit Facade could not be authenticated; refusing to start a second daemon.",
  )
}

async function requestAuthenticatedShutdown(
  baseUrl: string,
  descriptor: LocalRuntimeReadyDescriptor & {
    readonly daemon_artifact_sha256: string
    readonly daemon_entry: string
  },
  secrets: LocalRuntimeSecrets,
  fetchImplementation: typeof fetch,
): Promise<void> {
  const shutdownChallenge = randomHexKey()
  let shutdownResponse: Response
  try {
    shutdownResponse = await fetchImplementation(`${baseUrl}${SHUTDOWN_PATH}`, {
      body: JSON.stringify({
        challenge: shutdownChallenge,
        instance_id: descriptor.instance_id,
        proof: createLocalRuntimeShutdownProof(
          descriptor.instance_id,
          shutdownChallenge,
          secrets.bootstrap_proof_key_hex,
          {
            artifactHash: descriptor.daemon_artifact_sha256,
            entryPath: descriptor.daemon_entry,
          },
        ),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(PROOF_TIMEOUT_MS),
    })
  } catch {
    throw new PippitLocalRuntimeError(
      "incompatible_daemon_stop_failed",
      "The authenticated local Pippit Facade did not accept its private shutdown request.",
    )
  }
  await shutdownResponse.body?.cancel().catch(() => undefined)
  if (!shutdownResponse.ok) {
    throw new PippitLocalRuntimeError(
      "incompatible_daemon_stop_failed",
      "The authenticated local Pippit Facade rejected its private shutdown request.",
    )
  }
}

function signalAuthenticatedLegacyDaemon(pid: number): void {
  try {
    process.kill(pid, "SIGTERM")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw new PippitLocalRuntimeError(
        "incompatible_daemon_stop_failed",
        "The outdated local Pippit Facade could not be stopped safely.",
      )
    }
  }
}

async function waitForAuthenticatedDaemonExit(pid: number): Promise<void> {
  const deadline = Date.now() + INCOMPATIBLE_DAEMON_STOP_TIMEOUT_MS
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  if (processIsAlive(pid)) {
    throw new PippitLocalRuntimeError(
      "incompatible_daemon_stop_timeout",
      "The outdated local Pippit Facade did not stop in time.",
    )
  }
}

export async function readReadyConnection(
  paths: PippitLocalRuntimePaths,
  secrets: LocalRuntimeSecrets,
  fetchImplementation: typeof fetch,
  expectedIdentity: LocalFacadeArtifactIdentity,
  lifecycle: LocalRuntimeLifecycleEvidence,
  replaceIncompatible: boolean,
): Promise<LocalRuntimeReadyConnection | undefined> {
  if (!(await pathExists(paths.readyPath))) return undefined
  let handle: FileHandle
  try {
    handle = await openPrivateFile(paths.readyPath, "Local runtime readiness state")
  } catch (error) {
    if (error instanceof PippitLocalRuntimeError && error.code === "state_file_missing") return undefined
    throw error
  }
  let descriptor: LocalRuntimeReadyDescriptor
  let stats: Stats
  try {
    stats = await handle.stat()
    descriptor = parseReadyDescriptor(
      JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown,
      secrets.bootstrap_proof_key_hex,
    )
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
  await handle.close()
  if (!processIsAlive(descriptor.pid)) {
    lifecycle.previousPid = descriptor.pid
    lifecycle.previousPidStopped = true
    await removeFileIfUnchanged(paths.readyPath, stats)
    return undefined
  }

  const challenge = randomHexKey()
  const baseUrl = `http://127.0.0.1:${descriptor.port}`
  let response: Response
  try {
    response = await fetchImplementation(`${baseUrl}${PROOF_PATH}?challenge=${challenge}`, {
      redirect: "error",
      signal: AbortSignal.timeout(PROOF_TIMEOUT_MS),
    })
  } catch {
    return rejectOrRemoveUnverifiedDaemon(paths, descriptor, stats)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return rejectOrRemoveUnverifiedDaemon(paths, descriptor, stats)
  }
  const text = await response.text()
  if (Buffer.byteLength(text, "utf8") > 8 * 1024) {
    return rejectOrRemoveUnverifiedDaemon(paths, descriptor, stats)
  }
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    return rejectOrRemoveUnverifiedDaemon(paths, descriptor, stats)
  }
  const proofPidMatches = isRecord(body) && (
    body.pid === descriptor.pid ||
    (body.pid === undefined && LEGACY_PROOF_WITHOUT_PID_VERSIONS.has(descriptor.runtime_version))
  )
  if (
    !isRecord(body) ||
    body.instance_id !== descriptor.instance_id ||
    body.runtime_version !== descriptor.runtime_version ||
    body.daemon_artifact_sha256 !== descriptor.daemon_artifact_sha256 ||
    body.daemon_entry !== descriptor.daemon_entry ||
    typeof body.proof !== "string" ||
    !proofPidMatches
  ) {
    return rejectOrRemoveUnverifiedDaemon(paths, descriptor, stats)
  }
  const expected = Buffer.from(
    createLocalRuntimeProof(
      descriptor.instance_id,
      challenge,
      secrets.bootstrap_proof_key_hex,
      descriptor.daemon_artifact_sha256 === undefined || descriptor.daemon_entry === undefined
        ? undefined
        : {
            artifactHash: descriptor.daemon_artifact_sha256,
            entryPath: descriptor.daemon_entry,
          },
    ),
    "hex",
  )
  const actual = HEX_KEY_PATTERN.test(body.proof) ? Buffer.from(body.proof, "hex") : Buffer.alloc(0)
  try {
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return rejectOrRemoveUnverifiedDaemon(paths, descriptor, stats)
    }
  } finally {
    expected.fill(0)
    actual.fill(0)
  }

  const artifactMatches = (
    descriptor.daemon_artifact_sha256 === expectedIdentity.artifactHash
    && descriptor.daemon_entry === expectedIdentity.entryPath
    && descriptor.runtime_version === expectedIdentity.runtimeVersion
  )
  if (!artifactMatches) {
    if (!replaceIncompatible) return { baseUrl, descriptor }
    if (descriptor.pid <= 1 || descriptor.pid === process.pid) {
      throw new PippitLocalRuntimeError(
        "unsafe_incompatible_daemon_pid",
        "The outdated local Pippit Facade advertised an unsafe process identifier.",
      )
    }
    if (descriptor.daemon_artifact_sha256 !== undefined && descriptor.daemon_entry !== undefined) {
      await requestAuthenticatedShutdown(
        baseUrl,
        descriptor as LocalRuntimeReadyDescriptor & {
          readonly daemon_artifact_sha256: string
          readonly daemon_entry: string
        },
        secrets,
        fetchImplementation,
      )
    } else {
      signalAuthenticatedLegacyDaemon(descriptor.pid)
    }
    await waitForAuthenticatedDaemonExit(descriptor.pid)
    lifecycle.previousPid = descriptor.pid
    lifecycle.previousPidStopped = true
    try {
      await removeFileIfUnchanged(paths.readyPath, stats)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return undefined
  }
  return { baseUrl, descriptor }
}

export function resolveLocalFacadeDaemonEntry(moduleUrl: string = import.meta.url): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl))
  if (basename(moduleDirectory) !== "local-runtime") {
    return resolve(moduleDirectory, "local-facade-daemon.mjs")
  }
  const sourceOrDistDirectory = dirname(moduleDirectory)
  return basename(sourceOrDistDirectory) === "src"
    ? resolve(sourceOrDistDirectory, "../dist/local-facade-daemon.mjs")
    : resolve(sourceOrDistDirectory, "local-facade-daemon.mjs")
}

export async function resolveLocalFacadeDaemonIdentity(
  moduleUrl: string = import.meta.url,
): Promise<LocalFacadeArtifactIdentity> {
  const configuredEntry = resolveLocalFacadeDaemonEntry(moduleUrl)
  let entryStats: Stats
  try {
    entryStats = await lstat(configuredEntry)
  } catch {
    throw new PippitLocalRuntimeError(
      "missing_local_daemon",
      "The installed Pippit package is missing its local Facade runtime bundle.",
    )
  }
  if (!entryStats.isFile() || entryStats.isSymbolicLink()) {
    throw new PippitLocalRuntimeError("unsafe_local_daemon", "The local Facade runtime bundle is invalid.")
  }
  const entryPath = await realpath(configuredEntry)
  return {
    artifactHash: createHash("sha256").update(await readFile(entryPath)).digest("hex"),
    entryPath,
    runtimeVersion: PIPPIT_LOCAL_RUNTIME_VERSION,
  }
}

export async function startLocalFacadeDaemon(
  paths: PippitLocalRuntimePaths,
  identity: LocalFacadeArtifactIdentity,
): Promise<number> {
  const child = spawn(process.execPath, [identity.entryPath], {
    detached: true,
    env: {
      PIPPIT_LOCAL_RUNTIME_CONFIG_PATH: paths.configPath,
      PIPPIT_LOCAL_RUNTIME_DATA_ROOT: paths.dataRoot,
      PIPPIT_LOCAL_RUNTIME_READY_PATH: paths.readyPath,
    },
    stdio: "ignore",
  })
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("error", rejectSpawn)
    child.once("spawn", resolveSpawn)
  }).catch(() => {
    throw new PippitLocalRuntimeError("local_daemon_start_failed", "The local Pippit Facade could not start.")
  })
  const pid = child.pid
  if (pid === undefined) {
    throw new PippitLocalRuntimeError("local_daemon_start_failed", "The local Pippit Facade could not start.")
  }
  child.unref()
  return pid
}

export async function waitForReadyConnection(
  paths: PippitLocalRuntimePaths,
  secrets: LocalRuntimeSecrets,
  fetchImplementation: typeof fetch,
  expectedIdentity: LocalFacadeArtifactIdentity,
  lifecycle: LocalRuntimeLifecycleEvidence,
  startedPid: number,
): Promise<LocalRuntimeReadyConnection> {
  const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const ready = await readReadyConnection(
      paths,
      secrets,
      fetchImplementation,
      expectedIdentity,
      lifecycle,
      true,
    )
    if (ready !== undefined) return ready
    if (!processIsAlive(startedPid)) {
      throw new PippitLocalRuntimeError(
        "local_daemon_start_failed",
        "The local Pippit Facade exited before it became ready.",
      )
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
  }
  throw new PippitLocalRuntimeError(
    "local_daemon_ready_timeout",
    "The local Pippit Facade did not become ready in time.",
  )
}
