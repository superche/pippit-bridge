import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const sourcePath = resolve(root, "packages/mcp-server-pippit/package.json")

const targets = [
  ["packages/mcp-server-pippit/.codex-plugin/plugin.json", ["version"]],
  ["apps/chatgpt-app/package.json", ["version"]],
  ["apps/chatgpt-app/package.json", ["dependencies", "@pippit-bridge/mcp-server"]],
  ["packages/opencode-plugin-pippit/package.json", ["devDependencies", "@pippit-bridge/mcp-server"]],
  ["package-lock.json", ["packages", "packages/mcp-server-pippit", "version"]],
  ["package-lock.json", ["packages", "apps/chatgpt-app", "version"]],
  ["package-lock.json", ["packages", "apps/chatgpt-app", "dependencies", "@pippit-bridge/mcp-server"]],
  ["package-lock.json", ["packages", "packages/opencode-plugin-pippit", "devDependencies", "@pippit-bridge/mcp-server"]],
]

const textTargets = [
  ["packages/mcp-server-pippit/src/version.ts", /PIPPIT_PLUGIN_VERSION = "[^"]+"/u, version => `PIPPIT_PLUGIN_VERSION = "${version}"`],
  ["packages/mcp-server-pippit/src/image-widget.ts", /version: "\d+\.\d+\.\d+(?:-[^"]+)?"/u, version => `version: "${version}"`],
  ["packages/mcp-server-pippit/scripts/smoke-installed-plugin.mjs", /const EXPECTED_PLUGIN_VERSION = "[^"]+"/u, version => `const EXPECTED_PLUGIN_VERSION = "${version}"`],
  ["packages/mcp-server-pippit/scripts/smoke-installed-bin.mjs", /const EXPECTED_PLUGIN_VERSION = "[^"]+"/u, version => `const EXPECTED_PLUGIN_VERSION = "${version}"`],
  ["packages/mcp-server-pippit/scripts/smoke-installed-plugin-media.mjs", /const EXPECTED_PLUGIN_VERSION = "[^"]+"/u, version => `const EXPECTED_PLUGIN_VERSION = "${version}"`],
]

const internalDependencyVersions = [
  {
    source: "packages/contracts/package.json",
    targets: [
      ["packages/mcp-server-pippit/package.json", ["dependencies", "@pippit-bridge/contracts"]],
      ["apps/openrouter-facade/package.json", ["dependencies", "@pippit-bridge/contracts"]],
      ["package-lock.json", ["packages", "packages/contracts", "version"]],
      ["package-lock.json", ["packages", "packages/mcp-server-pippit", "dependencies", "@pippit-bridge/contracts"]],
      ["package-lock.json", ["packages", "apps/openrouter-facade", "dependencies", "@pippit-bridge/contracts"]],
    ],
  },
  {
    source: "packages/core/package.json",
    targets: [
      ["packages/mcp-server-pippit/package.json", ["dependencies", "@pippit-bridge/core"]],
      ["apps/openrouter-facade/package.json", ["dependencies", "@pippit-bridge/core"]],
      ["packages/opencode-plugin-pippit/package.json", ["devDependencies", "@pippit-bridge/core"]],
      ["package-lock.json", ["packages", "packages/core", "version"]],
      ["package-lock.json", ["packages", "packages/mcp-server-pippit", "dependencies", "@pippit-bridge/core"]],
      ["package-lock.json", ["packages", "apps/openrouter-facade", "dependencies", "@pippit-bridge/core"]],
      ["package-lock.json", ["packages", "packages/opencode-plugin-pippit", "devDependencies", "@pippit-bridge/core"]],
    ],
  },
  {
    source: "packages/sdk/package.json",
    targets: [
      ["apps/openrouter-facade/package.json", ["dependencies", "@pippit-bridge/sdk"]],
      ["packages/opencode-plugin-pippit/package.json", ["devDependencies", "@pippit-bridge/sdk"]],
      ["package-lock.json", ["packages", "packages/sdk", "version"]],
      ["package-lock.json", ["packages", "apps/openrouter-facade", "dependencies", "@pippit-bridge/sdk"]],
      ["package-lock.json", ["packages", "packages/opencode-plugin-pippit", "devDependencies", "@pippit-bridge/sdk"]],
    ],
  },
]

function getAt(value, path) {
  return path.reduce((current, key) => current?.[key], value)
}

function setAt(value, path, replacement) {
  let current = value
  for (const key of path.slice(0, -1)) current = current[key]
  current[path.at(-1)] = replacement
}

const source = JSON.parse(await readFile(sourcePath, "utf8"))
const requested = process.argv[2] === "sync" && process.argv[3] ? process.argv[3] : source.version
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(requested)) throw new Error("A valid exact semver is required.")
if (process.argv[2] === "sync" && source.version !== requested) {
  source.version = requested
  await writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`)
}

const drift = []
const marketplacePath = resolve(root, ".agents/plugins/marketplace.json")
const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"))
const marketplacePlugin = marketplace.plugins?.find(plugin => plugin.name === "pippit-video")
if (
  marketplace.name !== "pippit-bridge" ||
  marketplacePlugin?.source?.source !== "npm" ||
  marketplacePlugin.source.package !== "@pippit-bridge/mcp-server" ||
  marketplacePlugin.source.registry !== "https://registry.npmjs.org" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(marketplacePlugin.source.version ?? "")
) drift.push(".agents/plugins/marketplace.json:canonical-exact-direct-npm-source")
for (const [relativePath, jsonPath] of targets) {
  const filePath = resolve(root, relativePath)
  const value = JSON.parse(await readFile(filePath, "utf8"))
  const actual = getAt(value, jsonPath)
  if (actual === requested) continue
  if (process.argv[2] !== "sync") {
    drift.push(`${relativePath}:${jsonPath.join(".")}=${String(actual)}`)
    continue
  }
  setAt(value, jsonPath, requested)
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

for (const [relativePath, pattern, replacement] of textTargets) {
  const filePath = resolve(root, relativePath)
  const contents = await readFile(filePath, "utf8")
  const match = contents.match(pattern)?.[0]
  const expected = replacement(requested)
  if (match === expected) continue
  if (process.argv[2] !== "sync") {
    drift.push(`${relativePath}:${match ?? "version-marker-missing"}`)
    continue
  }
  if (match === undefined) throw new Error(`Version marker missing in ${relativePath}`)
  await writeFile(filePath, contents.replace(pattern, expected))
}

for (const dependency of internalDependencyVersions) {
  const dependencyVersion = JSON.parse(await readFile(resolve(root, dependency.source), "utf8")).version
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(dependencyVersion)) {
    throw new Error(`A valid exact semver is required in ${dependency.source}.`)
  }
  for (const [relativePath, jsonPath] of dependency.targets) {
    const filePath = resolve(root, relativePath)
    const value = JSON.parse(await readFile(filePath, "utf8"))
    const actual = getAt(value, jsonPath)
    if (actual === dependencyVersion) continue
    if (process.argv[2] !== "sync") {
      drift.push(`${relativePath}:${jsonPath.join(".")}=${String(actual)} expected=${dependencyVersion}`)
      continue
    }
    setAt(value, jsonPath, dependencyVersion)
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
  }
}

if (drift.length > 0) {
  process.stderr.write(`PLUGIN_VERSION_DRIFT expected=${requested}\n${drift.join("\n")}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`plugin-version ${requested} ${process.argv[2] === "sync" ? "synced" : "ok"}\n`)
}
