import { describe, expect, it } from "vitest"

import {
  buildMacLaunchArgs,
  findDevProcessIds,
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

  it("requires the enabled development identity and rejects production", () => {
    const plugin = validatePluginIsolation({
      installed: [{
        enabled: true,
        installed: true,
        name: "pippit-video",
        pluginId: "pippit-video@pippit-bridge-dev",
        version: "0.2.16",
      }],
    })
    expect(plugin.version).toBe("0.2.16")

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

  it("builds an isolated macOS launch without a workspace argument", () => {
    expect(buildMacLaunchArgs({
      appPath: "/Applications/ChatGPT.app",
      browserData: "/Users/dev/Library/Application Support/Codex Dev",
      profileHome: "/Users/dev/.codex-profiles/dev",
    })).toEqual([
      "-na",
      "/Applications/ChatGPT.app",
      "--env",
      "CODEX_HOME=/Users/dev/.codex-profiles/dev",
      "--args",
      "--user-data-dir=/Users/dev/Library/Application Support/Codex Dev",
    ])
  })
})
