import { isAbsolute } from "node:path"

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
  type LocalFacadeRuntimeStatus,
  type LocalRuntimeReadyDescriptor,
  type LocalRuntimeReadyPayload,
  type LocalRuntimeSecrets,
  type PippitLocalRuntimePaths,
  type PippitResolvedLocalRuntimeEnvironment,
  type PippitResolvedRuntimeEnvironment,
} from "./contracts.ts"
import { nonEmpty, resolvePippitLocalRuntimePaths } from "./paths.ts"
import {
  acquireBootstrapLock,
  releaseBootstrapLock,
} from "./bootstrap-lock.ts"

export { removeStalePippitByokLockForDaemon } from "./bootstrap-lock.ts"
import {
  ensureOutputDirectory,
  ensurePrivateDirectory,
  isRecord,
  MAX_STATE_FILE_BYTES,
  newSecrets,
  parseIdempotencySecret,
  parseSecrets,
  pathExists,
  randomHexKey,
  readPrivateJson,
  writePrivateJsonAtomically,
} from "./state-files.ts"
import {
  readReadyConnection,
  resolveLocalFacadeDaemonIdentity,
  startLocalFacadeDaemon,
  waitForReadyConnection,
  type LocalRuntimeLifecycleEvidence,
} from "./daemon-lifecycle.ts"
import { signLocalRuntimeReadyPayload } from "./ready-proof.ts"

export {
  createLocalRuntimeProof,
  createLocalRuntimeShutdownProof,
  signLocalRuntimeReadyPayload,
} from "./ready-proof.ts"
export {
  resolveLocalFacadeDaemonEntry,
  resolveLocalFacadeDaemonIdentity,
} from "./daemon-lifecycle.ts"

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
  PippitResolvedLocalRuntimeEnvironment,
  PippitResolvedRuntimeEnvironment,
} from "./contracts.ts"
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

export async function ensurePippitLocalRuntime(options: {
  readonly daemonModuleUrl?: string
  readonly env?: NodeJS.ProcessEnv
  readonly fetchImplementation?: typeof fetch
} = {}): Promise<PippitResolvedLocalRuntimeEnvironment> {
  const env = options.env ?? process.env
  const fetchImplementation = options.fetchImplementation ?? fetch
  const paths = resolvePippitLocalRuntimePaths(env)
  const expectedIdentity = await resolveLocalFacadeDaemonIdentity(options.daemonModuleUrl)
  await ensurePrivateDirectory(paths.dataRoot, "Pippit local runtime data directory")
  await ensurePrivateDirectory(paths.byokDirectory, "Pippit BYOK directory")
  await ensurePrivateDirectory(paths.idempotencyDirectory, "Pippit idempotency directory")
  await ensureOutputDirectory(paths.outputRoot)

  const lock = await acquireBootstrapLock(paths.bootstrapLockPath)
  try {
    const secrets = await readOrCreateSecrets(paths)
    await readOrCreateIdempotencySecret(paths)
    const lifecycle: LocalRuntimeLifecycleEvidence = {}
    let ready = await readReadyConnection(
      paths,
      secrets,
      fetchImplementation,
      expectedIdentity,
      lifecycle,
      true,
    )
    let action: LocalFacadeRuntimeStatus["action"] = "reused"
    if (ready === undefined) {
      const startedPid = await startLocalFacadeDaemon(paths, expectedIdentity)
      ready = await waitForReadyConnection(
        paths,
        secrets,
        fetchImplementation,
        expectedIdentity,
        lifecycle,
        startedPid,
      )
      action = lifecycle.previousPid === undefined ? "started" : "replaced"
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
        daemon: {
          action,
          artifactHash: ready.descriptor.daemon_artifact_sha256 ?? expectedIdentity.artifactHash,
          dataRoot: paths.dataRoot,
          entryPath: ready.descriptor.daemon_entry ?? expectedIdentity.entryPath,
          healthy: true,
          matchesExpectedArtifact: (
            ready.descriptor.daemon_artifact_sha256 === expectedIdentity.artifactHash
            && ready.descriptor.daemon_entry === expectedIdentity.entryPath
          ),
          pid: ready.descriptor.pid,
          ...(lifecycle.previousPid === undefined
            ? {}
            : { previousPid: lifecycle.previousPid }),
          ...(lifecycle.previousPidStopped === undefined
            ? {}
            : { previousPidStopped: lifecycle.previousPidStopped }),
          runtimeVersion: ready.descriptor.runtime_version,
          startedAt: ready.descriptor.started_at,
        },
        dataRoot: paths.dataRoot,
        mediaSigningKeyHex: secrets.chatgpt_media_signing_key_hex,
      },
      mode: "local",
    }
  } finally {
    await releaseBootstrapLock(paths.bootstrapLockPath, lock)
  }
}

export async function inspectPippitLocalRuntime(options: {
  readonly daemonModuleUrl?: string
  readonly env?: NodeJS.ProcessEnv
  readonly fetchImplementation?: typeof fetch
} = {}): Promise<LocalFacadeRuntimeStatus> {
  const env = options.env ?? process.env
  const paths = resolvePippitLocalRuntimePaths(env)
  const expectedIdentity = await resolveLocalFacadeDaemonIdentity(options.daemonModuleUrl)
  if (!(await pathExists(paths.configPath)) || !(await pathExists(paths.readyPath))) {
    return {
      action: "absent",
      artifactHash: expectedIdentity.artifactHash,
      dataRoot: paths.dataRoot,
      entryPath: expectedIdentity.entryPath,
      healthy: false,
      matchesExpectedArtifact: false,
      runtimeVersion: expectedIdentity.runtimeVersion,
    }
  }
  const secrets = await readOrCreateSecrets(paths)
  const lifecycle: LocalRuntimeLifecycleEvidence = {}
  const ready = await readReadyConnection(
    paths,
    secrets,
    options.fetchImplementation ?? fetch,
    expectedIdentity,
    lifecycle,
    false,
  )
  if (ready === undefined) {
    return {
      action: "absent",
      artifactHash: expectedIdentity.artifactHash,
      dataRoot: paths.dataRoot,
      entryPath: expectedIdentity.entryPath,
      healthy: false,
      matchesExpectedArtifact: false,
      ...(lifecycle.previousPid === undefined
        ? {}
        : { previousPid: lifecycle.previousPid }),
      ...(lifecycle.previousPidStopped === undefined
        ? {}
        : { previousPidStopped: lifecycle.previousPidStopped }),
      runtimeVersion: expectedIdentity.runtimeVersion,
    }
  }
  return {
    action: "reused",
    artifactHash: ready.descriptor.daemon_artifact_sha256 ?? "legacy-unidentified",
    dataRoot: paths.dataRoot,
    entryPath: ready.descriptor.daemon_entry ?? "legacy-unidentified",
    healthy: true,
    matchesExpectedArtifact: (
      ready.descriptor.daemon_artifact_sha256 === expectedIdentity.artifactHash
      && ready.descriptor.daemon_entry === expectedIdentity.entryPath
    ),
    pid: ready.descriptor.pid,
    runtimeVersion: ready.descriptor.runtime_version,
    startedAt: ready.descriptor.started_at,
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
