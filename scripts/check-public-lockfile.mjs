import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const lockfilePath = resolve(root, "package-lock.json")
const lockfile = JSON.parse(await readFile(lockfilePath, "utf8"))
const invalid = []

for (const [packagePath, metadata] of Object.entries(lockfile.packages ?? {})) {
  const resolved = metadata?.resolved
  if (typeof resolved !== "string" || !/^https?:/u.test(resolved)) continue
  const url = new URL(resolved)
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org") {
    invalid.push(`${packagePath || "<root>"}: ${resolved}`)
  }
}

if (invalid.length > 0) {
  throw new Error(`package-lock.json contains non-official remote packages:\n${invalid.join("\n")}`)
}

process.stdout.write("package-lock.json uses only https://registry.npmjs.org remote packages\n")
