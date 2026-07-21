import { request } from "node:http"
import { describe, expect, test } from "vitest"
import { assertWidgetBehaviorCompatible, authorizeDevWidgetRequest, createDevWidgetAssetServer, renderDevWidgetShell } from "../src/dev-widget.ts"

const fixtures = [{ confirmation: "required", input: { prompt: "fixture" }, toolName: "pippit_generate_video" }] as const

describe("dev widget cold-contract boundary", () => {
  test("accepts presentation-only changes with identical payload fixtures", () => {
    expect(() => assertWidgetBehaviorCompatible(fixtures, structuredClone(fixtures))).not.toThrow()
  })

  test("rejects tool mapping or confirmation changes", () => {
    expect(() => assertWidgetBehaviorCompatible(fixtures, [{ ...fixtures[0], confirmation: "none" }])).toThrow("DEV_CONTRACT_MISMATCH")
  })

  test("requires exact loopback host, origin, and capability", () => {
    const valid = { capability: "secret", expectedCapability: "secret", expectedHost: "127.0.0.1:43119", host: "127.0.0.1:43119", origin: "http://127.0.0.1:43119" }
    expect(authorizeDevWidgetRequest(valid)).toBe(true)
    expect(authorizeDevWidgetRequest({ ...valid, host: "localhost:43119" })).toBe(false)
    expect(authorizeDevWidgetRequest({ ...valid, capability: "wrong!" })).toBe(false)
  })

  test("shell keeps one fixed root and protected asset channel", () => {
    const shell = renderDevWidgetShell({ assetOrigin: "http://127.0.0.1:43119", capability: "secret" })
    expect(shell).toContain("EventSource")
    expect(shell).toContain("capability")
  })

  test("serves assets only over protected loopback requests", async () => {
    const server = await createDevWidgetAssetServer({ capability: "secret", port: 0, readAsset: async () => "export const generation = 2" })
    const get = (capability: string, origin = server.origin) => new Promise<{ body: string; status: number }>((resolveRequest, reject) => {
      const url = new URL(`/widget.js?capability=${capability}`, server.origin)
      const outgoing = request(url, { headers: { origin } }, response => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", chunk => { body += chunk })
        response.on("end", () => resolveRequest({ body, status: response.statusCode ?? 0 }))
      })
      outgoing.once("error", reject)
      outgoing.end()
    })
    try {
      expect(await get("secret")).toEqual({ body: "export const generation = 2", status: 200 })
      expect((await get("wrong!")).status).toBe(403)
      expect((await get("secret", "http://attacker.invalid")).status).toBe(403)
    } finally {
      await server.close()
    }
  })
})
