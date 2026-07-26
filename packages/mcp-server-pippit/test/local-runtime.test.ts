import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import {
  PIPPIT_LOCAL_RUNTIME_VERSION,
  ensurePippitLocalRuntime,
  inspectPippitLocalRuntime,
  resolveLocalFacadeDaemonEntry,
  resolvePippitLocalRuntimePaths,
  signLocalRuntimeReadyPayload,
} from "../src/local-runtime.js"

interface ProtocolRun {
  readonly code: number | null
  readonly responses: readonly Record<string, unknown>[]
  readonly stderr: string
}

interface ToolCallResult {
  readonly isError?: boolean
  readonly structuredContent?: {
    readonly error?: {
      readonly code?: string
    }
  }
}

interface ReadyDescriptor {
  readonly daemon_artifact_sha256?: string
  readonly daemon_entry?: string
  readonly instance_id: string
  readonly pid: number
  readonly port: number
  readonly runtime_version: string
  readonly signature: string
  readonly started_at: string
}

async function createDaemonVariant(label: string): Promise<{
  readonly artifactHash: string
  readonly moduleUrl: string
}> {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url))
  const variantRoot = await mkdtemp(join(tmpdir(), `pippit-daemon-${label}-`))
  cleanupRoots.add(variantRoot)
  const daemonContents = await readFile(join(packageRoot, "dist/local-facade-daemon.mjs"), "utf8")
  const daemonPath = join(variantRoot, "local-facade-daemon.mjs")
  await writeFile(daemonPath, `${daemonContents}\n// test artifact variant: ${label}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  return {
    artifactHash: createHash("sha256")
      .update(await readFile(daemonPath))
      .digest("hex"),
    moduleUrl: pathToFileURL(join(variantRoot, "plugin-stdio.mjs")).href,
  }
}

const cleanupRoots = new Set<string>()
const cleanupPids = new Set<number>()

describe("Pippit local runtime paths", () => {
  it("resolves the daemon beside bundled and compiled entries and from a source checkout", () => {
    const packageRoot = resolve(tmpdir(), "pippit-mcp-layout")
    expect(resolveLocalFacadeDaemonEntry(pathToFileURL(resolve(packageRoot, "dist/plugin-stdio.mjs")).href))
      .toBe(resolve(packageRoot, "dist/local-facade-daemon.mjs"))
    expect(resolveLocalFacadeDaemonEntry(pathToFileURL(resolve(packageRoot, "dist/local-runtime/runtime.js")).href))
      .toBe(resolve(packageRoot, "dist/local-facade-daemon.mjs"))
    expect(resolveLocalFacadeDaemonEntry(pathToFileURL(resolve(packageRoot, "src/local-runtime/runtime.ts")).href))
      .toBe(resolve(packageRoot, "dist/local-facade-daemon.mjs"))
  })

  it("keeps advanced bridge-home overrides self-contained", () => {
    const dataRoot = join(tmpdir(), "pippit-explicit-data-root")
    const paths = resolvePippitLocalRuntimePaths({ PIPPIT_BRIDGE_HOME: dataRoot }, tmpdir())
    expect(paths.outputRoot).toBe(join(dataRoot, "outputs"))
    expect(paths.outputRoot.startsWith(process.cwd())).toBe(false)
  })

  it("lands ordinary local outputs in the user's video folder by default", () => {
    const userHome = join(tmpdir(), "pippit-user-home")
    expect(resolvePippitLocalRuntimePaths({}, userHome, "darwin").outputRoot)
      .toBe(join(userHome, "Movies", "Pippit"))
    expect(resolvePippitLocalRuntimePaths({}, userHome, "linux").outputRoot)
      .toBe(join(userHome, "Videos", "Pippit"))
  })
})

function initializeRequest(id = 1): Record<string, unknown> {
  return {
    id,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
      protocolVersion: "2025-11-25",
    },
  }
}

function listAccessKeysRequests(): readonly Record<string, unknown>[] {
  return [
    initializeRequest(),
    {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "pippit_list_access_keys" },
    },
  ]
}

function toolCallResult(run: ProtocolRun): ToolCallResult | undefined {
  return run.responses.find((response) => response.id === 2)?.result as ToolCallResult | undefined
}

function expectToolCallError(run: ProtocolRun, code: string): void {
  expect(run.code).toBe(0)
  expect(run.stderr).toBe("")
  expect(toolCallResult(run)).toMatchObject({
    isError: true,
    structuredContent: { error: { code } },
  })
}

async function createAbsentDataRoot(prefix = "pippit-local-runtime-"): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), prefix))
  cleanupRoots.add(dataRoot)
  await rm(dataRoot, { force: true, recursive: true })
  return dataRoot
}

async function runPlugin(
  dataRoot: string,
  requests: readonly Record<string, unknown>[],
  additionalEnv: NodeJS.ProcessEnv = {},
): Promise<ProtocolRun> {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url))
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(packageRoot, "plugin-entry.mjs")], {
      cwd: packageRoot,
      env: {
        ...additionalEnv,
        PIPPIT_BRIDGE_HOME: dataRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stderr = ""
    let stdout = ""
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    child.once("error", reject)
    child.once("close", (code) => {
      const responses = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      resolveRun({ code, responses, stderr })
    })
    child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`)
  })
}

async function stopDaemon(dataRoot: string): Promise<void> {
  try {
    const descriptor = JSON.parse(await readFile(join(dataRoot, "facade-ready.json"), "utf8")) as { pid?: unknown }
    if (typeof descriptor.pid !== "number") return
    try {
      process.kill(descriptor.pid, "SIGTERM")
    } catch {
      return
    }
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      try {
        process.kill(descriptor.pid, 0)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
      } catch {
        return
      }
    }
  } catch {
    // No daemon was started.
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
    } catch {
      return
    }
  }
  throw new Error(`Process ${pid} did not exit in time.`)
}

async function startLegacyProofDaemon(options: {
  readonly ignoreSigterm?: boolean
  readonly instanceId: string
  readonly proofKeyHex: string
  readonly responsePid?: number | "self"
  readonly runtimeVersion: string
}): Promise<{ readonly pid: number; readonly port: number }> {
  const fixturePath = fileURLToPath(new URL("fixtures/legacy-proof-daemon.mjs", import.meta.url))
  return new Promise((resolveStart, rejectStart) => {
    const child = spawn(process.execPath, [fixturePath], {
      env: {
        ...process.env,
        PIPPIT_TEST_INSTANCE_ID: options.instanceId,
        ...(options.ignoreSigterm === true ? { PIPPIT_TEST_IGNORE_SIGTERM: "1" } : {}),
        PIPPIT_TEST_PROOF_KEY_HEX: options.proofKeyHex,
        ...(options.responsePid === undefined
          ? {}
          : { PIPPIT_TEST_RESPONSE_PID: String(options.responsePid) }),
        PIPPIT_TEST_RUNTIME_VERSION: options.runtimeVersion,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    let stdout = ""
    let settled = false
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk
      const lineEnd = stdout.indexOf("\n")
      if (settled || lineEnd === -1) return
      settled = true
      const ready = JSON.parse(stdout.slice(0, lineEnd)) as { pid: number; port: number }
      cleanupPids.add(ready.pid)
      resolveStart(ready)
    })
    child.once("error", rejectStart)
    child.once("exit", (code) => {
      if (!settled) rejectStart(new Error(`Legacy proof daemon exited with ${code}: ${stderr}`))
    })
  })
}

afterEach(async () => {
  for (const pid of cleanupPids) {
    try {
      process.kill(pid, "SIGTERM")
      await waitForProcessExit(pid)
    } catch {
      // The compatibility path already stopped the legacy daemon.
    }
  }
  cleanupPids.clear()
  for (const root of cleanupRoots) {
    await stopDaemon(root)
    await rm(root, { force: true, recursive: true })
  }
  cleanupRoots.clear()
})

describe("Pippit local runtime bootstrap", () => {
  it("keeps initialize and tools/list side-effect free on a clean install", async () => {
    const dataRoot = await createAbsentDataRoot()

    const discovery = await runPlugin(dataRoot, [
      initializeRequest(),
      { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
    ])

    expect(discovery.code).toBe(0)
    expect(discovery.stderr).toBe("")
    const tools = ((discovery.responses[1]?.result as { tools?: { name?: string }[] } | undefined)?.tools ?? [])
    expect(tools.map((tool) => tool.name)).toContain("pippit_generate_video")
    expect(tools.map((tool) => tool.name)).toContain("pippit_add_access_key")
    await expect(lstat(dataRoot)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("bootstraps one private Facade on first tool use without exposing internal keys", async () => {
    const dataRoot = await createAbsentDataRoot()

    const firstCall = await runPlugin(dataRoot, listAccessKeysRequests())
    expect(firstCall.code).toBe(0)
    expect(firstCall.stderr).toBe("")
    expect(toolCallResult(firstCall)?.isError).not.toBe(true)

    const directory = await lstat(dataRoot)
    const secrets = await lstat(join(dataRoot, "runtime-secrets.json"))
    const ready = await lstat(join(dataRoot, "facade-ready.json"))
    const store = await lstat(join(dataRoot, "byok", "credentials.json"))
    const idempotencySecret = await lstat(join(dataRoot, "idempotency", "secret-v1.json"))
    if (process.platform !== "win32") {
      expect(directory.mode & 0o777).toBe(0o700)
      expect(secrets.mode & 0o777).toBe(0o600)
      expect(ready.mode & 0o777).toBe(0o600)
      expect(store.mode & 0o777).toBe(0o600)
      expect(idempotencySecret.mode & 0o777).toBe(0o600)
    }

    const secretDocument = JSON.parse(await readFile(join(dataRoot, "runtime-secrets.json"), "utf8")) as {
      facade_api_key: string
      management_api_key: string
    }
    const visibleProtocol = `${firstCall.stderr}\n${firstCall.responses.map((response) => JSON.stringify(response)).join("\n")}`
    expect(visibleProtocol).not.toContain(secretDocument.facade_api_key)
    expect(visibleProtocol).not.toContain(secretDocument.management_api_key)
  }, 30_000)

  it.each([
    ["API key", { PIPPIT_FACADE_API_KEY: "test-facade-key" }],
    ["base URL", { PIPPIT_FACADE_BASE_URL: "http://127.0.0.1:65535" }],
    ["management key", { PIPPIT_FACADE_MANAGEMENT_API_KEY: "test-management-key" }],
  ])("fails closed for a partial external %s without starting local state", async (_label, env) => {
    const dataRoot = await createAbsentDataRoot("pippit-partial-external-")

    const result = await runPlugin(dataRoot, listAccessKeysRequests(), env)

    expectToolCallError(result, "partial_external_configuration")
    await expect(lstat(dataRoot)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not replace encryption keys when an existing BYOK store has no secrets file", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "pippit-missing-secrets-"))
    cleanupRoots.add(dataRoot)
    const storePath = join(dataRoot, "byok", "credentials.json")
    await mkdir(dirname(storePath), { mode: 0o700, recursive: true })
    await writeFile(storePath, "{\"existing\":true}\n", { encoding: "utf8", mode: 0o600 })

    const result = await runPlugin(dataRoot, listAccessKeysRequests())

    expectToolCallError(result, "missing_encryption_keys")
    await expect(readFile(storePath, "utf8")).resolves.toBe("{\"existing\":true}\n")
    await expect(lstat(join(dataRoot, "runtime-secrets.json"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(join(dataRoot, "facade-ready.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not replace the HMAC key when an idempotency store already exists", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "pippit-missing-idempotency-secret-"))
    cleanupRoots.add(dataRoot)
    const storePath = join(dataRoot, "idempotency", "mcp-v1.json")
    await mkdir(dirname(storePath), { mode: 0o700, recursive: true })
    await writeFile(storePath, "{\"existing\":true}\n", { encoding: "utf8", mode: 0o600 })

    const result = await runPlugin(dataRoot, listAccessKeysRequests())

    expectToolCallError(result, "missing_idempotency_key")
    await expect(readFile(storePath, "utf8")).resolves.toBe("{\"existing\":true}\n")
    await expect(lstat(join(dataRoot, "idempotency", "secret-v1.json"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(join(dataRoot, "facade-ready.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked secrets file without reading or replacing its target",
    async () => {
      const parent = await mkdtemp(join(tmpdir(), "pippit-symlink-secrets-"))
      cleanupRoots.add(parent)
      const dataRoot = join(parent, "runtime")
      const targetPath = join(parent, "decoy.json")
      await mkdir(dataRoot, { mode: 0o700 })
      await writeFile(targetPath, "{\"decoy\":true}\n", { encoding: "utf8", mode: 0o600 })
      await symlink(targetPath, join(dataRoot, "runtime-secrets.json"), "file")

      const result = await runPlugin(dataRoot, listAccessKeysRequests())

      expectToolCallError(result, "state_file_unavailable")
      await expect(readFile(targetPath, "utf8")).resolves.toBe("{\"decoy\":true}\n")
      await expect(lstat(join(dataRoot, "facade-ready.json"))).rejects.toMatchObject({ code: "ENOENT" })
    },
  )

  it("converges concurrent first tool calls from separate MCP processes on one runtime", async () => {
    const dataRoot = await createAbsentDataRoot("pippit-concurrent-runtime-")

    const concurrentRuns = await Promise.all(
      Array.from({ length: 6 }, () => runPlugin(dataRoot, listAccessKeysRequests())),
    )

    const runtimeErrors = concurrentRuns
      .map((run) => toolCallResult(run)?.structuredContent?.error?.code)
      .filter((code): code is string => code !== undefined)
    expect(runtimeErrors).toEqual([])
    for (const run of concurrentRuns) {
      expect(run.code).toBe(0)
      expect(run.stderr).toBe("")
      expect(toolCallResult(run)?.isError).not.toBe(true)
    }
    const descriptorBeforeReuse = await readFile(join(dataRoot, "facade-ready.json"), "utf8")
    await expect(lstat(join(dataRoot, "bootstrap.lock"))).rejects.toMatchObject({ code: "ENOENT" })

    const reuse = await runPlugin(dataRoot, listAccessKeysRequests())
    expect(toolCallResult(reuse)?.isError).not.toBe(true)
    await expect(readFile(join(dataRoot, "facade-ready.json"), "utf8")).resolves.toBe(descriptorBeforeReuse)
  }, 45_000)

  it.skipIf(process.platform === "win32")(
    "reuses an exact daemon artifact and replaces the same version when its bytes differ",
    async () => {
      const dataRoot = await createAbsentDataRoot("pippit-artifact-identity-")
      const firstArtifact = await createDaemonVariant("first")
      const secondArtifact = await createDaemonVariant("second")
      const env = { PIPPIT_BRIDGE_HOME: dataRoot }

      const first = await ensurePippitLocalRuntime({
        daemonModuleUrl: firstArtifact.moduleUrl,
        env,
      })
      expect(first.local?.daemon).toMatchObject({
        action: "started",
        artifactHash: firstArtifact.artifactHash,
        matchesExpectedArtifact: true,
      })
      const firstPid = first.local?.daemon.pid
      expect(firstPid).toEqual(expect.any(Number))

      const reused = await ensurePippitLocalRuntime({
        daemonModuleUrl: firstArtifact.moduleUrl,
        env,
      })
      expect(reused.local?.daemon).toMatchObject({
        action: "reused",
        artifactHash: firstArtifact.artifactHash,
        pid: firstPid,
      })

      const preservedFiles = new Map([
        ["runtime-secrets.json", await readFile(join(dataRoot, "runtime-secrets.json"), "utf8")],
        ["idempotency/secret-v1.json", await readFile(join(dataRoot, "idempotency/secret-v1.json"), "utf8")],
      ])
      await mkdir(join(dataRoot, "jobs"), { mode: 0o700 })
      await mkdir(join(dataRoot, "artifacts"), { mode: 0o700 })
      await writeFile(join(dataRoot, "jobs/preserved.json"), "{\"job\":\"preserved\"}\n", { mode: 0o600 })
      await writeFile(join(dataRoot, "artifacts/preserved.json"), "{\"artifact\":\"preserved\"}\n", { mode: 0o600 })

      const replaced = await ensurePippitLocalRuntime({
        daemonModuleUrl: secondArtifact.moduleUrl,
        env,
      })
      expect(replaced.local?.daemon).toMatchObject({
        action: "replaced",
        artifactHash: secondArtifact.artifactHash,
        matchesExpectedArtifact: true,
        previousPid: firstPid,
        previousPidStopped: true,
      })
      expect(replaced.local?.daemon.pid).not.toBe(firstPid)
      await waitForProcessExit(firstPid as number)

      for (const [relativePath, contents] of preservedFiles) {
        await expect(readFile(join(dataRoot, relativePath), "utf8")).resolves.toBe(contents)
      }
      await expect(readFile(join(dataRoot, "jobs/preserved.json"), "utf8"))
        .resolves.toBe("{\"job\":\"preserved\"}\n")
      await expect(readFile(join(dataRoot, "artifacts/preserved.json"), "utf8"))
        .resolves.toBe("{\"artifact\":\"preserved\"}\n")

      await expect(inspectPippitLocalRuntime({
        daemonModuleUrl: secondArtifact.moduleUrl,
        env,
      })).resolves.toMatchObject({
        artifactHash: secondArtifact.artifactHash,
        healthy: true,
        matchesExpectedArtifact: true,
        pid: replaced.local?.daemon.pid,
      })
    },
    30_000,
  )

  it.skipIf(process.platform === "win32")(
    "never kills a daemon authenticated by a different runtime root",
    async () => {
      const firstRoot = await createAbsentDataRoot("pippit-runtime-owner-a-")
      const secondRoot = await createAbsentDataRoot("pippit-runtime-owner-b-")
      const artifact = await createDaemonVariant("runtime-owner")
      const first = await ensurePippitLocalRuntime({
        daemonModuleUrl: artifact.moduleUrl,
        env: { PIPPIT_BRIDGE_HOME: firstRoot },
      })
      const second = await ensurePippitLocalRuntime({
        daemonModuleUrl: artifact.moduleUrl,
        env: { PIPPIT_BRIDGE_HOME: secondRoot },
      })
      const firstPid = first.local?.daemon.pid as number
      const secondPid = second.local?.daemon.pid as number
      process.kill(secondPid, "SIGKILL")
      await waitForProcessExit(secondPid)

      const firstDescriptor = JSON.parse(
        await readFile(join(firstRoot, "facade-ready.json"), "utf8"),
      ) as ReadyDescriptor
      const secondSecrets = JSON.parse(
        await readFile(join(secondRoot, "runtime-secrets.json"), "utf8"),
      ) as { bootstrap_proof_key_hex: string }
      const crossRootPayload = {
        daemon_artifact_sha256: firstDescriptor.daemon_artifact_sha256 as string,
        daemon_entry: firstDescriptor.daemon_entry as string,
        instance_id: firstDescriptor.instance_id,
        pid: firstDescriptor.pid,
        port: firstDescriptor.port,
        runtime_version: firstDescriptor.runtime_version,
        schema_version: 1 as const,
        started_at: firstDescriptor.started_at,
      }
      await writeFile(
        join(secondRoot, "facade-ready.json"),
        `${JSON.stringify({
          ...crossRootPayload,
          signature: signLocalRuntimeReadyPayload(
            crossRootPayload,
            secondSecrets.bootstrap_proof_key_hex,
          ),
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      )

      await expect(ensurePippitLocalRuntime({
        daemonModuleUrl: artifact.moduleUrl,
        env: { PIPPIT_BRIDGE_HOME: secondRoot },
      })).rejects.toMatchObject({ code: "live_daemon_verification_failed" })
      expect(() => process.kill(firstPid, 0)).not.toThrow()
    },
    30_000,
  )

  it.skipIf(process.platform === "win32")(
    "recovers a dead bootstrap owner that crashed before unlinking its hard-link candidate",
    async () => {
      const dataRoot = await mkdtemp(join(tmpdir(), "pippit-stale-bootstrap-link-"))
      cleanupRoots.add(dataRoot)
      const lockPath = join(dataRoot, "bootstrap.lock")
      const candidatePath = `${lockPath}.candidate-2147483647-crash`
      await writeFile(
        candidatePath,
        `${JSON.stringify({
          created_at: new Date(Date.now() - 2_000).toISOString(),
          pid: 2_147_483_647,
          schema_version: 1,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      )
      await link(candidatePath, lockPath)

      const recoveredRuns = await Promise.all(
        Array.from({ length: 6 }, () => runPlugin(dataRoot, listAccessKeysRequests())),
      )

      expect(recoveredRuns.map(recovered => ({
        code: recovered.code,
        result: toolCallResult(recovered),
        stderr: recovered.stderr,
      }))).not.toContainEqual(expect.objectContaining({ result: expect.objectContaining({ isError: true }) }))
      await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(lstat(candidatePath)).rejects.toMatchObject({ code: "ENOENT" })
    },
    30_000,
  )

  it.skipIf(process.platform === "win32")(
    "fails closed for a stale bootstrap lock hard-linked outside the candidate namespace",
    async () => {
      const dataRoot = await mkdtemp(join(tmpdir(), "pippit-unsafe-bootstrap-link-"))
      cleanupRoots.add(dataRoot)
      const lockPath = join(dataRoot, "bootstrap.lock")
      const unexpectedLinkPath = join(dataRoot, "unexpected-hard-link")
      await writeFile(
        unexpectedLinkPath,
        `${JSON.stringify({
          created_at: new Date(Date.now() - 2_000).toISOString(),
          pid: 2_147_483_647,
          schema_version: 1,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      )
      await link(unexpectedLinkPath, lockPath)

      const result = await runPlugin(dataRoot, listAccessKeysRequests())

      expectToolCallError(result, "unsafe_bootstrap_lock_link")
      await expect(lstat(lockPath)).resolves.toMatchObject({ nlink: 2 })
      await expect(lstat(unexpectedLinkPath)).resolves.toMatchObject({ nlink: 2 })
    },
  )

  it.skipIf(process.platform === "win32")(
    "authenticates and replaces an older local Facade after a package upgrade",
    async () => {
      const dataRoot = await createAbsentDataRoot("pippit-runtime-upgrade-")
      const initial = await runPlugin(dataRoot, listAccessKeysRequests())
      expect(toolCallResult(initial)?.isError).not.toBe(true)
      const initialDescriptor = JSON.parse(
        await readFile(join(dataRoot, "facade-ready.json"), "utf8"),
      ) as ReadyDescriptor
      process.kill(initialDescriptor.pid, "SIGKILL")
      await waitForProcessExit(initialDescriptor.pid)

      const secrets = JSON.parse(
        await readFile(join(dataRoot, "runtime-secrets.json"), "utf8"),
      ) as { bootstrap_proof_key_hex: string }
      const legacyVersion = "0.2.0"
      const instanceId = randomUUID()
      const legacy = await startLegacyProofDaemon({
        instanceId,
        proofKeyHex: secrets.bootstrap_proof_key_hex,
        runtimeVersion: legacyVersion,
      })
      const legacyPayload = {
        instance_id: instanceId,
        pid: legacy.pid,
        port: legacy.port,
        runtime_version: legacyVersion,
        schema_version: 1 as const,
        started_at: new Date().toISOString(),
      }
      await writeFile(
        join(dataRoot, "facade-ready.json"),
        `${JSON.stringify({
          ...legacyPayload,
          signature: signLocalRuntimeReadyPayload(legacyPayload, secrets.bootstrap_proof_key_hex),
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      )

      const upgradedRuns = await Promise.all(
        Array.from({ length: 6 }, () => runPlugin(dataRoot, listAccessKeysRequests())),
      )

      for (const upgraded of upgradedRuns) {
        expect(toolCallResult(upgraded)?.isError).not.toBe(true)
      }
      await waitForProcessExit(legacy.pid)
      cleanupPids.delete(legacy.pid)
      const upgradedDescriptor = JSON.parse(
        await readFile(join(dataRoot, "facade-ready.json"), "utf8"),
      ) as ReadyDescriptor
      expect(upgradedDescriptor.runtime_version).toBe(PIPPIT_LOCAL_RUNTIME_VERSION)
      expect(upgradedDescriptor.pid).not.toBe(legacy.pid)
    },
    30_000,
  )

  it.skipIf(process.platform === "win32")(
    "replaces an authenticated newer-version daemon when its artifact is unidentified",
    async () => {
      const dataRoot = await createAbsentDataRoot("pippit-runtime-no-downgrade-")
      const initial = await runPlugin(dataRoot, listAccessKeysRequests())
      expect(toolCallResult(initial)?.isError).not.toBe(true)
      const initialDescriptor = JSON.parse(
        await readFile(join(dataRoot, "facade-ready.json"), "utf8"),
      ) as ReadyDescriptor
      process.kill(initialDescriptor.pid, "SIGKILL")
      await waitForProcessExit(initialDescriptor.pid)

      const secrets = JSON.parse(
        await readFile(join(dataRoot, "runtime-secrets.json"), "utf8"),
      ) as { bootstrap_proof_key_hex: string }
      const newerVersion = "0.3.0"
      const instanceId = randomUUID()
      const newer = await startLegacyProofDaemon({
        instanceId,
        proofKeyHex: secrets.bootstrap_proof_key_hex,
        responsePid: "self",
        runtimeVersion: newerVersion,
      })
      const newerPayload = {
        instance_id: instanceId,
        pid: newer.pid,
        port: newer.port,
        runtime_version: newerVersion,
        schema_version: 1 as const,
        started_at: new Date().toISOString(),
      }
      const readyDocument = `${JSON.stringify({
        ...newerPayload,
        signature: signLocalRuntimeReadyPayload(newerPayload, secrets.bootstrap_proof_key_hex),
      })}\n`
      await writeFile(join(dataRoot, "facade-ready.json"), readyDocument, {
        encoding: "utf8",
        mode: 0o600,
      })

      const result = await runPlugin(dataRoot, listAccessKeysRequests())

      expect(toolCallResult(result)?.isError).not.toBe(true)
      await waitForProcessExit(newer.pid)
      cleanupPids.delete(newer.pid)
      const replacement = JSON.parse(
        await readFile(join(dataRoot, "facade-ready.json"), "utf8"),
      ) as ReadyDescriptor
      expect(replacement.pid).not.toBe(newer.pid)
      expect(replacement.daemon_artifact_sha256).toMatch(/^[a-f0-9]{64}$/u)
    },
    30_000,
  )

  it.skipIf(process.platform === "win32")(
    "fails closed when an authenticated incompatible daemon does not stop in time",
    async () => {
      const dataRoot = await createAbsentDataRoot("pippit-runtime-stop-timeout-")
      const initial = await runPlugin(dataRoot, listAccessKeysRequests())
      expect(toolCallResult(initial)?.isError).not.toBe(true)
      const initialDescriptor = JSON.parse(
        await readFile(join(dataRoot, "facade-ready.json"), "utf8"),
      ) as ReadyDescriptor
      process.kill(initialDescriptor.pid, "SIGKILL")
      await waitForProcessExit(initialDescriptor.pid)

      const secrets = JSON.parse(
        await readFile(join(dataRoot, "runtime-secrets.json"), "utf8"),
      ) as { bootstrap_proof_key_hex: string }
      const instanceId = randomUUID()
      const fixture = await startLegacyProofDaemon({
        ignoreSigterm: true,
        instanceId,
        proofKeyHex: secrets.bootstrap_proof_key_hex,
        runtimeVersion: "0.2.0",
      })
      const payload = {
        instance_id: instanceId,
        pid: fixture.pid,
        port: fixture.port,
        runtime_version: "0.2.0",
        schema_version: 1 as const,
        started_at: new Date().toISOString(),
      }
      await writeFile(
        join(dataRoot, "facade-ready.json"),
        `${JSON.stringify({
          ...payload,
          signature: signLocalRuntimeReadyPayload(payload, secrets.bootstrap_proof_key_hex),
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      )

      const result = await runPlugin(dataRoot, listAccessKeysRequests())
      expectToolCallError(result, "incompatible_daemon_stop_timeout")
      expect(() => process.kill(fixture.pid, 0)).not.toThrow()
      process.kill(fixture.pid, "SIGKILL")
      await waitForProcessExit(fixture.pid)
      cleanupPids.delete(fixture.pid)
    },
    30_000,
  )

  it.skipIf(process.platform === "win32")(
    "fails closed without starting a second daemon when a live proof PID does not match",
    async () => {
      const dataRoot = await createAbsentDataRoot("pippit-runtime-invalid-proof-pid-")
      const initial = await runPlugin(dataRoot, listAccessKeysRequests())
      expect(toolCallResult(initial)?.isError).not.toBe(true)
      const initialDescriptor = JSON.parse(
        await readFile(join(dataRoot, "facade-ready.json"), "utf8"),
      ) as ReadyDescriptor
      process.kill(initialDescriptor.pid, "SIGKILL")
      await waitForProcessExit(initialDescriptor.pid)

      const secrets = JSON.parse(
        await readFile(join(dataRoot, "runtime-secrets.json"), "utf8"),
      ) as { bootstrap_proof_key_hex: string }
      const instanceId = randomUUID()
      const fixture = await startLegacyProofDaemon({
        instanceId,
        proofKeyHex: secrets.bootstrap_proof_key_hex,
        responsePid: 2_147_483_647,
        runtimeVersion: PIPPIT_LOCAL_RUNTIME_VERSION,
      })
      const payload = {
        instance_id: instanceId,
        pid: fixture.pid,
        port: fixture.port,
        runtime_version: PIPPIT_LOCAL_RUNTIME_VERSION,
        schema_version: 1 as const,
        started_at: new Date().toISOString(),
      }
      const readyDocument = `${JSON.stringify({
        ...payload,
        signature: signLocalRuntimeReadyPayload(payload, secrets.bootstrap_proof_key_hex),
      })}\n`
      await writeFile(join(dataRoot, "facade-ready.json"), readyDocument, {
        encoding: "utf8",
        mode: 0o600,
      })

      const result = await runPlugin(dataRoot, listAccessKeysRequests())

      expectToolCallError(result, "live_daemon_verification_failed")
      expect(() => process.kill(fixture.pid, 0)).not.toThrow()
      await expect(readFile(join(dataRoot, "facade-ready.json"), "utf8")).resolves.toBe(readyDocument)
    },
    30_000,
  )

  it.skipIf(process.platform === "win32")(
    "reuses persisted secrets and removes only a dead daemon's stale BYOK lock",
    async () => {
      const dataRoot = await createAbsentDataRoot("pippit-crash-recovery-")
      const initial = await runPlugin(dataRoot, listAccessKeysRequests())
      expect(toolCallResult(initial)?.isError).not.toBe(true)

      const secretsBefore = await readFile(join(dataRoot, "runtime-secrets.json"), "utf8")
      const descriptorBefore = JSON.parse(
        await readFile(join(dataRoot, "facade-ready.json"), "utf8"),
      ) as ReadyDescriptor
      process.kill(descriptorBefore.pid, "SIGKILL")
      await waitForProcessExit(descriptorBefore.pid)
      await expect(lstat(join(dataRoot, "byok", "credentials.json.lock"))).resolves.toBeDefined()

      const recovered = await runPlugin(dataRoot, listAccessKeysRequests())
      expect(toolCallResult(recovered)?.isError).not.toBe(true)
      const descriptorAfter = JSON.parse(
        await readFile(join(dataRoot, "facade-ready.json"), "utf8"),
      ) as ReadyDescriptor
      expect(descriptorAfter.pid).not.toBe(descriptorBefore.pid)
      expect(descriptorAfter.instance_id).not.toBe(descriptorBefore.instance_id)
      await expect(readFile(join(dataRoot, "runtime-secrets.json"), "utf8")).resolves.toBe(secretsBefore)
    },
    30_000,
  )
})
