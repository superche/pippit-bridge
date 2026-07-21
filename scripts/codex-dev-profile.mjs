import { execFile } from "node:child_process"
import { chmod, mkdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const DEV_PLUGIN_ID = "pippit-video@pippit-bridge-dev"
const RELEASE_PLUGIN_ID = "pippit-video@pippit-bridge"

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

export function buildMacLaunchArgs({ appPath, browserData, profileHome }) {
  return [
    "-na",
    appPath,
    "--env",
    `CODEX_HOME=${profileHome}`,
    "--args",
    `--user-data-dir=${browserData}`,
  ]
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
  const metadata = await stat(path)
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`DEV_PROFILE_OWNER_MISMATCH:${path}`)
  }
}

async function readPluginList(profileHome) {
  const result = await run("codex", ["plugin", "list", "--json"], {
    env: { ...process.env, CODEX_HOME: profileHome },
  })
  return JSON.parse(result.stdout)
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
  return {
    appRunningPids: findDevProcessIds(processes.stdout, paths.browserData),
    browserData: paths.browserData,
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

async function setup(paths) {
  await ensureOwnedDirectory(paths.profileHome)
  await ensureOwnedDirectory(paths.browserData)
  const existing = await readPluginList(paths.profileHome)
  const installed = Array.isArray(existing?.installed) ? existing.installed : []
  if (installed.some(plugin => plugin?.pluginId === RELEASE_PLUGIN_ID && plugin?.installed !== false)) {
    throw new Error(`DEV_PROFILE_CONTAINS_RELEASE_PLUGIN:${RELEASE_PLUGIN_ID}`)
  }

  await run(process.execPath, [resolve(root, "scripts/codex-dev.mjs"), "bootstrap"])

  const dataRoot = resolve(process.env.PIPPIT_BRIDGE_DEV_HOME ?? resolve(homedir(), ".pippit-bridge/dev-v1"))
  await readFile(resolve(dataRoot, ".agents/plugins/marketplace.json"), "utf8")
  const profileEnv = { ...process.env, CODEX_HOME: paths.profileHome }
  await run("codex", ["plugin", "marketplace", "add", dataRoot, "--json"], { env: profileEnv })

  await run("codex", ["plugin", "add", DEV_PLUGIN_ID, "--json"], { env: profileEnv })
  const status = await profileStatus(paths)
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

async function main() {
  const paths = resolveProfilePaths()
  const command = process.argv[2]
  if (command === "setup") await setup(paths)
  else if (command === "status") await status(paths)
  else if (command === "launch") await launch(paths)
  else throw new Error("Use setup, status, or launch.")
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main()
