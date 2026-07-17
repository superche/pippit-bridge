import { describe, expect, it } from "vitest"
import { createJobId, parseJobId } from "../src/jobs/job-token.js"

describe("job token", () => {
  const signingKey = "b".repeat(64)
  const payload = {
    created_at: 1_700_000_000_000,
    credential_id: "11111111-1111-4111-8111-111111111111",
    credential_version_id: "22222222-2222-4222-8222-222222222222",
    model: "pippit/seedance-2.0",
    run_id: "run-1",
    thread_id: "thread-1",
    workspace_id: "33333333-3333-4333-8333-333333333333",
  }

  it("keeps the Pippit thread and run handles distinct", () => {
    const jobId = createJobId(payload, "facade-one", signingKey)

    expect(jobId).toMatch(/^pippit_job_v2\./)
    expect(parseJobId(jobId, "facade-one", signingKey)).toMatchObject({ ...payload, version: 2 })
  })

  it("binds a job to the same facade API key", () => {
    const jobId = createJobId(payload, "facade-one", signingKey)

    expect(() => parseJobId(jobId, "facade-two", signingKey)).toThrowError(
      expect.objectContaining({ code: "video_job_not_found", statusCode: 404 }),
    )
  })

  it("rejects a modified payload", () => {
    const jobId = createJobId(payload, "facade-one", signingKey)
    const parts = jobId.split(".")
    const modified = `${parts[0]}.${parts[1]}x.${parts[2]}`

    expect(() => parseJobId(modified, "facade-one", signingKey)).toThrowError(
      expect.objectContaining({ code: "video_job_not_found" }),
    )
  })

  it("rejects a token signed by another server key", () => {
    const jobId = createJobId(payload, "facade-one", signingKey)

    expect(() => parseJobId(jobId, "facade-one", "c".repeat(64))).toThrowError(
      expect.objectContaining({ code: "video_job_not_found" }),
    )
  })
})
