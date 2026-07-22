import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { build, version as esbuildVersion } from "esbuild"
import { assertSourcesUnchanged, fingerprintSources } from "./source-fingerprint.mjs"

const packageRoot = resolve(import.meta.dirname, "..")
const repoRoot = resolve(packageRoot, "../..")
const metaRoot = resolve(packageRoot, "dist/meta")
const buildScript = resolve(import.meta.filename)
const sourceFingerprintHelper = resolve(packageRoot, "scripts/source-fingerprint.mjs")
const widgetAsset = resolve(packageRoot, "assets/generated/pippit-video-job-v15.html")
const widgetBuildScript = resolve(packageRoot, "scripts/build-widget.mjs")
const widgetTemplateSource = resolve(packageRoot, "src/widget/template.ts")

const recipes = {
  "dev-host": {
    entry: resolve(packageRoot, "src/dev-stdio.ts"),
    outfile: resolve(packageRoot, "dist/dev-gateway-stdio.mjs"),
  },
  "facade-daemon": {
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    entry: resolve(packageRoot, "scripts/local-facade-daemon-entry.mjs"),
    outfile: resolve(packageRoot, "dist/local-facade-daemon.mjs"),
  },
  "worker-generation": {
    entry: resolve(packageRoot, "src/stdio.ts"),
    outfile: resolve(packageRoot, "dist/plugin-stdio.mjs"),
    widgetAsset,
  },
}

const canonicalWidgetAssetPlugin = {
  name: "canonical-widget-asset",
  setup(buildContext) {
    buildContext.onLoad({ filter: /template\.ts$/ }, async args => {
      if (resolve(args.path) !== widgetTemplateSource) return undefined
      const html = await readFile(widgetAsset, "utf8")
      return {
        contents: `export const PIPPIT_WIDGET_HTML = ${JSON.stringify(html)};`,
        loader: "js",
      }
    })
  },
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex")
}

const commonBuildInputs = [
  resolve(repoRoot, "package.json"),
  resolve(repoRoot, "package-lock.json"),
  resolve(repoRoot, "tsconfig.base.json"),
  resolve(packageRoot, "package.json"),
  resolve(packageRoot, "tsconfig.json"),
  resolve(packageRoot, "tsconfig.build.json"),
]

const workspaceBuildRoots = new Map([
  ["apps/openrouter-facade/dist/", resolve(repoRoot, "apps/openrouter-facade")],
  ["packages/contracts/dist/", resolve(repoRoot, "packages/contracts")],
  ["packages/core/dist/", resolve(repoRoot, "packages/core")],
  ["packages/sdk/dist/", resolve(repoRoot, "packages/sdk")],
])

async function sourceFilesUnder(path) {
  const files = []
  const visit = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = resolve(current, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile() && /\.(?:js|mjs|ts|tsx)$/u.test(entry.name)) files.push(target)
    }
  }
  await visit(path)
  return files
}

async function sourceClosure(inputs, extraSources = []) {
  const files = new Set([...inputs, ...extraSources, ...commonBuildInputs].map(input => resolve(packageRoot, input)))
  const normalizedInputs = inputs.map(input => relative(repoRoot, resolve(packageRoot, input)).replaceAll("\\", "/"))
  for (const [compiledPrefix, workspaceRoot] of workspaceBuildRoots) {
    if (normalizedInputs.some(input => input.startsWith(compiledPrefix))) {
      for (const source of await sourceFilesUnder(resolve(workspaceRoot, "src"))) files.add(source)
      files.add(resolve(workspaceRoot, "package.json"))
      files.add(resolve(workspaceRoot, "tsconfig.json"))
      files.add(resolve(workspaceRoot, "tsconfig.build.json"))
    }
  }
  return [...files].sort((left, right) => left.localeCompare(right))
}

async function buildArtifact(kind) {
  const recipe = recipes[kind]
  if (!recipe) throw new Error(`Unknown artifact kind: ${kind}`)
  const buildOptions = {
    banner: recipe.banner,
    bundle: true,
    entryPoints: [recipe.entry],
    format: "esm",
    legalComments: "none",
    metafile: true,
    outfile: recipe.outfile,
    platform: "node",
    plugins: recipe.widgetAsset === undefined ? [] : [canonicalWidgetAssetPlugin],
    target: "node22",
  }
  const planning = await build({ ...buildOptions, write: false })
  const inputs = Object.keys(planning.metafile.inputs).sort()
  const extraSources = recipe.widgetAsset === undefined
    ? [buildScript, sourceFingerprintHelper]
    : [
        buildScript,
        sourceFingerprintHelper,
        recipe.widgetAsset,
        widgetBuildScript,
        ...await sourceFilesUnder(resolve(packageRoot, "src/widget")),
      ]
  const sourcePaths = await sourceClosure(inputs, extraSources)
  const beforeBuild = await fingerprintSources(sourcePaths)
  const result = await build(buildOptions)
  await assertSourcesUnchanged(beforeBuild, { root: repoRoot })
  const sourceGraph = []
  for (const absolute of sourcePaths) {
    sourceGraph.push({
      bytesHash: beforeBuild.get(absolute),
      path: relative(repoRoot, absolute).replaceAll("\\", "/"),
    })
  }
  const buildRecipe = {
    banner: recipe.banner ?? null,
    builder: relative(repoRoot, buildScript).replaceAll("\\", "/"),
    builderHash: hash(await readFile(buildScript)),
    builderHelper: relative(repoRoot, sourceFingerprintHelper).replaceAll("\\", "/"),
    builderHelperHash: hash(await readFile(sourceFingerprintHelper)),
    bundle: true,
    entry: relative(repoRoot, recipe.entry).replaceAll("\\", "/"),
    format: "esm",
    legalComments: "none",
    platform: "node",
    target: "node22",
    tool: `esbuild@${esbuildVersion}`,
    widgetAsset: recipe.widgetAsset === undefined
      ? null
      : relative(repoRoot, recipe.widgetAsset).replaceAll("\\", "/"),
  }
  const artifact = {
    artifactHash: hash(await readFile(recipe.outfile)),
    buildRecipeHash: hash(JSON.stringify(canonical(buildRecipe))),
    kind,
    output: relative(packageRoot, recipe.outfile).replaceAll("\\", "/"),
    sourceGraph,
    sourceGraphHash: hash(JSON.stringify(canonical(sourceGraph))),
    version: 1,
  }
  await mkdir(metaRoot, { recursive: true })
  await writeFile(resolve(metaRoot, `${kind}.json`), `${JSON.stringify(canonical(artifact), null, 2)}\n`)
  await writeFile(resolve(metaRoot, `${kind}.esbuild.json`), `${JSON.stringify(canonical(result.metafile), null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ artifactHash: artifact.artifactHash, kind, sourceGraphHash: artifact.sourceGraphHash })}\n`)
}

const requested = process.argv[2]
const kinds = requested === "all" ? Object.keys(recipes) : [requested]
for (const kind of kinds) await buildArtifact(kind)
