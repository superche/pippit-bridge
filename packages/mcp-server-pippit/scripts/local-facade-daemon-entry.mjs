import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { buildApp } from "@pippit-bridge/openrouter-facade"
import {
  PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION,
  PIPPIT_LOCAL_RUNTIME_VERSION,
  createLocalRuntimeProof,
  createLocalRuntimeShutdownProof,
  readPippitLocalRuntimeSecretsForDaemon,
  removeStalePippitByokLockForDaemon,
  removePippitLocalRuntimeReadyDescriptor,
  writePippitLocalRuntimeReadyDescriptor,
} from "../src/local-runtime.ts"

const PROOF_PATH = "/.well-known/pippit-bridge-local-runtime"
const SHUTDOWN_PATH = `${PROOF_PATH}/shutdown`
const CHALLENGE_PATTERN = /^[a-f0-9]{64}$/u
const PROOF_PATTERN = /^[a-f0-9]{64}$/u

function requiredAbsolutePath(name) {
  const value = process.env[name]
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required.`)
  }
  const normalized = resolve(value)
  if (normalized !== value) throw new Error(`${name} must be an absolute normalized path.`)
  return normalized
}

const configPath = requiredAbsolutePath("PIPPIT_LOCAL_RUNTIME_CONFIG_PATH")
const dataRoot = requiredAbsolutePath("PIPPIT_LOCAL_RUNTIME_DATA_ROOT")
const readyPath = requiredAbsolutePath("PIPPIT_LOCAL_RUNTIME_READY_PATH")
if (dirname(configPath) !== dataRoot || dirname(readyPath) !== dataRoot) {
  throw new Error("Local runtime state paths must stay beneath the data root.")
}

const secrets = await readPippitLocalRuntimeSecretsForDaemon(configPath)
const daemonEntry = await realpath(fileURLToPath(import.meta.url))
const daemonIdentity = {
  artifactHash: createHash("sha256").update(await readFile(daemonEntry)).digest("hex"),
  entryPath: daemonEntry,
}
const byokStorePath = resolve(dataRoot, "byok", "credentials.json")
await removeStalePippitByokLockForDaemon(`${byokStorePath}.lock`)
const instanceId = randomUUID()
const app = buildApp({
  config: {
    BYOK_ENCRYPTION_KEY_HEX: secrets.byok_encryption_key_hex,
    BYOK_MANAGEMENT_KEY_SHA256: createHash("sha256").update(secrets.management_api_key, "utf8").digest("hex"),
    BYOK_STORE_PATH: byokStorePath,
    FACADE_API_KEY_SHA256_ALLOWLIST: [
      createHash("sha256").update(secrets.facade_api_key, "utf8").digest("hex"),
    ],
    HOST: "127.0.0.1",
    JOB_SIGNING_KEY_HEX: secrets.job_signing_key_hex,
    PORT: 30_000,
  },
  logger: false,
})

app.get(PROOF_PATH, async (request, reply) => {
  const query = request.query
  const challenge = typeof query === "object" && query !== null && "challenge" in query
    ? query.challenge
    : undefined
  if (typeof challenge !== "string" || !CHALLENGE_PATTERN.test(challenge)) {
    return reply.status(400).send({ error: "A valid bootstrap challenge is required." })
  }
  reply.header("cache-control", "no-store")
  return {
    daemon_artifact_sha256: daemonIdentity.artifactHash,
    daemon_entry: daemonIdentity.entryPath,
    instance_id: instanceId,
    pid: process.pid,
    proof: createLocalRuntimeProof(
      instanceId,
      challenge,
      secrets.bootstrap_proof_key_hex,
      daemonIdentity,
    ),
    runtime_version: PIPPIT_LOCAL_RUNTIME_VERSION,
  }
})

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await app.close().catch(() => undefined)
  await removePippitLocalRuntimeReadyDescriptor(readyPath, process.pid)
}

app.post(SHUTDOWN_PATH, async (request, reply) => {
  const body = typeof request.body === "object" && request.body !== null
    ? request.body
    : {}
  const challenge = "challenge" in body ? body.challenge : undefined
  const requestedInstanceId = "instance_id" in body ? body.instance_id : undefined
  const proof = "proof" in body ? body.proof : undefined
  if (
    typeof challenge !== "string"
    || !CHALLENGE_PATTERN.test(challenge)
    || requestedInstanceId !== instanceId
    || typeof proof !== "string"
    || !PROOF_PATTERN.test(proof)
  ) {
    return reply.status(403).send({ error: "Authenticated local shutdown proof is required." })
  }
  const expected = Buffer.from(
    createLocalRuntimeShutdownProof(
      instanceId,
      challenge,
      secrets.bootstrap_proof_key_hex,
      daemonIdentity,
    ),
    "hex",
  )
  const actual = Buffer.from(proof, "hex")
  let valid = false
  try {
    valid = actual.length === expected.length && timingSafeEqual(actual, expected)
  } finally {
    expected.fill(0)
    actual.fill(0)
  }
  if (!valid) {
    return reply.status(403).send({ error: "Authenticated local shutdown proof is required." })
  }
  reply.status(202).send({ accepted: true, instance_id: instanceId, pid: process.pid })
  setImmediate(() => void shutdown())
})

process.once("SIGINT", () => void shutdown())
process.once("SIGTERM", () => void shutdown())

try {
  const address = await app.listen({ host: "127.0.0.1", port: 0 })
  const port = Number(new URL(address).port)
  await writePippitLocalRuntimeReadyDescriptor(
    readyPath,
    {
      daemon_artifact_sha256: daemonIdentity.artifactHash,
      daemon_entry: daemonIdentity.entryPath,
      instance_id: instanceId,
      pid: process.pid,
      port,
      runtime_version: PIPPIT_LOCAL_RUNTIME_VERSION,
      schema_version: PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION,
      started_at: new Date().toISOString(),
    },
    secrets.bootstrap_proof_key_hex,
  )
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : "Local Facade startup failed.")
  await shutdown()
  process.exitCode = 1
}
