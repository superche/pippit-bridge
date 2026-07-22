import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { relative } from "node:path"

function fingerprint(contents) {
  return createHash("sha256").update(contents).digest("hex")
}

export async function fingerprintSources(paths) {
  const fingerprints = new Map()
  for (const path of paths) fingerprints.set(path, fingerprint(await readFile(path)))
  return fingerprints
}

export async function assertSourcesUnchanged(fingerprints, options = {}) {
  for (const [path, expected] of fingerprints) {
    if (fingerprint(await readFile(path)) !== expected) {
      const displayPath = options.root === undefined ? path : relative(options.root, path)
      throw new Error(`DEV_CANDIDATE_SUPERSEDED source-changed-during-build:${displayPath}`)
    }
  }
}
