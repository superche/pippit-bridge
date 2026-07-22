import {
  type PippitAccessKeyList,
  type PippitAccessKeyCredential,
  type PippitAccessKeySelection,
  type PippitFacadeClientOptions,
  type PippitFacadeFetch,
  type PippitFacadeManagementClientOptions,
  type PippitFacadeOperation,
  type PippitImageGenerateRequest,
  type PippitImageGenerationResponse,
  type PippitImageModelList,
  type PippitVideoGenerateRequest,
  type PippitVideoEditRequest,
  type PippitVideoGenerationJob,
  type PippitVideoDownloadOptions,
  type PippitVideoModelList,
} from "./contracts.ts"
import {
  invalidResponse,
  isRecord,
  MAX_IMAGE_JSON_RESPONSE_BYTES,
  normalizeApiKey,
  normalizeBaseUrl,
  normalizeJobId,
  normalizePrintableInput,
  normalizeRange,
  normalizeTimeout,
  parseAccessKeyCredential,
  parseAccessKeySelection,
  parseImageModel,
  parseImageResponse,
  parseJob,
  parseVideoModel,
  PippitFacadeError,
  readJson,
  requestWithBearer,
  serializeJson,
} from "./client-support.ts"

export { PippitFacadeError } from "./client-support.ts"

export class PippitFacadeClient {
  readonly #apiKey: string
  readonly #baseUrl: string
  readonly #fetchImpl: PippitFacadeFetch
  readonly #timeoutMs: number

  constructor(options: PippitFacadeClientOptions) {
    this.#apiKey = normalizeApiKey(options.apiKey)
    this.#baseUrl = normalizeBaseUrl(options.baseUrl)
    this.#fetchImpl = options.fetchImpl ?? fetch
    this.#timeoutMs = normalizeTimeout(options.timeoutMs)
  }

  async listImageModels(signal?: AbortSignal): Promise<PippitImageModelList> {
    const operation = "list_image_models"
    const response = await this.#request("/api/v1/images/models", { method: "GET" }, operation, signal)
    const body = await readJson(response, operation)
    if (!isRecord(body) || !Array.isArray(body.data)) throw invalidResponse(operation)
    return { data: body.data.map((item) => parseImageModel(item, operation)) }
  }

  async generateImage(
    input: PippitImageGenerateRequest,
    signal?: AbortSignal,
  ): Promise<PippitImageGenerationResponse> {
    const operation = "generate_image"
    const response = await this.#request(
      "/api/v1/images",
      { body: serializeJson(input, operation), headers: { "content-type": "application/json" }, method: "POST" },
      operation,
      signal,
    )
    return parseImageResponse(await readJson(response, operation, MAX_IMAGE_JSON_RESPONSE_BYTES), operation)
  }

  async listVideoModels(signal?: AbortSignal): Promise<PippitVideoModelList> {
    const operation = "list_video_models"
    const response = await this.#request("/api/v1/videos/models", { method: "GET" }, operation, signal)
    const body = await readJson(response, operation)
    if (!isRecord(body) || !Array.isArray(body.data)) throw invalidResponse(operation)
    return { data: body.data.map((item) => parseVideoModel(item, operation)) }
  }

  async generateVideo(
    input: PippitVideoGenerateRequest,
    signal?: AbortSignal,
  ): Promise<PippitVideoGenerationJob> {
    const operation = "generate_video"
    const response = await this.#request(
      "/api/v1/videos",
      { body: serializeJson(input, operation), headers: { "content-type": "application/json" }, method: "POST" },
      operation,
      signal,
    )
    return parseJob(await readJson(response, operation), operation)
  }

  async editVideo(
    input: PippitVideoEditRequest,
    signal?: AbortSignal,
  ): Promise<PippitVideoGenerationJob> {
    const operation = "edit_video_segment"
    const response = await this.#request(
      "/api/v1/videos/edits",
      {
        body: serializeJson(input, operation),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      operation,
      signal,
    )
    return parseJob(await readJson(response, operation), operation)
  }

  async getVideo(jobId: string, signal?: AbortSignal): Promise<PippitVideoGenerationJob> {
    const operation = "get_video"
    const id = normalizeJobId(jobId, operation)
    const response = await this.#request(
      `/api/v1/videos/${encodeURIComponent(id)}`,
      { method: "GET" },
      operation,
      signal,
    )
    return parseJob(await readJson(response, operation), operation)
  }

  async downloadVideo(jobId: string, options: PippitVideoDownloadOptions = {}): Promise<Response> {
    const operation = "download_video"
    const id = normalizeJobId(jobId, operation)
    const index = options.index ?? 0
    if (!Number.isSafeInteger(index) || index < 0 || index > 1_000) {
      throw new PippitFacadeError({
        code: "INVALID_INPUT",
        message: "index must be an integer from 0 to 1000.",
        operation,
      })
    }
    const range = normalizeRange(options.range, operation)
    return this.#request(
      `/api/v1/videos/${encodeURIComponent(id)}/content?index=${index}`,
      {
        headers: {
          accept: "video/*,application/octet-stream",
          ...(range === undefined ? {} : { range }),
        },
        method: "GET",
      },
      operation,
      options.signal,
    )
  }

  async #request(
    path: string,
    init: RequestInit,
    operation: PippitFacadeOperation,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    return requestWithBearer({
      apiKey: this.#apiKey,
      baseUrl: this.#baseUrl,
      fetchImpl: this.#fetchImpl,
      init,
      operation,
      path,
      signal,
      timeoutMs: this.#timeoutMs,
    })
  }
}

/**
 * Management-plane client. This class deliberately cannot call runtime video routes,
 * and PippitFacadeClient deliberately cannot call BYOK routes.
 */
export class PippitFacadeManagementClient {
  readonly #baseUrl: string
  readonly #facadeApiKeyHash: string
  readonly #fetchImpl: PippitFacadeFetch
  readonly #managementApiKey: string
  readonly #timeoutMs: number

  constructor(options: PippitFacadeManagementClientOptions) {
    const operation = "list_access_keys"
    this.#managementApiKey = normalizeApiKey(
      options.managementApiKey,
      operation,
      "Pippit facade Management API key",
    )
    this.#baseUrl = normalizeBaseUrl(options.baseUrl, operation)
    if (!/^[a-f0-9]{64}$/u.test(options.facadeApiKeyHash)) {
      throw new PippitFacadeError({
        code: "INVALID_CONFIGURATION",
        message: "Facade caller identity must be a lowercase SHA-256 hash.",
        operation,
      })
    }
    this.#facadeApiKeyHash = options.facadeApiKeyHash
    this.#fetchImpl = options.fetchImpl ?? fetch
    this.#timeoutMs = normalizeTimeout(options.timeoutMs, operation)
  }

  async listAccessKeys(signal?: AbortSignal): Promise<PippitAccessKeyList> {
    const operation = "list_access_keys"
    const [listResponse, activeResponse] = await Promise.all([
      this.#request(
        `/api/v1/byok?limit=100&offset=0&provider=pippit&facade_api_key_hash=${encodeURIComponent(this.#facadeApiKeyHash)}`,
        { method: "GET" },
        operation,
        signal,
      ),
      this.#request(
        `/api/v1/byok/active?facade_api_key_hash=${encodeURIComponent(this.#facadeApiKeyHash)}`,
        { method: "GET" },
        operation,
        signal,
      ),
    ])
    const [listBody, activeBody] = await Promise.all([
      readJson(listResponse, operation),
      readJson(activeResponse, operation),
    ])
    if (
      !isRecord(listBody) ||
      !Array.isArray(listBody.data) ||
      !Number.isSafeInteger(listBody.total_count) ||
      Number(listBody.total_count) < 0
    ) {
      throw invalidResponse(operation)
    }
    const active = parseAccessKeySelection(activeBody, this.#facadeApiKeyHash, operation)
    return {
      data: listBody.data.map((item) => parseAccessKeyCredential(item, active?.credential_id)),
      total_count: Number(listBody.total_count),
    }
  }

  async addAccessKey(
    input: { readonly accessKey: string; readonly accountName: string },
    signal?: AbortSignal,
  ): Promise<PippitAccessKeyCredential> {
    const operation = "add_access_key"
    const accountName = normalizePrintableInput(input.accountName, "account_name", 128, operation)
    const accessKey = input.accessKey.trim()
    if (accessKey === "" || accessKey.length > 4_096 || !/^[\x21-\x7e]+$/u.test(accessKey)) {
      throw new PippitFacadeError({
        code: "INVALID_INPUT",
        message: "The submitted Pippit Access Key is invalid.",
        operation,
      })
    }
    const response = await this.#request(
      "/api/v1/byok",
      {
        body: serializeJson({
          allowed_api_key_hashes: [this.#facadeApiKeyHash],
          key: accessKey,
          name: accountName,
          provider: "pippit",
        }, operation),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      operation,
      signal,
    )
    const body = await readJson(response, operation)
    if (!isRecord(body) || !("data" in body)) throw invalidResponse(operation)
    return parseAccessKeyCredential(body.data, undefined, operation)
  }

  async switchAccessKey(credentialId: string, signal?: AbortSignal): Promise<PippitAccessKeySelection> {
    const operation = "switch_access_key"
    const id = normalizePrintableInput(credentialId, "credential_id", 8_192, operation)
    const response = await this.#request(
      "/api/v1/byok/active",
      {
        body: serializeJson({
          credential_id: id,
          facade_api_key_hash: this.#facadeApiKeyHash,
        }, operation),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
      operation,
      signal,
    )
    const selection = parseAccessKeySelection(
      await readJson(response, operation),
      this.#facadeApiKeyHash,
      operation,
    )
    if (selection === undefined) throw invalidResponse(operation)
    return selection
  }

  async deleteAccessKey(
    credentialId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly credential_id: string; readonly deleted: true }> {
    const operation = "delete_access_key"
    const id = normalizePrintableInput(credentialId, "credential_id", 8_192, operation)
    const response = await this.#request(
      `/api/v1/byok/${encodeURIComponent(id)}?facade_api_key_hash=${encodeURIComponent(this.#facadeApiKeyHash)}`,
      { method: "DELETE" },
      operation,
      signal,
    )
    const body = await readJson(response, operation)
    if (!isRecord(body) || body.deleted !== true) throw invalidResponse(operation)
    return { credential_id: id, deleted: true }
  }

  async #request(
    path: string,
    init: RequestInit,
    operation: PippitFacadeOperation,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    return requestWithBearer({
      apiKey: this.#managementApiKey,
      baseUrl: this.#baseUrl,
      fetchImpl: this.#fetchImpl,
      init,
      operation,
      path,
      signal,
      timeoutMs: this.#timeoutMs,
    })
  }
}
