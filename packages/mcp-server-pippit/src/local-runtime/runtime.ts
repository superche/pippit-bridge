import { spawn } from "node:child_process"
import { timingSafeEqual } from "node:crypto"
import { type Stats } from "node:fs"
import { lstat, type FileHandle } from "node:fs/promises"
import { basename, dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  atomicReplacePrivateFile,
  FileIdempotencyStore,
  removePrivateFileIf,
  type IdempotencyStore,
} from "@pippit-bridge/core"

import {
  PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION,
  PIPPIT_LOCAL_RUNTIME_VERSION,
  PippitLocalRuntimeError,
  type LocalRuntimeIdempotencySecret,
  type LocalRuntimeReadyConnection,
  type LocalRuntimeReadyDescriptor,
  type LocalRuntimeReadyPayload,
  type LocalRuntimeSecrets,
  type PippitLocalRuntimePaths,
  type PippitResolvedRuntimeEnvironment,
} from "./contracts.ts"
import { nonEmpty, resolvePippitLocalRuntimePaths } from "./paths.ts"
import {
  acquireBootstrapLock,
  compareRuntimeVersions,
  processIsAlive,
  removeFileIfUnchanged,
  releaseBootstrapLock,
} from "./bootstrap-lock.ts"

export { removeStalePippitByokLockForDaemon } from "./bootstrap-lock.ts"
import {
  ensureOutputDirectory,
  ensurePrivateDirectory,
  isRecord,
  HEX_KEY_PATTERN,
  MAX_STATE_FILE_BYTES,
  newSecrets,
  openPrivateFile,
  parseIdempotencySecret,
  parseSecrets,
  pathExists,
  randomHexKey,
  readPrivateJson,
  writePrivateJsonAtomically,
} from "./state-files.ts"
import {
  createLocalRuntimeProof,
  parseReadyDescriptor,
  signLocalRuntimeReadyPayload,
} from "./ready-proof.ts"

export { createLocalRuntimeProof, signLocalRuntimeReadyPayload } from "./ready-proof.ts"

export {
  PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION,
  PIPPIT_LOCAL_RUNTIME_VERSION,
  PippitLocalRuntimeError,
  resolvePippitLocalRuntimePaths,
}
export type {
  LocalRuntimeIdempotencySecret,
  LocalRuntimeReadyPayload,
  PippitLocalRuntimePaths,
  PippitResolvedRuntimeEnvironment,
} from "./contracts.ts"
const BOOTSTRAP_TIMEOUT_MS = 15_000
const PROOF_TIMEOUT_MS = 1_500
const INCOMPATIBLE_DAEMON_STOP_TIMEOUT_MS = 5_000
const PROOF_PATH = "/.well-known/pippit-bridge-local-runtime"
const LEGACY_PROOF_WITHOUT_PID_VERSIONS = new Set(["0.2.0"])

async function readOrCreateIdempotencySecret(paths: PippitLocalRuntimePaths): Promise<LocalRuntimeIdempotencySecret> {
  if (await pathExists(paths.idempotencySecretPath)) {
    return parseIdempotencySecret(await readPrivateJson(paths.idempotencySecretPath, "Local idempotency secret"))
  }
  if (await pathExists(paths.idempotencyStorePath)) {
    if (await pathExists(paths.idempotencySecretPath)) {
      return parseIdempotencySecret(await readPrivateJson(paths.idempotencySecretPath, "Local idempotency secret"))
    }
    throw new PippitLocalRuntimeError(
      "missing_idempotency_key",
      "An existing idempotency store has no matching HMAC key; refusing to replace it.",
    )
  }
  const secret = {
    idempotency_hmac_key_hex: randomHexKey(),
    schema_version: PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION,
  } as const
  const created = await writePrivateJsonAtomically(paths.idempotencySecretPath, secret)
  return created === "created"
    ? secret
    : parseIdempotencySecret(await readPrivateJson(paths.idempotencySecretPath, "Local idempotency secret"))
}

async function readOrCreateSecrets(paths: PippitLocalRuntimePaths): Promise<LocalRuntimeSecrets> {
  if (await pathExists(paths.configPath)) {
    return parseSecrets(await readPrivateJson(paths.configPath, "Local runtime secrets"))
  }
  if (await pathExists(paths.byokStorePath)) {
    if (await pathExists(paths.configPath)) {
      return parseSecrets(await readPrivateJson(paths.configPath, "Local runtime secrets"))
    }
    throw new PippitLocalRuntimeError(
      "missing_encryption_keys",
      "An existing Pippit BYOK store has no matching local runtime secrets; refusing to replace its encryption key.",
    )
  }
  const secrets = newSecrets()
  const created = await writePrivateJsonAtomically(paths.configPath, secrets)
  return created === "created"
    ? secrets
    : parseSecrets(await readPrivateJson(paths.configPath, "Local runtime secrets"))
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

async function readReadyConnection(
  paths: PippitLocalRuntimePaths,
  secrets: LocalRuntimeSecrets,
  fetchImplementation: typeof fetch,
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
    typeof body.proof !== "string" ||
    !proofPidMatches
  ) {
    return rejectOrRemoveUnverifiedDaemon(paths, descriptor, stats)
  }
  const expected = Buffer.from(
    createLocalRuntimeProof(descriptor.instance_id, challenge, secrets.bootstrap_proof_key_hex),
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
  const versionComparison = compareRuntimeVersions(
    PIPPIT_LOCAL_RUNTIME_VERSION,
    descriptor.runtime_version,
  )
  if (versionComparison > 0) {
    if (descriptor.pid <= 1 || descriptor.pid === process.pid) {
      throw new PippitLocalRuntimeError(
        "unsafe_incompatible_daemon_pid",
        "The outdated local Pippit Facade advertised an unsafe process identifier.",
      )
    }
    try {
      process.kill(descriptor.pid, "SIGTERM")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw new PippitLocalRuntimeError(
          "incompatible_daemon_stop_failed",
          "The outdated local Pippit Facade could not be stopped safely.",
        )
      }
    }
    const deadline = Date.now() + INCOMPATIBLE_DAEMON_STOP_TIMEOUT_MS
    while (processIsAlive(descriptor.pid) && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
    }
    if (processIsAlive(descriptor.pid)) {
      throw new PippitLocalRuntimeError(
        "incompatible_daemon_stop_timeout",
        "The outdated local Pippit Facade did not stop in time.",
      )
    }
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

async function startLocalFacadeDaemon(paths: PippitLocalRuntimePaths, moduleUrl?: string): Promise<number> {
  const daemonEntry = resolveLocalFacadeDaemonEntry(moduleUrl)
  let entryStats: Stats
  try {
    entryStats = await lstat(daemonEntry)
  } catch {
    throw new PippitLocalRuntimeError(
      "missing_local_daemon",
      "The installed Pippit package is missing its local Facade runtime bundle.",
    )
  }
  if (!entryStats.isFile() || entryStats.isSymbolicLink()) {
    throw new PippitLocalRuntimeError("unsafe_local_daemon", "The local Facade runtime bundle is invalid.")
  }
  const child = spawn(process.execPath, [daemonEntry], {
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

async function waitForReadyConnection(
  paths: PippitLocalRuntimePaths,
  secrets: LocalRuntimeSecrets,
  fetchImplementation: typeof fetch,
  startedPid: number,
): Promise<LocalRuntimeReadyConnection> {
  const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const ready = await readReadyConnection(paths, secrets, fetchImplementation)
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

export async function ensurePippitLocalRuntime(options: {
  readonly daemonModuleUrl?: string
  readonly env?: NodeJS.ProcessEnv
  readonly fetchImplementation?: typeof fetch
} = {}): Promise<PippitResolvedRuntimeEnvironment> {
  const env = options.env ?? process.env
  const fetchImplementation = options.fetchImplementation ?? fetch
  const paths = resolvePippitLocalRuntimePaths(env)
  await ensurePrivateDirectory(paths.dataRoot, "Pippit local runtime data directory")
  await ensurePrivateDirectory(paths.byokDirectory, "Pippit BYOK directory")
  await ensurePrivateDirectory(paths.idempotencyDirectory, "Pippit idempotency directory")
  await ensureOutputDirectory(paths.outputRoot)

  const lock = await acquireBootstrapLock(paths.bootstrapLockPath)
  try {
    const secrets = await readOrCreateSecrets(paths)
    await readOrCreateIdempotencySecret(paths)
    let ready = await readReadyConnection(paths, secrets, fetchImplementation)
    if (ready === undefined) {
      const startedPid = await startLocalFacadeDaemon(paths, options.daemonModuleUrl)
      ready = await waitForReadyConnection(paths, secrets, fetchImplementation, startedPid)
    }
    return {
      environment: {
        ...env,
        PIPPIT_FACADE_API_KEY: secrets.facade_api_key,
        PIPPIT_FACADE_BASE_URL: ready.baseUrl,
        PIPPIT_FACADE_MANAGEMENT_API_KEY: secrets.management_api_key,
        PIPPIT_MCP_OUTPUT_ROOT: paths.outputRoot,
      },
      local: {
        dataRoot: paths.dataRoot,
        mediaSigningKeyHex: secrets.chatgpt_media_signing_key_hex,
      },
      mode: "local",
    }
  } finally {
    await releaseBootstrapLock(paths.bootstrapLockPath, lock)
  }
}

export async function resolvePippitRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PippitResolvedRuntimeEnvironment> {
  const facadeApiKey = nonEmpty(env.PIPPIT_FACADE_API_KEY)
  const facadeBaseUrl = nonEmpty(env.PIPPIT_FACADE_BASE_URL)
  const managementApiKey = nonEmpty(env.PIPPIT_FACADE_MANAGEMENT_API_KEY)
  if (facadeApiKey !== undefined && facadeBaseUrl !== undefined) {
    return { environment: { ...env }, mode: "external" }
  }
  if (facadeApiKey !== undefined || facadeBaseUrl !== undefined || managementApiKey !== undefined) {
    throw new PippitLocalRuntimeError(
      "partial_external_configuration",
      "PIPPIT_FACADE_API_KEY and PIPPIT_FACADE_BASE_URL are both required when any external Facade setting is configured.",
    )
  }
  if (nonEmpty(env.PIPPIT_LOCAL_RUNTIME_AUTO_START)?.toLowerCase() === "false") {
    throw new PippitLocalRuntimeError(
      "local_runtime_disabled",
      "No external Facade is configured and automatic local runtime setup is disabled.",
    )
  }
  return ensurePippitLocalRuntime({ env })
}

export async function readPippitLocalRuntimeSecretsForDaemon(
  configPath: string,
): Promise<LocalRuntimeSecrets> {
  if (!isAbsolute(configPath)) {
    throw new PippitLocalRuntimeError("invalid_config_path", "Local runtime config path must be absolute.")
  }
  return parseSecrets(await readPrivateJson(configPath, "Local runtime secrets"))
}

export async function openPippitMcpIdempotencyStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<IdempotencyStore> {
  const paths = resolvePippitLocalRuntimePaths(env)
  await ensurePrivateDirectory(paths.dataRoot, "Pippit local runtime data directory")
  await ensurePrivateDirectory(paths.idempotencyDirectory, "Pippit idempotency directory")
  const lock = await acquireBootstrapLock(paths.bootstrapLockPath)
  try {
    const secret = await readOrCreateIdempotencySecret(paths)
    const hmacKey = Buffer.from(secret.idempotency_hmac_key_hex, "hex")
    try {
      return new FileIdempotencyStore({ filePath: paths.idempotencyStorePath, hmacKey })
    } finally {
      hmacKey.fill(0)
    }
  } finally {
    await releaseBootstrapLock(paths.bootstrapLockPath, lock)
  }
}

export async function writePippitLocalRuntimeReadyDescriptor(
  path: string,
  payload: LocalRuntimeReadyPayload,
  proofKeyHex: string,
): Promise<void> {
  const descriptor: LocalRuntimeReadyDescriptor = {
    ...payload,
    signature: signLocalRuntimeReadyPayload(payload, proofKeyHex),
  }
  const contents = Buffer.from(`${JSON.stringify(descriptor)}\n`, "utf8")
  try {
    await atomicReplacePrivateFile(path, contents)
  } catch {
    throw new PippitLocalRuntimeError("state_file_unavailable", "Local runtime readiness state could not be written safely.")
  } finally {
    contents.fill(0)
  }
}

export async function removePippitLocalRuntimeReadyDescriptor(path: string, pid: number): Promise<void> {
  try {
    await removePrivateFileIf(path, MAX_STATE_FILE_BYTES, contents => {
      try {
        const value = JSON.parse(contents.toString("utf8")) as unknown
        return isRecord(value) && value.pid === pid
      } catch {
        return false
      }
    })
  } catch {
    // Daemon shutdown must not remove a replacement or unsafe readiness file.
  }
}
