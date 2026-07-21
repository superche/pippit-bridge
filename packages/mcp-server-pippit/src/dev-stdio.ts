#!/usr/bin/env node

import { stat, readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, relative, resolve, sep } from "node:path"
import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"
import { createDevMcpGateway, type DevWorkerRequest, type DevWorkerResult, type FrozenDevContract } from "./dev-gateway.ts"
import { DevGatewayError, DevWorkerPool } from "./dev-supervisor.ts"
import { ChildMcpWorkerGeneration } from "./dev-worker-process.ts"

interface DevPointer {
  readonly capability: string
  readonly contractHash: string
  readonly frozenContractPath: string
  readonly repoRoot: string
  readonly runtimeRoot: string
  readonly statusPath: string
  readonly version: 1
}

interface DevStatus {
  readonly activeGeneration?: string
  readonly generationRoot?: string
  readonly migrationEpoch?: number
  readonly phase?: string
  readonly sourceHash?: string
  readonly storageBackwardCompatible?: boolean
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
  const pool = new DevWorkerPool<DevWorkerRequest, DevWorkerResult>(pointer.contractHash)
  const gateway = createDevMcpGateway({ contract: frozen, enableErrorPreview: true, pool })
  let observedGeneration: string | undefined
  let activating = false

  const activateCurrent = async (): Promise<void> => {
    if (activating) return
    activating = true
    try {
      const status = await readSecureJson<DevStatus>(pointer.statusPath, dataRoot)
      if (status.phase !== "active" || !status.activeGeneration || !status.generationRoot || status.activeGeneration === observedGeneration) return
      const entryPath = await realpath(resolve(status.generationRoot, "dist/plugin-stdio.mjs"))
      if (!contained(dataRoot, entryPath)) throw new Error("DEV_GENERATION_PATH_REJECTED")
      const entryMetadata = await stat(entryPath)
      if (typeof process.getuid === "function" && entryMetadata.uid !== process.getuid()) throw new Error("DEV_GENERATION_OWNER_REJECTED")
      if ((entryMetadata.mode & 0o022) !== 0) throw new Error("DEV_GENERATION_MODE_REJECTED")
      const started = await ChildMcpWorkerGeneration.start({
        contractHash: pointer.contractHash,
        entryPath,
        env: {
          ...process.env,
          PIPPIT_BRIDGE_HOME: runtimeRoot,
          PIPPIT_DEV_CAPABILITY: pointer.capability,
        },
        generationId: status.activeGeneration,
        implementationHash: status.sourceHash ?? status.activeGeneration,
        migrationEpoch: status.migrationEpoch ?? 1,
        storageBackwardCompatible: status.storageBackwardCompatible === true,
      })
      if (JSON.stringify(started.contract) !== JSON.stringify(frozen)) {
        await started.worker.close()
        throw new DevGatewayError("DEV_CONTRACT_MISMATCH", "Candidate discovery differs from the frozen gateway contract.")
      }
      try {
        await pool.activate(started.worker, {
          behaviorTestsPassed: true,
          contractHash: pointer.contractHash,
          semanticClassification: "hot-compatible",
        })
      } catch (error) {
        await started.worker.close()
        throw error
      }
      observedGeneration = status.activeGeneration
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
