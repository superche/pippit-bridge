import type { PippitApi, PippitVideoResult } from "@pippit-bridge/sdk"
import type { AuthenticatedApiKey } from "../../auth.js"
import type { ByokStore } from "../../byok/index.js"
import type { AppConfig } from "../../config.js"
import { ApiError } from "../../errors.js"
import { parseJobId, type JobTokenPayload } from "../../jobs/job-token.js"

export interface QueriedJob {
  readonly accessKey: string
  readonly payload: JobTokenPayload
  readonly result: PippitVideoResult
}

export function createJobQueryService(input: {
  readonly byokStore: ByokStore
  readonly config: Pick<AppConfig, "JOB_SIGNING_KEY_HEX">
  readonly pippit: PippitApi
}): (caller: AuthenticatedApiKey, jobId: string, signal: AbortSignal) => Promise<QueriedJob> {
  return async (caller, jobId, signal) => {
    const payload = parseJobId(jobId, caller.apiKey, input.config.JOB_SIGNING_KEY_HEX)
    const credential = await input.byokStore.getVersion(payload.credential_id, payload.credential_version_id)
    if (credential === undefined || credential.credential.workspace_id !== payload.workspace_id) {
      throw new ApiError("The BYOK credential version required by this video job is unavailable.", {
        code: "byok_credential_unavailable",
        param: "job_id",
        statusCode: 409,
        type: "api_error",
      })
    }
    const result = await input.pippit.queryVideoResult({
      accessKey: credential.accessKey,
      runId: payload.run_id,
      signal,
      threadId: payload.thread_id,
    })
    return { accessKey: credential.accessKey, payload, result }
  }
}
