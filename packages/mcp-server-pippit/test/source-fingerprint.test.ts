import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
// @ts-expect-error The production build helper is intentionally a directly executable ESM script.
import { assertSourcesUnchanged, fingerprintSources } from "../scripts/source-fingerprint.mjs"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })),
  )
})

describe("build source fingerprints", () => {
  it("accepts an unchanged source and rejects a candidate superseded during build", async () => {
    const root = await mkdtemp(join(tmpdir(), "pippit-source-fingerprint-"))
    temporaryDirectories.push(root)
    const sourcePath = join(root, "source.ts")
    await writeFile(sourcePath, "export const value = 1\n", "utf8")
    const fingerprints = await fingerprintSources([sourcePath])

    await expect(assertSourcesUnchanged(fingerprints, { root })).resolves.toBeUndefined()

    await writeFile(sourcePath, "export const value = 2\n", "utf8")
    await expect(assertSourcesUnchanged(fingerprints, { root })).rejects.toThrow(
      "DEV_CANDIDATE_SUPERSEDED source-changed-during-build:source.ts",
    )
    expect(await readFile(sourcePath, "utf8")).toContain("value = 2")
  })

  it("keeps the fingerprint helper in the build recipe and source closure", async () => {
    const buildScript = await readFile(
      new URL("../scripts/build-artifact.mjs", import.meta.url),
      "utf8",
    )
    expect(buildScript).toContain("builderHelperHash")
    expect(buildScript).toContain("sourceFingerprintHelper")
    expect(buildScript).toContain("[buildScript, sourceFingerprintHelper]")
  })
})
