import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { OPENAPI_DOCUMENT } from "../dist/openapi.js"

const path = resolve(import.meta.dirname, "../contracts/openapi.golden.json")
await writeFile(path, `${JSON.stringify(OPENAPI_DOCUMENT, null, 2)}\n`)
process.stdout.write(`Generated ${path}\n`)
