import { describe, expect, it, vi } from "vitest"
import {
  PippitFacadeClient,
  PippitFacadeError,
  PippitFacadeManagementClient,
} from "../src/client.ts"

const job = { id: "job-1", polling_url: "/api/v1/videos/job-1", status: "pending" }

describe("PippitFacadeClient", () => {
  it("accepts a 12-hour timeout and rejects a longer configured deadline", () => {
    expect(() => new PippitFacadeClient({
      apiKey: "facade-key",
      baseUrl: "https://bridge.example.test",
      timeoutMs: 43_200_000,
    })).not.toThrow()
    expect(() => new PippitFacadeClient({
      apiKey: "facade-key",
      baseUrl: "https://bridge.example.test",
      timeoutMs: 43_200_001,
    })).toThrow(/43200000/u)
  })

  it("authenticates only to the facade and parses a submitted job", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer facade-key")
      return new Response(JSON.stringify(job), { status: 202 })
    })
    const client = new PippitFacadeClient({ apiKey: "facade-key", baseUrl: "https://bridge.example.test", fetchImpl })
    await expect(client.generateVideo({ model: "pippit/seedance-2.0", prompt: "A comet" })).resolves.toMatchObject(job)
  })

  it("submits video edits only through the runtime route and bearer", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://bridge.example.test/api/v1/videos/edits")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer runtime-key")
      expect(JSON.parse(String(init?.body))).toMatchObject({
        annotations: [{ at_ms: 1500, instruction: "Make it black", region: { height: 0.4, width: 0.3, x: 0.1, y: 0.2 } }],
        source_index: 0,
        source_job_id: "source-1",
      })
      return new Response(JSON.stringify(job), { status: 202 })
    })
    const client = new PippitFacadeClient({ apiKey: "runtime-key", baseUrl: "https://bridge.example.test", fetchImpl })
    await expect(client.editVideo({
      annotations: [{ at_ms: 1500, instruction: "Make it black", region: { height: 0.4, width: 0.3, x: 0.1, y: 0.2 } }],
      model: "pippit/seedance-2.0",
      segment: { end_ms: 3000, start_ms: 1000 },
      source_index: 0,
      source_job_id: "source-1",
    })).resolves.toMatchObject(job)
  })

  it("forwards one validated byte range", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=10-99")
      return new Response(new Uint8Array([1]), { status: 206 })
    })
    const client = new PippitFacadeClient({ apiKey: "facade-key", baseUrl: "https://bridge.example.test", fetchImpl })
    await expect(client.downloadVideo("job-1", { range: "bytes=10-99" })).resolves.toBeInstanceOf(Response)
    await expect(client.downloadVideo("job-1", { range: "items=1-2" })).rejects.toMatchObject({ code: "INVALID_INPUT" })
  })

  it("returns safe HTTP errors without response bodies or credentials", async () => {
    const client = new PippitFacadeClient({
      apiKey: "facade-secret",
      baseUrl: "https://bridge.example.test",
      fetchImpl: async () => new Response('{"error":{"message":"facade-secret leaked"}}', { status: 401 }),
    })
    const error = await client.getVideo("job-1").catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PippitFacadeError)
    expect(String(error)).not.toContain("facade-secret")
  })

  it("cancels an undeclared oversized JSON response before buffering the full body", async () => {
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
      pull(controller) {
        pulls += 1
        if (pulls > 10) controller.close()
        else controller.enqueue(new Uint8Array(1024 * 1024))
      },
    })
    const client = new PippitFacadeClient({
      apiKey: "facade-key",
      baseUrl: "https://bridge.example.test",
      fetchImpl: async () => new Response(body),
    })
    await expect(client.listVideoModels()).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(10)
  })
})

describe("PippitFacadeManagementClient", () => {
  const facadeApiKeyHash = "a".repeat(64)

  it("uses only the management bearer and strips caller hashes and key material", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer management-key")
      if (url.includes("/active?")) {
        expect(url).toContain(`facade_api_key_hash=${facadeApiKeyHash}`)
        return new Response(JSON.stringify({
          data: { credential_id: "cred-1", facade_api_key_hash: facadeApiKeyHash, updated_at: "2026-07-18T00:00:00.000Z" },
        }))
      }
      expect(url).toBe(
        `https://bridge.example.test/api/v1/byok?limit=100&offset=0&provider=pippit&facade_api_key_hash=${facadeApiKeyHash}`,
      )
      return new Response(JSON.stringify({
        data: [{
          allowed_api_key_hashes: [facadeApiKeyHash],
          disabled: false,
          fingerprint: "must-not-leak",
          id: "cred-1",
          key: "raw-key-must-not-leak",
          label: "ak-****cret",
          name: "work",
        }],
        total_count: 1,
      }))
    })
    const client = new PippitFacadeManagementClient({
      baseUrl: "https://bridge.example.test",
      facadeApiKeyHash,
      fetchImpl,
      managementApiKey: "management-key",
    })
    const listed = await client.listAccessKeys()
    expect(listed).toEqual({
      data: [{ account_name: "work", active: true, credential_id: "cred-1", disabled: false, label: "ak-****cret" }],
      total_count: 1,
    })
    expect(JSON.stringify(listed)).not.toContain(facadeApiKeyHash)
    expect(JSON.stringify(listed)).not.toContain("must-not-leak")
  })

  it("creates, switches, and deletes without returning the submitted Access Key or caller hash", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer management-key")
      if (url.endsWith("/api/v1/byok") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          allowed_api_key_hashes: [facadeApiKeyHash],
          key: "pippit-secret",
          name: "personal",
          provider: "pippit",
        })
        return new Response(JSON.stringify({
          data: { disabled: false, id: "cred-2", label: "ak-****cret", name: "personal" },
        }), { status: 201 })
      }
      if (url.endsWith("/api/v1/byok/active")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          credential_id: "cred-2",
          facade_api_key_hash: facadeApiKeyHash,
        })
        return new Response(JSON.stringify({
          data: { credential_id: "cred-2", facade_api_key_hash: facadeApiKeyHash, updated_at: "2026-07-18T00:00:00.000Z" },
        }))
      }
      expect(url).toBe(
        `https://bridge.example.test/api/v1/byok/cred-2?facade_api_key_hash=${facadeApiKeyHash}`,
      )
      expect(init?.method).toBe("DELETE")
      return new Response(JSON.stringify({ deleted: true }))
    })
    const client = new PippitFacadeManagementClient({
      baseUrl: "https://bridge.example.test",
      facadeApiKeyHash,
      fetchImpl,
      managementApiKey: "management-key",
    })
    const created = await client.addAccessKey({ accessKey: "pippit-secret", accountName: "personal" })
    const selected = await client.switchAccessKey(created.credential_id)
    const deleted = await client.deleteAccessKey(created.credential_id)
    const output = JSON.stringify({ created, deleted, selected })
    expect(output).not.toContain("pippit-secret")
    expect(output).not.toContain(facadeApiKeyHash)
  })

  it("keeps management credentials and rejected response bodies out of errors", async () => {
    const client = new PippitFacadeManagementClient({
      baseUrl: "https://bridge.example.test",
      facadeApiKeyHash,
      fetchImpl: async () => new Response("management-secret pippit-secret", { status: 401 }),
      managementApiKey: "management-secret",
    })
    const error = await client.deleteAccessKey("cred-1").catch((caught: unknown) => caught)
    expect(String(error)).not.toContain("management-secret")
    expect(String(error)).not.toContain("pippit-secret")
  })
})
