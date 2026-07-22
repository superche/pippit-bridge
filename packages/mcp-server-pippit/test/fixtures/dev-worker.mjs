import { createInterface } from "node:readline"

const label = process.env.DEV_WORKER_LABEL ?? "worker"
const description = process.env.DEV_WORKER_CONTRACT_VARIANT === "cold" ? "Cold changed echo" : "Frozen echo"
const tool = {
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true, title: "Echo" },
  description,
  inputSchema: { additionalProperties: false, properties: { crash: { type: "boolean" }, delay_ms: { type: "integer" }, value: { type: "string" } }, type: "object" },
  name: "fixture_echo",
  outputSchema: { additionalProperties: false, properties: { generation: { type: "string" }, value: { type: "string" } }, required: ["generation", "value"], type: "object" },
  title: "Echo",
}

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.method === "initialize") {
    process.stdout.write(`${JSON.stringify({ id: request.id, jsonrpc: "2.0", result: { capabilities: { resources: { listChanged: false }, tools: { listChanged: false } }, protocolVersion: "2025-11-25", serverInfo: { name: "fixture", version: "1" } } })}\n`)
  } else if (request.method === "tools/list") {
    process.stdout.write(`${JSON.stringify({ id: request.id, jsonrpc: "2.0", result: { tools: [tool] } })}\n`)
  } else if (request.method === "resources/list") {
    process.stdout.write(`${JSON.stringify({ id: request.id, jsonrpc: "2.0", result: { resources: [{ mimeType: "text/plain", name: "Fixture", uri: "fixture://status" }] } })}\n`)
  } else if (request.method === "resources/templates/list") {
    process.stdout.write(`${JSON.stringify({ id: request.id, jsonrpc: "2.0", result: { resourceTemplates: [{ mimeType: "text/plain", name: "Artifact", uriTemplate: "fixture://artifact/{id}" }] } })}\n`)
  } else if (request.method === "resources/read") {
    const uri = request.params.uri
    process.stdout.write(`${JSON.stringify({ id: request.id, jsonrpc: "2.0", result: { contents: [{ mimeType: "text/plain", text: uri === "fixture://status" ? "static" : label, uri }] } })}\n`)
  } else if (request.method === "tools/call") {
    if (request.params.arguments?.crash) process.exit(91)
    const delay = request.params.arguments?.delay_ms ?? 0
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
    const structuredContent = { generation: label, value: request.params.arguments?.value ?? "" }
    process.stdout.write(`${JSON.stringify({ id: request.id, jsonrpc: "2.0", result: { content: [{ text: JSON.stringify(structuredContent), type: "text" }], structuredContent } })}\n`)
  }
}
