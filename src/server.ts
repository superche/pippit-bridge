import { buildApp } from "./app.js"
import { loadConfig } from "./config.js"

const config = loadConfig()
const app = buildApp({ config, logger: true })
let shuttingDown = false

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  app.log.info({ signal }, "Shutting down the provider")
  try {
    await app.close()
  } catch (error) {
    app.log.error(error)
    process.exitCode = 1
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"))
process.once("SIGTERM", () => void shutdown("SIGTERM"))

try {
  await app.listen({ host: config.HOST, port: config.PORT })
} catch (error) {
  app.log.error(error)
  await app.close().catch((closeError: unknown) => app.log.error(closeError))
  process.exitCode = 1
}
