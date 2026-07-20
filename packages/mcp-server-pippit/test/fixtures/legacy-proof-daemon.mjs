import { createHmac } from "node:crypto"
import { createServer } from "node:http"

const instanceId = process.env.PIPPIT_TEST_INSTANCE_ID
const proofKeyHex = process.env.PIPPIT_TEST_PROOF_KEY_HEX
const runtimeVersion = process.env.PIPPIT_TEST_RUNTIME_VERSION
const responsePidValue = process.env.PIPPIT_TEST_RESPONSE_PID

if (!instanceId || !proofKeyHex || !runtimeVersion) {
  throw new Error("Legacy proof daemon test configuration is incomplete.")
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  const challenge = url.searchParams.get("challenge")
  if (url.pathname !== "/.well-known/pippit-bridge-local-runtime" || challenge === null) {
    response.statusCode = 404
    response.end()
    return
  }
  const proof = createHmac("sha256", Buffer.from(proofKeyHex, "hex"))
    .update(`pippit-local-runtime\nv1\n${instanceId}\n${challenge}`, "utf8")
    .digest("hex")
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify({
    instance_id: instanceId,
    ...(responsePidValue === undefined
      ? {}
      : { pid: responsePidValue === "self" ? process.pid : Number(responsePidValue) }),
    proof,
    runtime_version: runtimeVersion,
  }))
})

async function shutdown() {
  await new Promise((resolveClose) => server.close(resolveClose))
}

process.once("SIGINT", () => void shutdown())
process.once("SIGTERM", () => void shutdown())

server.listen(0, "127.0.0.1", () => {
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Legacy proof daemon did not bind TCP.")
  process.stdout.write(`${JSON.stringify({ pid: process.pid, port: address.port })}\n`)
})
