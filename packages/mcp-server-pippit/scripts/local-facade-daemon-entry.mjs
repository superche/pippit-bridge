import { createHash, randomUUID } from "node:crypto"
import { dirname, resolve } from "node:path"

import { buildApp } from "../../../apps/openrouter-facade/src/app.ts"
import {
  PIPPIT_LOCAL_RUNTIME_SCHEMA_VERSION,
  PIPPIT_LOCAL_RUNTIME_VERSION,
  createLocalRuntimeProof,
  readPippitLocalRuntimeSecretsForDaemon,
  removeStalePippitByokLockForDaemon,
  removePippitLocalRuntimeReadyDescriptor,
  writePippitLocalRuntimeReadyDescriptor,
} from "../src/local-runtime.ts"

const PROOF_PATH = "/.well-known/pippit-bridge-local-runtime"
const CHALLENGE_PATTERN = /^[a-f0-9]{64}$/u

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
    instance_id: instanceId,
    pid: process.pid,
    proof: createLocalRuntimeProof(instanceId, challenge, secrets.bootstrap_proof_key_hex),
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

process.once("SIGINT", () => void shutdown())
process.once("SIGTERM", () => void shutdown())

try {
  const address = await app.listen({ host: "127.0.0.1", port: 0 })
  const port = Number(new URL(address).port)
  await writePippitLocalRuntimeReadyDescriptor(
    readyPath,
    {
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
