import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { chmod, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const DEV_MARKETPLACE_NAME = "pippit-bridge-dev"
const DEV_PLUGIN_NAME = "pippit-video"
const DEV_PLUGIN_ID = "pippit-video@pippit-bridge-dev"
const RELEASE_PLUGIN_ID = "pippit-video@pippit-bridge"
const PROCESS_STOP_TIMEOUT_MS = 15_000

export function resolveProfilePaths({
  env = process.env,
  home = homedir(),
  platform = process.platform,
} = {}) {
  const profileHome = resolve(env.PIPPIT_CODEX_DEV_PROFILE_HOME ?? resolve(home, ".codex-profiles/dev"))
  const defaultBrowserData = platform === "darwin"
    ? resolve(home, "Library/Application Support/Codex Dev")
    : resolve(home, ".config/Codex Dev")
  const browserData = resolve(env.PIPPIT_CODEX_DEV_BROWSER_DATA_DIR ?? defaultBrowserData)
  const productionBrowserData = platform === "darwin"
    ? resolve(home, "Library/Application Support/ChatGPT")
    : resolve(home, ".config/ChatGPT")

  if (profileHome === resolve(home, ".codex")) {
    throw new Error("DEV_PROFILE_REUSES_PRODUCTION_CODEX_HOME")
  }
  if (browserData === productionBrowserData) throw new Error("DEV_PROFILE_REUSES_PRODUCTION_BROWSER_DATA")
  if (browserData === profileHome) throw new Error("DEV_PROFILE_REUSES_BROWSER_DATA")

  return {
    appPath: resolve(env.PIPPIT_CODEX_APP_PATH ?? "/Applications/ChatGPT.app"),
    browserData,
    profileHome,
  }
}

export function validatePluginIsolation(pluginList) {
  const installed = Array.isArray(pluginList?.installed) ? pluginList.installed : []
  const pippitPlugins = installed.filter(plugin => plugin?.name === "pippit-video" && plugin?.installed !== false)
  if (pippitPlugins.some(plugin => plugin.pluginId === RELEASE_PLUGIN_ID)) {
    throw new Error(`DEV_PROFILE_CONTAINS_RELEASE_PLUGIN:${RELEASE_PLUGIN_ID}`)
  }
  const unexpected = pippitPlugins.filter(plugin => plugin.pluginId !== DEV_PLUGIN_ID)
  if (unexpected.length > 0) {
    throw new Error(`DEV_PROFILE_CONTAINS_UNEXPECTED_PIPPIT_PLUGIN:${unexpected.map(plugin => plugin.pluginId).join(",")}`)
  }
  const devPlugin = pippitPlugins.find(plugin => plugin.pluginId === DEV_PLUGIN_ID)
  if (!devPlugin || devPlugin.enabled === false) throw new Error(`DEV_PLUGIN_NOT_ENABLED:${DEV_PLUGIN_ID}`)
  return devPlugin
}

export function findDevProcessIds(processList, browserData) {
  const marker = `--user-data-dir=${browserData}`
  return processList
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.includes("/ChatGPT.app/Contents/MacOS/ChatGPT") && line.includes(marker))
    .map(line => Number.parseInt(line, 10))
    .filter(Number.isSafeInteger)
}

export function resolveDevPluginCacheRoot(profileHome) {
  return resolve(profileHome, "plugins/cache", DEV_MARKETPLACE_NAME)
}

export function assertSupportedDevNode(version = process.versions.node) {
  const parts = version.split(".").map(part => Number.parseInt(part, 10))
  const [major, minor, patch] = parts
  const supported = (
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) ||
    (major === 24 && minor >= 15) ||
    major >= 26
  )
  if (!supported) throw new Error(`CODEX_DEV_UNSUPPORTED_NODE:${version}`)
  return version
}

export function buildMacLaunchArgs({
  appPath,
  browserData,
  nodePath = process.execPath,
  profileHome,
}) {
  return [
    "-na",
    appPath,
    "--env",
    `CODEX_HOME=${profileHome}`,
    "--env",
    `PIPPIT_NODE_PATH=${nodePath}`,
    "--args",
    `--user-data-dir=${browserData}`,
  ]
}

function resolveDevDataRoot(env = process.env, home = homedir()) {
  return resolve(env.PIPPIT_BRIDGE_DEV_HOME ?? resolve(home, ".pippit-bridge/dev-v1"))
}

async function run(command, args, { env = process.env, reject = true } = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: root,
      encoding: "utf8",
      env,
      maxBuffer: 10 * 1024 * 1024,
    })
    return { code: 0, stderr: result.stderr, stdout: result.stdout }
  } catch (error) {
    const result = {
      code: typeof error.code === "number" ? error.code : 1,
      stderr: error.stderr ?? "",
      stdout: error.stdout ?? "",
    }
    if (reject) {
      const detail = result.stderr.trim() || result.stdout.trim() || error.message
      throw new Error(`${command} ${args.join(" ")} failed: ${detail}`)
    }
    return result
  }
}

async function ensureOwnedDirectory(path) {
  await mkdir(path, { mode: 0o700, recursive: true })
  await chmod(path, 0o700)
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`DEV_PROFILE_DIRECTORY_UNSAFE:${path}`)
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`DEV_PROFILE_OWNER_MISMATCH:${path}`)
  }
}

async function pathMetadata(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === "ENOENT") return undefined
    throw error
  }
}

async function assertSafeDevPluginCacheRoot(profileHome) {
  const cacheRoot = resolveDevPluginCacheRoot(profileHome)
  const relativePath = relative(profileHome, cacheRoot)
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    relativePath.includes(`..${sep}`) ||
    dirname(dirname(relativePath)) !== "plugins"
  ) {
    throw new Error(`DEV_PLUGIN_CACHE_ESCAPES_PROFILE:${cacheRoot}`)
  }
  const metadata = await pathMetadata(cacheRoot)
  if (!metadata) return { cacheRoot, exists: false }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`DEV_PLUGIN_CACHE_UNSAFE:${cacheRoot}`)
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`DEV_PLUGIN_CACHE_OWNER_MISMATCH:${cacheRoot}`)
  }
  return { cacheRoot, exists: true }
}

export async function clearDevPluginCache(profileHome) {
  const { cacheRoot, exists } = await assertSafeDevPluginCacheRoot(profileHome)
  if (!exists) return false
  await rm(cacheRoot, { force: false, maxRetries: 3, recursive: true, retryDelay: 100 })
  return true
}

async function hashTree(path) {
  const hash = createHash("sha256")
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === "node_modules" || entry.name.endsWith(".tsbuildinfo")) continue
      const target = resolve(current, entry.name)
      const relativePath = relative(path, target)
      if (entry.isSymbolicLink()) throw new Error(`DEV_PLUGIN_CACHE_CONTAINS_SYMLINK:${target}`)
      if (entry.isDirectory()) {
        hash.update(`directory:${relativePath}\0`)
        await visit(target)
      } else if (entry.isFile()) {
        hash.update(`file:${relativePath}\0`).update(await readFile(target))
      }
    }
  }
  await visit(path)
  return hash.digest("hex")
}

async function hashTreeIfPresent(path) {
  const metadata = await pathMetadata(path)
  if (!metadata) return undefined
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`DEV_PLUGIN_TREE_UNSAFE:${path}`)
  }
  return hashTree(path)
}

async function inspectDevPluginCache(paths, devPlugin) {
  const dataRoot = resolveDevDataRoot()
  const gatewayBundle = resolve(dataRoot, "gateway-bundle")
  const cachePath = resolve(
    resolveDevPluginCacheRoot(paths.profileHome),
    DEV_PLUGIN_NAME,
    devPlugin.version,
  )
  const [gatewayHash, cacheHash] = await Promise.all([
    hashTreeIfPresent(gatewayBundle),
    hashTreeIfPresent(cachePath),
  ])
  const registeredSource = devPlugin?.source?.path
  const registeredMarketplaceSource = devPlugin?.marketplaceSource?.source
  const sourceMatches = (
    typeof registeredSource === "string" &&
    resolve(registeredSource) === gatewayBundle &&
    typeof registeredMarketplaceSource === "string" &&
    resolve(registeredMarketplaceSource) === dataRoot
  )
  return {
    cacheHash,
    cachePath,
    fresh: Boolean(sourceMatches && gatewayHash && cacheHash && gatewayHash === cacheHash),
    gatewayBundle,
    gatewayHash,
    registeredMarketplaceSource,
    registeredSource,
    sourceMatches,
  }
}

async function readPluginList(profileHome) {
  const result = await run("codex", ["plugin", "list", "--json"], {
    env: { ...process.env, CODEX_HOME: profileHome },
  })
  return JSON.parse(result.stdout)
}

async function readMarketplaceList(profileHome) {
  const result = await run("codex", ["plugin", "marketplace", "list", "--json"], {
    env: { ...process.env, CODEX_HOME: profileHome },
  })
  return JSON.parse(result.stdout)
}

async function readDevProcessIds(paths) {
  if (process.platform !== "darwin") return []
  const processes = await run("ps", ["-axo", "pid=,command="])
  return findDevProcessIds(processes.stdout, paths.browserData)
}

async function stopDevApp(paths) {
  let pids = await readDevProcessIds(paths)
  for (const pid of pids) process.kill(pid, "SIGTERM")
  const deadline = Date.now() + PROCESS_STOP_TIMEOUT_MS
  while (pids.length > 0 && Date.now() < deadline) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
    pids = await readDevProcessIds(paths)
  }
  if (pids.length > 0) throw new Error(`CODEX_DEV_APP_DID_NOT_STOP:${pids.join(",")}`)
  return pids.length === 0
}

async function profileStatus(paths) {
  const profileEnv = { ...process.env, CODEX_HOME: paths.profileHome }
  const [login, plugins, processes] = await Promise.all([
    run("codex", ["login", "status"], { env: profileEnv, reject: false }),
    readPluginList(paths.profileHome),
    process.platform === "darwin"
      ? run("ps", ["-axo", "pid=,command="])
      : Promise.resolve({ stdout: "" }),
  ])
  const devPlugin = validatePluginIsolation(plugins)
  const cache = await inspectDevPluginCache(paths, devPlugin)
  return {
    appRunningPids: findDevProcessIds(processes.stdout, paths.browserData),
    browserData: paths.browserData,
    cache,
    devPlugin: {
      enabled: devPlugin.enabled !== false,
      pluginId: devPlugin.pluginId,
      version: devPlugin.version,
    },
    loggedIn: login.code === 0,
    loginStatus: (login.stdout || login.stderr).trim(),
    profileHome: paths.profileHome,
  }
}

async function prepareGateway(paths) {
  assertSupportedDevNode()
  await ensureOwnedDirectory(paths.profileHome)
  await ensureOwnedDirectory(paths.browserData)
  await run(process.execPath, [resolve(root, "scripts/codex-dev.mjs"), "bootstrap"])
  const dataRoot = resolveDevDataRoot()
  await readFile(resolve(dataRoot, ".agents/plugins/marketplace.json"), "utf8")
  return dataRoot
}

async function assertNoReleasePlugin(paths) {
  const existing = await readPluginList(paths.profileHome)
  const installed = Array.isArray(existing?.installed) ? existing.installed : []
  if (installed.some(plugin => plugin?.pluginId === RELEASE_PLUGIN_ID && plugin?.installed !== false)) {
    throw new Error(`DEV_PROFILE_CONTAINS_RELEASE_PLUGIN:${RELEASE_PLUGIN_ID}`)
  }
  return existing
}

async function installFreshDevPlugin(paths, dataRoot, existing) {
  const profileEnv = { ...process.env, CODEX_HOME: paths.profileHome }
  const installed = Array.isArray(existing?.installed) ? existing.installed : []
  const cacheBefore = await assertSafeDevPluginCacheRoot(paths.profileHome)
  if (installed.some(plugin => plugin?.pluginId === DEV_PLUGIN_ID && plugin?.installed !== false)) {
    await run("codex", ["plugin", "remove", DEV_PLUGIN_ID, "--json"], { env: profileEnv })
  }
  await clearDevPluginCache(paths.profileHome)

  const marketplaceList = await readMarketplaceList(paths.profileHome)
  const marketplaces = Array.isArray(marketplaceList?.marketplaces) ? marketplaceList.marketplaces : []
  const marketplaceReset = marketplaces.some(marketplace => marketplace?.name === DEV_MARKETPLACE_NAME)
  if (marketplaceReset) {
    await run("codex", ["plugin", "marketplace", "remove", DEV_MARKETPLACE_NAME, "--json"], { env: profileEnv })
  }
  await run("codex", ["plugin", "marketplace", "add", dataRoot, "--json"], { env: profileEnv })
  await run("codex", ["plugin", "add", DEV_PLUGIN_ID, "--json"], { env: profileEnv })

  const status = await profileStatus(paths)
  if (!status.cache.fresh) throw new Error("DEV_PLUGIN_CACHE_REFRESH_MISMATCH")
  return {
    ...status,
    coldRefresh: {
      cacheCleared: cacheBefore.exists,
      marketplaceReset,
    },
  }
}

async function setup(paths) {
  await ensureOwnedDirectory(paths.profileHome)
  await ensureOwnedDirectory(paths.browserData)
  const runningPids = await readDevProcessIds(paths)
  if (runningPids.length > 0) throw new Error(`CODEX_DEV_APP_RUNNING_REQUIRES_RESTART:${runningPids.join(",")}`)
  const existing = await assertNoReleasePlugin(paths)
  const dataRoot = await prepareGateway(paths)
  const status = await installFreshDevPlugin(paths, dataRoot, existing)
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
}

async function status(paths) {
  process.stdout.write(`${JSON.stringify(await profileStatus(paths), null, 2)}\n`)
}

async function launch(paths) {
  if (process.platform !== "darwin") {
    throw new Error("CODEX_DEV_DESKTOP_LAUNCH_REQUIRES_MACOS")
  }
  const current = await profileStatus(paths)
  if (current.appRunningPids.length > 0) {
    process.stdout.write(`${JSON.stringify({ ...current, launched: false, reason: "already-running" }, null, 2)}\n`)
    return
  }
  await run("open", buildMacLaunchArgs(paths))
  process.stdout.write(`${JSON.stringify({ ...current, launched: true }, null, 2)}\n`)
}

async function restart(paths) {
  if (process.platform !== "darwin") {
    throw new Error("CODEX_DEV_DESKTOP_RESTART_REQUIRES_MACOS")
  }
  await ensureOwnedDirectory(paths.profileHome)
  await ensureOwnedDirectory(paths.browserData)
  const existing = await assertNoReleasePlugin(paths)
  const dataRoot = await prepareGateway(paths)
  const stoppedPids = await readDevProcessIds(paths)
  await stopDevApp(paths)
  const current = await installFreshDevPlugin(paths, dataRoot, existing)
  await run("open", buildMacLaunchArgs(paths))
  process.stdout.write(`${JSON.stringify({
    ...current,
    launched: true,
    restartedPids: stoppedPids,
  }, null, 2)}\n`)
}

async function main() {
  const paths = resolveProfilePaths()
  const command = process.argv[2]
  if (command === "setup") await setup(paths)
  else if (command === "status") await status(paths)
  else if (command === "launch") await launch(paths)
  else if (command === "restart") await restart(paths)
  else throw new Error("Use setup, status, launch, or restart.")
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main()
