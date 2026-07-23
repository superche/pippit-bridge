import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import {
  assertSupportedDevNode,
  buildMacLaunchArgs,
  clearDevPluginCache,
  findDevProcessIds,
  resolveDevPluginCacheRoot,
  resolveProfilePaths,
  validatePluginIsolation,
} from "./codex-dev-profile.mjs"

describe("Codex Dev profile", () => {
  it("derives stable profile paths without reusing production data", () => {
    expect(resolveProfilePaths({ env: {}, home: "/Users/dev", platform: "darwin" })).toEqual({
      appPath: "/Applications/ChatGPT.app",
      browserData: "/Users/dev/Library/Application Support/Codex Dev",
      profileHome: "/Users/dev/.codex-profiles/dev",
    })
  })

  it("rejects production profile and browser directories", () => {
    expect(() => resolveProfilePaths({
      env: { PIPPIT_CODEX_DEV_PROFILE_HOME: "/Users/dev/.codex" },
      home: "/Users/dev",
      platform: "darwin",
    })).toThrow("DEV_PROFILE_REUSES_PRODUCTION_CODEX_HOME")
    expect(() => resolveProfilePaths({
      env: { PIPPIT_CODEX_DEV_BROWSER_DATA_DIR: "/Users/dev/Library/Application Support/ChatGPT" },
      home: "/Users/dev",
      platform: "darwin",
    })).toThrow("DEV_PROFILE_REUSES_PRODUCTION_BROWSER_DATA")
  })

  it("does not treat an inherited Dev CODEX_HOME as production", () => {
    expect(resolveProfilePaths({
      env: { CODEX_HOME: "/Users/dev/.codex-profiles/dev" },
      home: "/Users/dev",
      platform: "darwin",
    }).profileHome).toBe("/Users/dev/.codex-profiles/dev")
  })

  it("requires the repository-supported Node ranges for cold setup", () => {
    expect(assertSupportedDevNode("22.22.2")).toBe("22.22.2")
    expect(assertSupportedDevNode("24.15.0")).toBe("24.15.0")
    expect(assertSupportedDevNode("26.0.0")).toBe("26.0.0")
    expect(() => assertSupportedDevNode("22.19.0")).toThrow("CODEX_DEV_UNSUPPORTED_NODE:22.19.0")
    expect(() => assertSupportedDevNode("23.11.0")).toThrow("CODEX_DEV_UNSUPPORTED_NODE:23.11.0")
  })

  it("requires the enabled development identity and rejects production", () => {
    const plugin = validatePluginIsolation({
      installed: [{
        enabled: true,
        installed: true,
        name: "pippit-video",
        pluginId: "pippit-video@pippit-bridge-dev",
        version: "0.2.17",
      }],
    })
    expect(plugin.version).toBe("0.2.17")

    expect(() => validatePluginIsolation({
      installed: [{
        enabled: true,
        installed: true,
        name: "pippit-video",
        pluginId: "pippit-video@pippit-bridge",
      }],
    })).toThrow("DEV_PROFILE_CONTAINS_RELEASE_PLUGIN")
  })

  it("finds only the ChatGPT process using the exact Dev browser profile", () => {
    const browserData = "/Users/dev/Library/Application Support/Codex Dev"
    const processes = [
      `101 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --user-data-dir=${browserData}`,
      "202 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      `303 /bin/zsh -c echo --user-data-dir=${browserData}`,
    ].join("\n")
    expect(findDevProcessIds(processes, browserData)).toEqual([101])
  })

  it("clears only the isolated development marketplace cache", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "pippit-codex-dev-profile-"))
    const devProfile = resolve(home, ".codex-profiles/dev")
    const devCache = resolveDevPluginCacheRoot(devProfile)
    const unrelatedCache = resolve(devProfile, "plugins/cache/openai-bundled/browser/1.0.0")
    await mkdir(resolve(devCache, "pippit-video/0.2.17"), { recursive: true })
    await mkdir(unrelatedCache, { recursive: true })
    await writeFile(resolve(devCache, "pippit-video/0.2.17/stale.txt"), "stale")
    await writeFile(resolve(unrelatedCache, "keep.txt"), "keep")

    await expect(clearDevPluginCache(devProfile)).resolves.toBe(true)
    await expect(readFile(resolve(unrelatedCache, "keep.txt"), "utf8")).resolves.toBe("keep")
    await expect(clearDevPluginCache(devProfile)).resolves.toBe(false)
  })

  it("refuses to follow a symlink at the development cache boundary", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "pippit-codex-dev-profile-"))
    const devProfile = resolve(home, ".codex-profiles/dev")
    const external = resolve(home, "external")
    await mkdir(resolve(devProfile, "plugins/cache"), { recursive: true })
    await mkdir(external)
    await symlink(external, resolveDevPluginCacheRoot(devProfile))

    await expect(clearDevPluginCache(devProfile)).rejects.toThrow("DEV_PLUGIN_CACHE_UNSAFE")
  })

  it("builds an isolated macOS launch without a workspace argument", () => {
    expect(buildMacLaunchArgs({
      appPath: "/Applications/ChatGPT.app",
      browserData: "/Users/dev/Library/Application Support/Codex Dev",
      nodePath: "/Users/dev/.nvm/versions/node/v24.15.0/bin/node",
      profileHome: "/Users/dev/.codex-profiles/dev",
    })).toEqual([
      "-na",
      "/Applications/ChatGPT.app",
      "--env",
      "CODEX_HOME=/Users/dev/.codex-profiles/dev",
      "--env",
      "PIPPIT_NODE_PATH=/Users/dev/.nvm/versions/node/v24.15.0/bin/node",
      "--args",
      "--user-data-dir=/Users/dev/Library/Application Support/Codex Dev",
    ])
  })
})
