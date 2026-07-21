import { spawn } from "node:child_process"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const packageRoot = resolve(root, "packages/mcp-server-pippit")
const temporary = await mkdtemp(resolve(tmpdir(), "pippit-release-artifact-"))

function exec(command, args, options = {}) {
  return new Promise((resolveExec, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? root, env: options.env ?? process.env, stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", code => code === 0 ? resolveExec() : reject(new Error(`${command} exited ${code}`)))
  })
}

try {
  const isolatedEnvironment = { ...process.env, npm_config_cache: resolve(temporary, "npm-cache") }
  await exec("npm", ["pack", "-w", "@pippit-bridge/mcp-server", "--pack-destination", temporary], { env: isolatedEnvironment })
  const tarball = resolve(temporary, (await readdir(temporary)).find(name => name.endsWith(".tgz")))
  const extracted = resolve(temporary, "cache-simulation")
  await exec("mkdir", [extracted])
  await exec("tar", ["-xzf", tarball, "-C", extracted, "--strip-components=1"])
  const required = [
    ".codex-plugin/plugin.json", ".mcp.json", "plugin-entry.mjs", "plugin-entry.sh",
    "skills/pippit-video/SKILL.md", "dist/plugin-stdio.mjs", "dist/local-facade-daemon.mjs",
  ]
  for (const path of required) await readFile(resolve(extracted, path))
  const listing = await new Promise((resolveListing, reject) => {
    const child = spawn("tar", ["-tzf", tarball], { stdio: ["ignore", "pipe", "inherit"] })
    let output = ""
    child.stdout.on("data", chunk => { output += chunk })
    child.once("error", reject)
    child.once("exit", code => code === 0 ? resolveListing(output) : reject(new Error("tar listing failed")))
  })
  if (/(?:watcher|dev-origin|debug-token|node_modules|\.env|package\/dist\/dev-|package\/src\/)/iu.test(listing)) throw new Error("Release artifact contains forbidden development material.")
  const contents = await Promise.all(required.map(path => readFile(resolve(extracted, path), "utf8").catch(() => "")))
  if (contents.some(value => value.includes(root))) throw new Error("Release artifact leaks the worktree path.")
  await exec("node", [resolve(packageRoot, "scripts/smoke-installed-plugin.mjs"), resolve(extracted, "plugin-entry.mjs")], {
    cwd: extracted,
    env: { ...isolatedEnvironment, npm_config_offline: "true", PIPPIT_BRIDGE_HOME: resolve(temporary, "runtime") },
  })
  process.stdout.write(`release-artifact ok ${basename(tarball)} platform=${process.platform} launcher=/bin/sh\n`)
} finally {
  await rm(temporary, { force: true, recursive: true })
}
