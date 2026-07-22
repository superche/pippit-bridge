import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { describe, expect, it } from "vitest"

const generatedPath = new URL("../assets/generated/pippit-video-job-v15.html", import.meta.url)
const templatePath = new URL("../src/widget/template.ts", import.meta.url)
const packagePath = fileURLToPath(new URL("..", import.meta.url))
const repoPath = fileURLToPath(new URL("../../..", import.meta.url))
const sourcePath = fileURLToPath(new URL("../src", import.meta.url))
const tscPath = fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url))
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex")

async function cleanWidgetBuild(workRoot: string): Promise<string> {
  const configPath = join(packagePath, "tsconfig.build.json")
  const isolatedConfigPath = join(workRoot, "tsconfig.json")
  await writeFile(isolatedConfigPath, JSON.stringify({
    compilerOptions: {
      composite: false,
      declaration: false,
      declarationMap: false,
      emitDeclarationOnly: false,
      incremental: false,
      inlineSourceMap: false,
      noEmit: false,
      noEmitOnError: true,
      outDir: workRoot,
      rootDir: sourcePath,
      sourceMap: false,
      typeRoots: [join(repoPath, "node_modules/@types")],
      types: ["node"],
    },
    extends: configPath,
    exclude: [],
    include: [join(sourcePath, "**/*.ts")],
  }))
  await new Promise<void>((resolveBuild, rejectBuild) => {
    const child = spawn(process.execPath, [tscPath, "-p", isolatedConfigPath], { cwd: packagePath })
    let output = ""
    child.stdout.on("data", chunk => { output += String(chunk) })
    child.stderr.on("data", chunk => { output += String(chunk) })
    child.once("error", rejectBuild)
    child.once("exit", code => code === 0 ? resolveBuild() : rejectBuild(new Error(output)))
  })
  const moduleUrl = pathToFileURL(join(workRoot, "widget/template.js")).href
  const html = await new Promise<string>((resolveHtml, rejectHtml) => {
    const source = "const built = await import(process.argv[1]); if (typeof built.PIPPIT_WIDGET_HTML !== 'string') process.exit(2); process.stdout.write(built.PIPPIT_WIDGET_HTML)"
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, moduleUrl], { cwd: packagePath })
    let output = ""
    let errorOutput = ""
    child.stdout.on("data", chunk => { output += String(chunk) })
    child.stderr.on("data", chunk => { errorOutput += String(chunk) })
    child.once("error", rejectHtml)
    child.once("exit", code => code === 0 ? resolveHtml(output) : rejectHtml(new Error(errorOutput)))
  })
  return normalizeHtml(html)
}

const normalizeHtml = (value: string): string => value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trimEnd()

async function browserSafetyBuild(): Promise<string> {
  const result = await build({
    absWorkingDir: packagePath,
    bundle: true,
    entryPoints: [templatePath.pathname],
    format: "esm",
    legalComments: "none",
    minify: false,
    platform: "browser",
    target: "es2022",
    treeShaking: true,
    write: false,
  })
  const javascript = result.outputFiles[0]?.text
  if (javascript === undefined) throw new Error("Clean Widget build produced no module.")
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
  const built = await import(moduleUrl) as { PIPPIT_WIDGET_HTML?: unknown }
  if (typeof built.PIPPIT_WIDGET_HTML !== "string") {
    throw new Error("Browser-safe Widget build did not export PIPPIT_WIDGET_HTML.")
  }
  return normalizeHtml(built.PIPPIT_WIDGET_HTML)
}

describe("Widget v15 deterministic asset", () => {
  it("matches two independent clean compiler builds, the canonical asset, and a browser-safe bundle", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "pippit-widget-clean-a-"))
    const secondRoot = await mkdtemp(join(tmpdir(), "pippit-widget-clean-b-"))
    try {
      // TypeScript's compiler API is process-global and is not documented as safe for
      // concurrent emits. Run truly independent builds sequentially so this test checks
      // reproducibility instead of compiler shared-state races.
      const first = await cleanWidgetBuild(firstRoot)
      const second = await cleanWidgetBuild(secondRoot)
      const browserBuilt = await browserSafetyBuild()
      const generated = await readFile(generatedPath, "utf8")
      expect(sha256(first)).toBe(sha256(second))
      expect(sha256(generated)).toBe(sha256(first))
      for (const html of [first, browserBuilt]) {
        expect(html).not.toMatch(/<(?:script|link)\b[^>]+(?:src|href)=["']https?:/iu)
        expect(html).not.toContain("sourceMappingURL")
        expect(html).not.toMatch(/(?:\/Users\/|[A-Za-z]:\\)/u)
      }
    } finally {
      await Promise.all([
        rm(firstRoot, { force: true, recursive: true }),
        rm(secondRoot, { force: true, recursive: true }),
      ])
    }
  })
})
