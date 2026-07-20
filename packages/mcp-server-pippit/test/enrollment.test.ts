import { describe, expect, it, vi } from "vitest"
import { createPippitAccessKeyEnrollmentServer } from "../src/enrollment.ts"

function managementBackend() {
  return {
    addAccessKey: vi.fn(async ({ accountName }: { readonly accessKey: string; readonly accountName: string }) => ({
      account_name: accountName,
      active: false,
      credential_id: "cred-1",
      disabled: false,
      label: "ak-****cret",
    })),
    switchAccessKey: vi.fn(async (credentialId: string) => ({
      active: true as const,
      credential_id: credentialId,
      updated_at: "2026-07-18T00:00:00.000Z",
    })),
  }
}

describe("Pippit loopback Access Key enrollment", () => {
  it("serves a password form, stores and activates once, and never echoes the raw key", async () => {
    const managementClient = managementBackend()
    const server = createPippitAccessKeyEnrollmentServer({ managementClient })
    try {
      const enrollment = await server.createEnrollment("work <account>")
      const token = new URL(enrollment.enrollment_url).pathname.split("/").at(-1) as string
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u)

      const form = await fetch(enrollment.enrollment_url)
      const formBody = await form.text()
      expect(form.status).toBe(200)
      expect(form.headers.get("cache-control")).toBe("no-store")
      expect(form.headers.get("content-security-policy")).toContain("form-action 'self'")
      expect(form.headers.get("referrer-policy")).toBe("strict-origin")
      expect(formBody).toContain('type="password"')
      expect(formBody).toContain("work &lt;account&gt;")
      expect(formBody).toContain("连接 Pippit")
      expect(formBody).toContain("打开获取与配置指南")
      expect(formBody).toContain(
        'href="https://bytedance.larkoffice.com/docx/CQOYdJNLioLz6fxRzKXcCsKLnJh"',
      )
      expect(formBody).toContain('target="_blank"')
      expect(formBody).toContain('rel="noopener noreferrer"')
      expect(formBody).toContain('referrerpolicy="no-referrer"')
      expect(formBody).not.toContain(token)

      const submitted = await fetch(enrollment.enrollment_url, {
        body: new URLSearchParams({ access_key: "pippit-super-secret" }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: new URL(enrollment.enrollment_url).origin,
          "sec-fetch-site": "same-origin",
        },
        method: "POST",
      })
      const submittedBody = await submitted.text()
      expect(submitted.status).toBe(200)
      expect(submittedBody).toContain("已保存并启用")
      expect(submittedBody).not.toContain("pippit-super-secret")
      expect(managementClient.addAccessKey).toHaveBeenCalledWith({
        accessKey: "pippit-super-secret",
        accountName: "work <account>",
      })
      expect(managementClient.switchAccessKey).toHaveBeenCalledWith("cred-1")

      const replay = await fetch(enrollment.enrollment_url, {
        body: new URLSearchParams({ access_key: "another-secret" }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      })
      expect(replay.status).toBe(410)
      expect(managementClient.addAccessKey).toHaveBeenCalledTimes(1)
    } finally {
      await server.close()
    }
  })

  it("rejects null and foreign origins without consuming the one-time enrollment link", async () => {
    const managementClient = managementBackend()
    const server = createPippitAccessKeyEnrollmentServer({ managementClient })
    try {
      const enrollment = await server.createEnrollment("origin protected")
      const submit = (origin: string) => fetch(enrollment.enrollment_url, {
        body: new URLSearchParams({ access_key: "pippit-super-secret" }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
        },
        method: "POST",
      })

      for (const origin of ["null", "https://attacker.example.test"]) {
        const rejected = await submit(origin)
        expect(rejected.status).toBe(403)
        await expect(rejected.text()).resolves.toContain("请求来源校验失败")
      }
      expect(managementClient.addAccessKey).not.toHaveBeenCalled()

      const accepted = await submit(new URL(enrollment.enrollment_url).origin)
      expect(accepted.status).toBe(200)
      expect(managementClient.addAccessKey).toHaveBeenCalledOnce()
      expect(managementClient.switchAccessKey).toHaveBeenCalledOnce()
    } finally {
      await server.close()
    }
  })

  it("expires enrollment links before accepting a key", async () => {
    const managementClient = managementBackend()
    let now = Date.parse("2026-07-18T00:00:00.000Z")
    const server = createPippitAccessKeyEnrollmentServer({
      managementClient,
      now: () => now,
      ttlMs: 100,
    })
    try {
      const enrollment = await server.createEnrollment("expired")
      now += 100
      const response = await fetch(enrollment.enrollment_url)
      expect(response.status).toBe(410)
      expect(managementClient.addAccessKey).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it("removes every expired session before enforcing the session limit", async () => {
    const managementClient = managementBackend()
    let now = Date.parse("2026-07-18T00:00:00.000Z")
    const tokens = ["a".repeat(32), "b".repeat(32), "e".repeat(32), "f".repeat(32)]
    const server = createPippitAccessKeyEnrollmentServer({
      managementClient,
      maxSessions: 2,
      now: () => now,
      tokenFactory: () => tokens.shift() as string,
      ttlMs: 100,
    })
    try {
      const firstExpired = await server.createEnrollment("first expired account")
      const secondExpired = await server.createEnrollment("second expired account")
      now += 100
      const firstCurrent = await server.createEnrollment("first current account")
      const secondCurrent = await server.createEnrollment("second current account")

      await expect(fetch(firstExpired.enrollment_url)).resolves.toMatchObject({ status: 410 })
      await expect(fetch(secondExpired.enrollment_url)).resolves.toMatchObject({ status: 410 })
      await expect(fetch(firstCurrent.enrollment_url)).resolves.toMatchObject({ status: 200 })
      await expect(fetch(secondCurrent.enrollment_url)).resolves.toMatchObject({ status: 200 })
    } finally {
      await server.close()
    }
  })

  it("fails closed at capacity without replacing live sessions or exposing sensitive values", async () => {
    const managementClient = managementBackend()
    const firstToken = "c".repeat(32)
    const secondToken = "d".repeat(32)
    const tokens = [firstToken, secondToken]
    const server = createPippitAccessKeyEnrollmentServer({
      managementClient,
      maxSessions: 2,
      tokenFactory: () => tokens.shift() as string,
    })
    try {
      const first = await server.createEnrollment("first private account")
      const second = await server.createEnrollment("second private account")
      const error = await server.createEnrollment("rejected private account").catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(
        "Enrollment session capacity reached. Try again after an existing link expires.",
      )
      expect((error as Error).message).not.toContain(firstToken)
      expect((error as Error).message).not.toContain(secondToken)
      expect((error as Error).message).not.toContain("rejected private account")
      expect((error as Error).message).not.toContain("pippit-secret-access-key")
      await expect(fetch(first.enrollment_url)).resolves.toMatchObject({ status: 200 })
      await expect(fetch(second.enrollment_url)).resolves.toMatchObject({ status: 200 })
    } finally {
      await server.close()
    }
  })

  it.each([0, 1025, 1.5])("rejects an invalid maximum session count of %s", (maxSessions) => {
    expect(() => createPippitAccessKeyEnrollmentServer({ managementClient: managementBackend(), maxSessions })).toThrow(
      "Enrollment session limit must be an integer from 1 to 1024.",
    )
  })

  it("rejects oversized POST bodies and consumes the token", async () => {
    const managementClient = managementBackend()
    const server = createPippitAccessKeyEnrollmentServer({ bodyLimitBytes: 64, managementClient })
    try {
      const enrollment = await server.createEnrollment("limit")
      const response = await fetch(enrollment.enrollment_url, {
        body: new URLSearchParams({ access_key: "x".repeat(256) }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      })
      expect(response.status).toBe(413)
      expect(managementClient.addAccessKey).not.toHaveBeenCalled()
      await expect(fetch(enrollment.enrollment_url)).resolves.toMatchObject({ status: 410 })
    } finally {
      await server.close()
    }
  })
})
