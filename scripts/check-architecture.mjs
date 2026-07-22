import { readFile, readdir, stat } from "node:fs/promises"
import { builtinModules } from "node:module"
import { relative, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const violations = []
const nodeBuiltins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
const productionLineLimit = 500

async function filesUnder(path) {
  const result = []
  const visit = async current => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const target = resolve(current, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile()) result.push(target)
    }
  }
  await visit(path)
  return result
}

async function forbid(path, pattern, message) {
  for (const file of await filesUnder(path)) {
    if (!/\.(?:ts|mjs)$/u.test(file)) continue
    if (pattern.test(await readFile(file, "utf8"))) violations.push(`${relative(root, file)}: ${message}`)
  }
}

async function compatibilityFacade(path, maxLines) {
  const source = await readFile(path, "utf8")
  const lines = source.trim().split("\n")
  if (lines.length > maxLines || lines.some(line => !line.trim().startsWith("export * from "))) {
    violations.push(`${relative(root, path)}: compatibility facade must contain only re-exports and stay under ${maxLines} lines`)
  }
}

async function checkRelativeImportCycles(paths) {
  const sourceFiles = (await Promise.all(paths.map(filesUnder))).flat().filter(file => file.endsWith(".ts"))
  const sourceSet = new Set(sourceFiles)
  const graph = new Map()
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8")
    const dependencies = []
    const matches = [
      ...source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/gu),
      ...source.matchAll(/\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/gu),
      ...source.matchAll(/^\s*import\s*["'](\.[^"']+)["']/gmu),
    ]
    for (const match of matches) {
      const specifier = match[1]
      if (specifier === undefined) continue
      const direct = resolve(file, "..", specifier.replace(/\.js$/u, ".ts"))
      const indexed = resolve(file, "..", specifier, "index.ts")
      if (sourceSet.has(direct)) dependencies.push(direct)
      else if (sourceSet.has(indexed)) dependencies.push(indexed)
    }
    graph.set(file, dependencies)
  }
  const active = new Set()
  const complete = new Set()
  const stack = []
  const visit = file => {
    if (complete.has(file)) return
    if (active.has(file)) {
      const start = stack.indexOf(file)
      const cycle = [...stack.slice(start), file].map(item => relative(root, item)).join(" -> ")
      violations.push(`${cycle}: relative import cycle`)
      return
    }
    active.add(file)
    stack.push(file)
    for (const dependency of graph.get(file) ?? []) visit(dependency)
    stack.pop()
    active.delete(file)
    complete.add(file)
  }
  for (const file of sourceFiles) visit(file)
}

async function checkWorkspacePackageCycles(paths) {
  const manifests = []
  for (const path of paths) {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      const manifestPath = resolve(path, entry.name, "package.json")
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
      manifests.push({ manifest, manifestPath })
    }
  }
  const workspaceNames = new Set(manifests.map(({ manifest }) => manifest.name))
  const graph = new Map(manifests.map(({ manifest }) => [
    manifest.name,
    Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
      .filter(name => workspaceNames.has(name)),
  ]))
  const active = new Set()
  const complete = new Set()
  const stack = []
  const visit = name => {
    if (complete.has(name)) return
    if (active.has(name)) {
      const start = stack.indexOf(name)
      violations.push(`${[...stack.slice(start), name].join(" -> ")}: workspace package cycle`)
      return
    }
    active.add(name)
    stack.push(name)
    for (const dependency of graph.get(name) ?? []) visit(dependency)
    stack.pop()
    active.delete(name)
    complete.add(name)
  }
  for (const name of graph.keys()) visit(name)
}

async function checkProductionModuleSizes(paths) {
  for (const file of (await Promise.all(paths.map(filesUnder))).flat()) {
    if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue
    const repoPath = relative(root, file)
    if (/(?:^|\/)(?:generated|golden|fixtures|test|tests)(?:\/|$)/u.test(repoPath)) continue
    const source = await readFile(file, "utf8")
    const lines = source.trim().split("\n").length
    if (lines <= productionLineLimit) continue
    violations.push(`${repoPath}: ${lines} lines exceeds the ${productionLineLimit}-line production module boundary`)
  }
}

await compatibilityFacade(resolve(root, "packages/mcp-server-pippit/src/tools.ts"), 100)
await compatibilityFacade(resolve(root, "packages/mcp-server-pippit/src/local-runtime.ts"), 100)
await compatibilityFacade(resolve(root, "packages/core/src/reference-loader.ts"), 100)
await compatibilityFacade(resolve(root, "packages/mcp-server-pippit/src/widget.ts"), 100)
if ((await readFile(resolve(root, "packages/mcp-server-pippit/src/stdio.ts"), "utf8")).trim().split("\n").length > 100) {
  violations.push("packages/mcp-server-pippit/src/stdio.ts: executable composition facade exceeds 100 lines")
}
if ((await readFile(resolve(root, "apps/openrouter-facade/src/app.ts"), "utf8")).trim().split("\n").length > 150) {
  violations.push("apps/openrouter-facade/src/app.ts: composition facade exceeds 150 lines")
}
await forbid(resolve(root, "packages/contracts/src"), /@pippit-bridge\/(?:core|sdk|mcp-server|openrouter-facade)/u, "contracts package must not depend on a consumer")
await forbid(resolve(root, "packages/mcp-server-pippit/src/widget"), /from ["']node:/u, "browser Widget code must not import node:*")
await forbid(resolve(root, "apps/openrouter-facade/src/app/services"), /Fastify(?:Request|Reply)|from ["']fastify["']/u, "application services must not depend on Fastify")
await forbid(resolve(root, "apps/openrouter-facade/src/app/routes"), /@pippit-bridge\/sdk|node:fs|\/byok\/store/u, "HTTP routes must use services and ports")
await checkRelativeImportCycles([
  resolve(root, "apps/openrouter-facade/src"),
  resolve(root, "packages/contracts/src"),
  resolve(root, "packages/core/src"),
  resolve(root, "packages/mcp-server-pippit/src"),
])
await checkWorkspacePackageCycles([
  resolve(root, "apps"),
  resolve(root, "packages"),
])
await checkProductionModuleSizes([
  resolve(root, "apps"),
  resolve(root, "packages"),
])

const workerMetaPath = resolve(root, "packages/mcp-server-pippit/dist/meta/worker-generation.esbuild.json")
if ((await stat(workerMetaPath).catch(() => undefined))?.isFile()) {
  const workerMeta = JSON.parse(await readFile(workerMetaPath, "utf8"))
  for (const input of Object.keys(workerMeta.inputs)) {
    if (/src\/dev-(?:stdio|gateway|supervisor)\.ts$/u.test(input)) {
      violations.push(`${input}: immutable Dev Host code entered the Worker artifact`)
    }
  }
}

for (const kind of ["dev-host", "facade-daemon", "worker-generation"]) {
  const metaPath = resolve(root, `packages/mcp-server-pippit/dist/meta/${kind}.esbuild.json`)
  if (!(await stat(metaPath).catch(() => undefined))?.isFile()) continue
  const meta = JSON.parse(await readFile(metaPath, "utf8"))
  for (const [output, description] of Object.entries(meta.outputs)) {
    for (const imported of description.imports ?? []) {
      if (imported.external === true && !nodeBuiltins.has(imported.path)) {
        violations.push(`${output}: ${kind} artifact retains private runtime external ${imported.path}`)
      }
    }
  }
}

if (violations.length > 0) {
  throw new Error(`Architecture boundary violations:\n${violations.map(item => `- ${item}`).join("\n")}`)
}
process.stdout.write("Architecture boundaries ok\n")
