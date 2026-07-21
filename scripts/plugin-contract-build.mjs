import { spawnSync } from "node:child_process"

function githubError(title, message) {
  if (process.env.GITHUB_ACTIONS !== "true") return
  const escapedTitle = title.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")
  const escapedMessage = message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")
  process.stdout.write(`::error title=${escapedTitle}::${escapedMessage}\n`)
}

const npmCli = process.env.npm_execpath
if (npmCli === undefined || npmCli.trim() === "") {
  throw new Error("npm_execpath is required to build the plugin contract.")
}

for (const workspace of ["@pippit-bridge/core", "@pippit-bridge/sdk", "@pippit-bridge/mcp-server"]) {
  const result = spawnSync(process.execPath, [npmCli, "run", "build", "-w", workspace], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  })
  process.stdout.write(result.stdout ?? "")
  process.stderr.write(result.stderr ?? "")
  if (result.error !== undefined || result.status !== 0) {
    const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim()
    const detail = output.slice(-3_000) || result.error?.message || `exit=${result.status} signal=${result.signal}`
    githubError(`Plugin contract build failed: ${workspace}`, detail)
    process.exit(result.status ?? 1)
  }
}
