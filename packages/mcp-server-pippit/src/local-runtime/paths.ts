import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { defaultPippitOutputDirectory } from "../options.ts"
import { PippitLocalRuntimeError, type PippitLocalRuntimePaths } from "./contracts.ts"

const CONFIG_FILE_NAME = "runtime-secrets.json"
const IDEMPOTENCY_SECRET_FILE_NAME = "secret-v1.json"
const IDEMPOTENCY_STORE_FILE_NAME = "mcp-v1.json"
const READY_FILE_NAME = "facade-ready.json"
const LOCK_FILE_NAME = "bootstrap.lock"

export function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

export function resolvePippitLocalRuntimePaths(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): PippitLocalRuntimePaths {
  const override = nonEmpty(env.PIPPIT_BRIDGE_HOME)
  let dataRoot: string
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new PippitLocalRuntimeError("invalid_data_root", "PIPPIT_BRIDGE_HOME must be an absolute path.")
    }
    dataRoot = resolve(override)
  } else if (platform === "darwin") {
    dataRoot = join(userHome, "Library", "Application Support", "Pippit Bridge")
  } else if (platform === "win32") {
    const localAppData = nonEmpty(env.LOCALAPPDATA)
    if (localAppData === undefined) {
      throw new PippitLocalRuntimeError("missing_data_root", "LOCALAPPDATA is required for local runtime setup.")
    }
    dataRoot = join(localAppData, "Pippit Bridge")
  } else {
    dataRoot = join(nonEmpty(env.XDG_DATA_HOME) ?? join(userHome, ".local", "share"), "pippit-bridge")
  }
  if (!isAbsolute(dataRoot)) {
    throw new PippitLocalRuntimeError("invalid_data_root", "The Pippit local runtime data root must be absolute.")
  }
  const byokDirectory = join(dataRoot, "byok")
  const configuredOutputRoot = nonEmpty(env.PIPPIT_MCP_OUTPUT_ROOT)
  const outputRoot = configuredOutputRoot !== undefined
    ? resolve(configuredOutputRoot)
    : override !== undefined
      ? join(dataRoot, "outputs")
      : defaultPippitOutputDirectory(userHome, platform)
  return {
    bootstrapLockPath: join(dataRoot, LOCK_FILE_NAME),
    byokDirectory,
    byokStorePath: join(byokDirectory, "credentials.json"),
    configPath: join(dataRoot, CONFIG_FILE_NAME),
    dataRoot,
    idempotencyDirectory: join(dataRoot, "idempotency"),
    idempotencySecretPath: join(dataRoot, "idempotency", IDEMPOTENCY_SECRET_FILE_NAME),
    idempotencyStorePath: join(dataRoot, "idempotency", IDEMPOTENCY_STORE_FILE_NAME),
    outputRoot,
    readyPath: join(dataRoot, READY_FILE_NAME),
  }
}
