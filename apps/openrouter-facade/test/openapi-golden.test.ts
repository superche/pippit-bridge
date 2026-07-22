import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { OPENAPI_DOCUMENT } from "../src/openapi.js"

const goldenPath = new URL("../contracts/openapi.golden.json", import.meta.url)

describe("OpenAPI characterization", () => {
  it("matches the complete canonical OpenAPI document", async () => {
    const golden = JSON.parse(await readFile(goldenPath, "utf8")) as unknown
    expect(OPENAPI_DOCUMENT).toEqual(golden)
  })

  it("keeps every published operation id unique", () => {
    const operationIds: string[] = []
    for (const pathItem of Object.values(OPENAPI_DOCUMENT.paths)) {
      for (const operation of Object.values(pathItem)) {
        if (typeof operation === "object" && operation !== null && "operationId" in operation) {
          operationIds.push(String(operation.operationId))
        }
      }
    }
    expect(new Set(operationIds).size).toBe(operationIds.length)
  })
})
