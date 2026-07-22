import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { PIPPIT_WIDGET_HTML } from "../dist/widget/template.js"

const output = resolve(import.meta.dirname, "../assets/generated/pippit-video-job-v15.html")
const normalized = PIPPIT_WIDGET_HTML.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trimEnd()
if (/<(?:script|link)\b[^>]+(?:src|href)=["']https?:/iu.test(normalized) || /\bimport\s*\(/u.test(normalized)) {
  throw new Error("Generated Widget must remain a dependency-free single HTML asset.")
}
await mkdir(resolve(output, ".."), { recursive: true })
const existing = await readFile(output, "utf8").catch(error => {
  if (error?.code === "ENOENT") return undefined
  throw error
})
if (existing === normalized) {
  process.stdout.write(`Unchanged ${output}\n`)
} else {
  await writeFile(output, normalized)
  process.stdout.write(`Generated ${output}\n`)
}
