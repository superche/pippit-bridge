import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version ?? "")) throw new Error("Exact semver required.")
const root = resolve(import.meta.dirname, "..")
const path = resolve(root, ".agents/plugins/marketplace.json")
const catalog = JSON.parse(await readFile(path, "utf8"))
const plugin = catalog.plugins.find(item => item.name === "pippit-video")
if (!plugin) throw new Error("Canonical pippit-video entry missing.")
plugin.source = { package: "@pippit-bridge/mcp-server", registry: "https://registry.npmjs.org", source: "npm", version }
await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`)
