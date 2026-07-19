import { createChatGptHttpServer } from "./http.js"
import { resolveChatGptAppConfig } from "./config.js"

const config = await resolveChatGptAppConfig()
const server = createChatGptHttpServer({ config })
let shuttingDown = false

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return
  shuttingDown = true
  console.info(`Shutting down @pippit-bridge/chatgpt-app after ${signal}.`)
  server.close((error) => {
    if (error !== undefined) {
      console.error(error)
      process.exitCode = 1
    }
  })
}

process.once("SIGINT", () => shutdown("SIGINT"))
process.once("SIGTERM", () => shutdown("SIGTERM"))

server.listen(config.port, config.host, () => {
  console.info(`@pippit-bridge/chatgpt-app listening at http://${config.host}:${config.port}/mcp`)
})
