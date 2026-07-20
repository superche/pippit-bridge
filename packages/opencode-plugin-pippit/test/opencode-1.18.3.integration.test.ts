import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"

const executeFile = promisify(execFile)
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = resolve(packageDirectory, "../..")
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("OpenCode 1.18.3 configuration integration", () => {
  it("loads the built plugin without adding a provider filter or changing the host default model", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "pippit-opencode-1183-"))
    temporaryDirectories.push(runtimeDirectory)
    const pluginUrl = pathToFileURL(join(packageDirectory, "dist", "plugin.mjs")).href
    const binary = join(repositoryRoot, "node_modules", "opencode-ai", "bin", "opencode.exe")
    const hostModel = "opencode/big-pickle"
    const cacheDirectory = join(runtimeDirectory, "cache")
    const configDirectory = join(runtimeDirectory, "config")
    const dataDirectory = join(runtimeDirectory, "data")
    const stateDirectory = join(runtimeDirectory, "state")
    await Promise.all(
      [cacheDirectory, configDirectory, dataDirectory, stateDirectory].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    )

    const { stdout } = await executeFile(binary, ["debug", "config"], {
      cwd: packageDirectory,
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [pluginUrl], model: hostModel }),
        OPENCODE_CONFIG_DIR: packageDirectory,
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        XDG_CACHE_HOME: cacheDirectory,
        XDG_CONFIG_HOME: configDirectory,
        XDG_DATA_HOME: dataDirectory,
        XDG_STATE_HOME: stateDirectory,
      },
      timeout: 120_000,
    })
    const config = JSON.parse(stdout) as {
      readonly model?: string
      readonly plugin?: readonly string[]
      readonly provider?: Readonly<Record<string, unknown>>
    }

    expect(config.plugin).toContain(pluginUrl)
    expect(config.model).toBe(hostModel)
    expect(config.provider).toBeUndefined()
  }, 130_000)
})
