import { createHash, randomBytes } from "node:crypto"
import { cp, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, relative, resolve, sep } from "node:path"
import { spawn } from "node:child_process"

const root = await realpath(resolve(import.meta.dirname, ".."))
const dataRoot = resolve(process.env.PIPPIT_BRIDGE_DEV_HOME ?? resolve(homedir(), ".pippit-bridge/dev-v1"))
const statePath = resolve(dataRoot, "status.json")
const pointerPath = resolve(dataRoot, "pointer.json")
const vitestPath = resolve(root, "node_modules/vitest/vitest.mjs")
const hotGateTests = [
  resolve(root, "packages/mcp-server-pippit/test/dev-gateway.integration.test.ts"),
  resolve(root, "packages/mcp-server-pippit/test/dev-supervisor.test.ts"),
  resolve(root, "packages/mcp-server-pippit/test/dev-widget.test.ts"),
]

function assertContained(path) {
  const relativePath = relative(dataRoot, path)
  if (relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) throw new Error("Dev path escapes the isolated data root.")
}

async function atomicJson(path, value) {
  assertContained(path)
  await mkdir(dirname(path), { mode: 0o700, recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

async function withStatusLock(operation) {
  const { acquirePrivateFileLock } = await import("../packages/core/dist/private-file/index.js")
  const { devStatusLockPath } = await import("../packages/mcp-server-pippit/dist/dev-manifest.js")
  const lock = await acquirePrivateFileLock(devStatusLockPath(statePath), {
    instanceId: `codex-dev-controller-${process.pid}`,
    retryAttempts: 200,
    retryDelayMs: 10,
  })
  try {
    return await operation()
  } finally {
    await lock.release()
  }
}

async function mutateStatus(transform) {
  return await withStatusLock(async () => {
    const current = JSON.parse(await readFile(statePath, "utf8").catch(() => "{}"))
    const next = transform(current)
    await atomicJson(statePath, next)
    return { current, next }
  })
}

async function replaceStatus(value) {
  await withStatusLock(async () => await atomicJson(statePath, value))
}

function exec(command, args) {
  return new Promise((resolveExec, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", code => code === 0 ? resolveExec() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)))
  })
}

async function testCandidate(changedFiles) {
  if (process.env.PIPPIT_CODEX_DEV_FULL_TESTS === "1") {
    await exec("npm", ["run", "test", "-w", "@pippit-bridge/mcp-server"])
    return "full"
  }
  const relatedInputs = [...new Set([...changedFiles, ...hotGateTests])]
  await exec(process.execPath, [
    vitestPath,
    "related",
    ...relatedInputs,
    "--run",
    "--configLoader",
    "native",
    "--passWithNoTests",
    "--reporter=dot",
  ])
  return "related+hot-core"
}

async function hashTree(path) {
  const hash = createHash("sha256")
  const directory = await import("node:fs/promises")
  async function visit(current) {
    for (const entry of (await directory.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (["dist", "node_modules"].includes(entry.name)) continue
      const target = resolve(current, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile()) hash.update(relative(path, target)).update(await readFile(target))
    }
  }
  await visit(path)
  return hash.digest("hex")
}

async function readArtifactIdentity(kind) {
  return JSON.parse(await readFile(resolve(root, `packages/mcp-server-pippit/dist/meta/${kind}.json`), "utf8"))
}

async function verifyArtifactSources(identity) {
  for (const input of identity.sourceGraph) {
    const contents = await readFile(resolve(root, input.path))
    const actual = createHash("sha256").update(contents).digest("hex")
    if (actual !== input.bytesHash) throw new Error("DEV_CANDIDATE_SUPERSEDED source-changed-during-build")
  }
}

function hashCanonical(value) {
  const canonical = item => {
    if (Array.isArray(item)) return item.map(canonical)
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]))
    }
    return item
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")
}

async function snapshotFiles(targets) {
  const snapshot = new Map()
  const visit = async (path) => {
    const metadata = await stat(path).catch(() => undefined)
    if (!metadata) return
    if (metadata.isFile()) {
      snapshot.set(path, `${metadata.mtimeMs}:${metadata.size}`)
      return
    }
    if (!metadata.isDirectory()) return
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (["dist", "node_modules"].includes(entry.name) || entry.name.endsWith(".tsbuildinfo")) continue
      await visit(resolve(path, entry.name))
    }
  }
  for (const target of targets) await visit(target)
  return snapshot
}

function changedFiles(previous, next) {
  const changed = []
  for (const path of new Set([...previous.keys(), ...next.keys()])) {
    if (previous.get(path) !== next.get(path)) changed.push(path)
  }
  return changed
}

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))

async function bootstrap() {
  await mkdir(dataRoot, { mode: 0o700, recursive: true })
  const rootStats = await stat(dataRoot)
  if (typeof process.getuid === "function" && rootStats.uid !== process.getuid()) throw new Error("Dev root owner mismatch.")
  await exec("npm", ["run", "check:plugin-contract"])
  const contractHash = await hashTree(resolve(root, "packages/mcp-server-pippit/contracts"))
  const hostArtifact = await readArtifactIdentity("dev-host")
  const daemonArtifact = await readArtifactIdentity("facade-daemon")
  const workerArtifact = await readArtifactIdentity("worker-generation")
  await Promise.all([hostArtifact, daemonArtifact, workerArtifact].map(verifyArtifactSources))
  const runtimeRoot = resolve(dataRoot, "runtime")
  await mkdir(runtimeRoot, { mode: 0o700, recursive: true })
  const generationId = `bootstrap-${workerArtifact.artifactHash.slice(0, 12)}`
  const generationRoot = resolve(dataRoot, "generations", generationId)
  await mkdir(generationRoot, { recursive: true })
  await cp(resolve(root, "packages/mcp-server-pippit/dist"), resolve(generationRoot, "dist"), { force: true, recursive: true })
  const { ChildMcpWorkerGeneration } = await import("../packages/mcp-server-pippit/dist/dev-worker-process.js")
  const started = await ChildMcpWorkerGeneration.start({
    contractHash,
    entryPath: resolve(generationRoot, "dist/plugin-stdio.mjs"),
    env: { ...process.env, PIPPIT_BRIDGE_HOME: runtimeRoot },
    generationId,
    implementationHash: workerArtifact.artifactHash,
    migrationEpoch: 1,
    storageBackwardCompatible: true,
  })
  const productionContractPath = resolve(dataRoot, "production-contract.json")
  const frozenContractPath = resolve(dataRoot, "frozen-contract.json")
  const { createEffectiveDevHostContract } = await import("../packages/mcp-server-pippit/dist/dev-gateway.js")
  const effectiveContract = createEffectiveDevHostContract(started.contract, { enableErrorPreview: true })
  await atomicJson(productionContractPath, started.contract)
  await atomicJson(frozenContractPath, effectiveContract)
  await started.worker.close()
  const { candidateSubjectHash, reviewDecisionHash } = await import("../packages/mcp-server-pippit/dist/dev-manifest.js")
  const candidateManifest = {
    buildRecipeHash: hashCanonical([hostArtifact.buildRecipeHash, daemonArtifact.buildRecipeHash, workerArtifact.buildRecipeHash]),
    daemonArtifactHash: daemonArtifact.artifactHash,
    hostContractHash: hashCanonical(effectiveContract),
    migrationEpoch: 1,
    sourceGraphHash: hashCanonical([hostArtifact.sourceGraphHash, daemonArtifact.sourceGraphHash, workerArtifact.sourceGraphHash]),
    storageSchemaEpoch: 1,
    testEvidenceHash: hashCanonical({ gate: "check:plugin-contract", phase: "bootstrap" }),
    workerArtifactHash: workerArtifact.artifactHash,
    workerContractHash: contractHash,
  }
  const review = {
    classification: "hot-compatible",
    migrationEpoch: 1,
    storageBackwardCompatible: true,
    subjectHash: "",
  }
  const subjectHash = candidateSubjectHash({
    activationClass: "hot-compatible",
    baseImplementationHash: workerArtifact.artifactHash,
    candidateManifest,
  })
  review.subjectHash = subjectHash
  const bundle = resolve(dataRoot, "gateway-bundle")
  await cp(resolve(root, "packages/mcp-server-pippit"), bundle, { filter: source => !source.includes(`${sep}node_modules${sep}`), force: true, recursive: true })
  await atomicJson(resolve(bundle, ".mcp.json"), {
    mcpServers: { "pippit-video": { args: ["./dev-plugin-entry.sh"], command: "/bin/sh", cwd: ".", tool_timeout_sec: 43200 } },
  })
  await atomicJson(resolve(dataRoot, ".agents/plugins/marketplace.json"), {
    interface: { displayName: "Pippit Bridge Dev" },
    name: "pippit-bridge-dev",
    plugins: [{
      category: "Creativity",
      name: "pippit-video",
      policy: { authentication: "ON_USE", installation: "AVAILABLE" },
      source: { path: "./gateway-bundle", source: "local" },
    }],
  })
  await replaceStatus({
    baseImplementationHash: workerArtifact.artifactHash,
    candidateManifest,
    candidatePhase: "none",
    desiredGeneration: generationId,
    desiredGenerationRoot: generationRoot,
    migrationEpoch: 1,
    phase: "desired",
    review,
    reviewDecisionHash: reviewDecisionHash(review),
    storageBackwardCompatible: true,
    subjectHash,
    updatedAt: new Date().toISOString(),
  })
  await atomicJson(pointerPath, {
    capability: randomBytes(32).toString("hex"),
    contractHash,
    daemonArtifactHash: daemonArtifact.artifactHash,
    devIdentity: "pippit-video@pippit-bridge-dev",
    frozenContractPath,
    gatewayBundle: bundle,
    hostArtifactHash: hostArtifact.artifactHash,
    marketplaceRoot: dataRoot,
    releaseIdentity: "pippit-video@pippit-bridge",
    repoRoot: root,
    productionContractPath,
    runtimeRoot,
    statusPath: statePath,
    version: 1,
  })
  process.stdout.write(`Dev gateway bundle prepared at ${bundle}. Install it only in an isolated Codex profile; release and dev plugins must not be enabled together.\n`)
}

async function buildCandidate(changedFiles) {
  const previous = JSON.parse(await readFile(statePath, "utf8").catch(() => "{}"))
  const baseImplementationHash = previous.activeImplementationHash
  if (typeof baseImplementationHash !== "string" || previous.phase !== "active") {
    await mutateStatus(current => ({
      ...current,
      candidateError: "DEV_BASE_GENERATION_UNOBSERVED",
      candidatePhase: "rejected",
      updatedAt: new Date().toISOString(),
    }))
    return
  }
  const candidateStartedAt = Date.now()
  await mutateStatus(current => ({
    ...current,
    candidateChangedFiles: changedFiles.map(path => relative(root, path)).sort(),
    candidatePhase: "staging",
    candidateTestMode: process.env.PIPPIT_CODEX_DEV_FULL_TESTS === "1" ? "full" : "related+hot-core",
    updatedAt: new Date().toISOString(),
  }))
  try {
    await exec("npm", ["run", "build:libs"])
    const testMode = await testCandidate(changedFiles)
    await exec("npm", ["run", "check:plugin-contract"])
    const hostArtifact = await readArtifactIdentity("dev-host")
    const daemonArtifact = await readArtifactIdentity("facade-daemon")
    const workerArtifact = await readArtifactIdentity("worker-generation")
    await Promise.all([hostArtifact, daemonArtifact, workerArtifact].map(verifyArtifactSources))
    const pointer = JSON.parse(await readFile(pointerPath, "utf8"))
    const { assertHotArtifactBinding, assertActiveGenerationBase, candidateSubjectHash, reviewDecisionHash } = await import("../packages/mcp-server-pippit/dist/dev-manifest.js")
    assertHotArtifactBinding(
      { daemonArtifactHash: daemonArtifact.artifactHash, hostArtifactHash: hostArtifact.artifactHash },
      { daemonArtifactHash: pointer.daemonArtifactHash, hostArtifactHash: pointer.hostArtifactHash },
    )
    const productionContract = JSON.parse(await readFile(pointer.productionContractPath, "utf8"))
    const effectiveContract = JSON.parse(await readFile(pointer.frozenContractPath, "utf8"))
    const candidateManifest = {
      buildRecipeHash: hashCanonical([hostArtifact.buildRecipeHash, daemonArtifact.buildRecipeHash, workerArtifact.buildRecipeHash]),
      daemonArtifactHash: daemonArtifact.artifactHash,
      hostContractHash: hashCanonical(effectiveContract),
      migrationEpoch: previous.migrationEpoch ?? 1,
      sourceGraphHash: hashCanonical([hostArtifact.sourceGraphHash, daemonArtifact.sourceGraphHash, workerArtifact.sourceGraphHash]),
      storageSchemaEpoch: 1,
      testEvidenceHash: hashCanonical({ changedFiles: changedFiles.map(path => relative(root, path)).sort(), testMode }),
      workerArtifactHash: workerArtifact.artifactHash,
      workerContractHash: pointer.contractHash,
    }
    const subjectHash = candidateSubjectHash({
      activationClass: "hot-compatible",
      baseImplementationHash,
      candidateManifest,
    })
    const review = JSON.parse(await readFile(resolve(root, ".pippit-dev/semantic-review.json"), "utf8"))
    if (review.subjectHash !== subjectHash || review.classification !== "hot-compatible") throw new Error("DEV_SEMANTIC_REVIEW_REQUIRED")
    const generationId = `${Date.now()}-${workerArtifact.artifactHash.slice(0, 12)}`
    const generationRoot = resolve(dataRoot, "generations", generationId)
    await mkdir(generationRoot, { recursive: true })
    await cp(resolve(root, "packages/mcp-server-pippit/dist"), resolve(generationRoot, "dist"), { recursive: true })
    const stagedWorker = resolve(generationRoot, "dist/plugin-stdio.mjs")
    const stagedDaemon = resolve(generationRoot, "dist/local-facade-daemon.mjs")
    if (createHash("sha256").update(await readFile(stagedWorker)).digest("hex") !== workerArtifact.artifactHash
      || createHash("sha256").update(await readFile(stagedDaemon)).digest("hex") !== daemonArtifact.artifactHash) {
      throw new Error("DEV_CANDIDATE_SUPERSEDED staged-artifact-changed")
    }
    const { ChildMcpWorkerGeneration } = await import("../packages/mcp-server-pippit/dist/dev-worker-process.js")
    const candidate = await ChildMcpWorkerGeneration.start({
      contractHash: pointer.contractHash,
      entryPath: resolve(generationRoot, "dist/plugin-stdio.mjs"),
      env: { ...process.env, PIPPIT_BRIDGE_HOME: resolve(dataRoot, "runtime") },
      generationId,
      implementationHash: workerArtifact.artifactHash,
      migrationEpoch: review.migrationEpoch ?? previous.migrationEpoch ?? 1,
      storageBackwardCompatible: review.storageBackwardCompatible === true,
    })
    try {
      if (JSON.stringify(candidate.contract) !== JSON.stringify(productionContract)) throw new Error("DEV_CONTRACT_MISMATCH requires-release-and-new-task")
    } finally {
      await candidate.worker.close()
    }
    await mutateStatus(current => {
      assertActiveGenerationBase(current, baseImplementationHash)
      return {
      ...current,
      baseImplementationHash,
      candidateManifest,
      candidateDurationMs: Date.now() - candidateStartedAt,
      candidatePhase: "none",
      candidateTestMode: testMode,
      desiredGeneration: generationId,
      desiredGenerationRoot: generationRoot,
      migrationEpoch: review.migrationEpoch ?? previous.migrationEpoch ?? 1,
      phase: "desired",
      review: {
        classification: review.classification,
        migrationEpoch: review.migrationEpoch ?? previous.migrationEpoch ?? 1,
        storageBackwardCompatible: review.storageBackwardCompatible === true,
        subjectHash,
      },
      reviewDecisionHash: reviewDecisionHash({
        classification: review.classification,
        migrationEpoch: review.migrationEpoch ?? previous.migrationEpoch ?? 1,
        storageBackwardCompatible: review.storageBackwardCompatible === true,
        subjectHash,
      }),
      storageBackwardCompatible: review.storageBackwardCompatible === true,
      subjectHash,
      updatedAt: new Date().toISOString(),
      }
    })
  } catch (error) {
    await mutateStatus(current => ({
      ...current,
      candidateDurationMs: Date.now() - candidateStartedAt,
      candidateError: error instanceof Error ? error.message : String(error),
      candidatePhase: "rejected",
      updatedAt: new Date().toISOString(),
    }))
  }
}

async function run() {
  await bootstrap()
  let building = false
  let queued = false
  let lastCandidateFiles = []
  const pendingChangedFiles = new Set()
  const drain = async () => {
    if (building) return
    building = true
    while (queued) {
      queued = false
      const changedFiles = pendingChangedFiles.size > 0 ? [...pendingChangedFiles] : lastCandidateFiles
      pendingChangedFiles.clear()
      if (changedFiles.length > 0) {
        lastCandidateFiles = changedFiles
        await buildCandidate(changedFiles)
      }
    }
    building = false
  }
  const reviewRoot = resolve(root, ".pippit-dev")
  await mkdir(reviewRoot, { recursive: true })
  const packageRoot = resolve(root, "packages/mcp-server-pippit")
  const implementationTargets = [
    resolve(root, "package.json"),
    resolve(root, "package-lock.json"),
    resolve(root, "tsconfig.base.json"),
    resolve(root, "packages/contracts/src"),
    resolve(root, "packages/contracts/package.json"),
    resolve(root, "packages/contracts/tsconfig.json"),
    resolve(root, "packages/contracts/tsconfig.build.json"),
    resolve(root, "packages/core/src"),
    resolve(root, "packages/core/package.json"),
    resolve(root, "packages/core/tsconfig.json"),
    resolve(root, "packages/core/tsconfig.build.json"),
    resolve(root, "packages/sdk/src"),
    resolve(root, "packages/sdk/package.json"),
    resolve(root, "packages/sdk/tsconfig.json"),
    resolve(root, "packages/sdk/tsconfig.build.json"),
    resolve(root, "apps/openrouter-facade/src"),
    resolve(root, "apps/openrouter-facade/package.json"),
    resolve(root, "apps/openrouter-facade/tsconfig.json"),
    resolve(root, "apps/openrouter-facade/tsconfig.build.json"),
    resolve(packageRoot, "src"),
    resolve(packageRoot, "scripts/build-artifact.mjs"),
    resolve(packageRoot, "scripts/build-widget.mjs"),
    resolve(packageRoot, "scripts/local-facade-daemon-entry.mjs"),
    resolve(packageRoot, "skills"),
    resolve(packageRoot, "contracts"),
    resolve(packageRoot, "assets"),
    resolve(packageRoot, ".codex-plugin"),
    resolve(packageRoot, "package.json"),
    resolve(packageRoot, "tsconfig.json"),
    resolve(packageRoot, "tsconfig.build.json"),
    resolve(packageRoot, ".mcp.json"),
    resolve(packageRoot, "plugin-entry.mjs"),
    resolve(packageRoot, "plugin-entry.sh"),
    resolve(packageRoot, "dev-plugin-entry.sh"),
  ]
  let implementationSnapshot = await snapshotFiles(implementationTargets)
  let reviewSnapshot = await snapshotFiles([reviewRoot])
  while (true) {
    await delay(500)
    const nextImplementationSnapshot = await snapshotFiles(implementationTargets)
    const implementationChanges = changedFiles(implementationSnapshot, nextImplementationSnapshot)
    implementationSnapshot = nextImplementationSnapshot
    for (const path of implementationChanges) pendingChangedFiles.add(path)
    const nextReviewSnapshot = await snapshotFiles([reviewRoot])
    const reviewChanged = changedFiles(reviewSnapshot, nextReviewSnapshot).length > 0
    reviewSnapshot = nextReviewSnapshot
    if (implementationChanges.length > 0 || reviewChanged) {
      queued = true
      await drain()
    }
  }
}

const command = process.argv[2]
if (command === "bootstrap") await bootstrap()
else if (command === "status") process.stdout.write(await readFile(statePath, "utf8").catch(() => "{\"phase\":\"not-started\"}\n"))
else if (command === "run") await run()
else throw new Error("Use bootstrap, status, or run.")
