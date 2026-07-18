import type { AuthHook } from "@opencode-ai/plugin"
import type { DeviceAuthorizationOptions } from "./options.js"
import { PIPPIT_ACCESS_KEY_ENV, PIPPIT_PROVIDER_ID } from "./options.js"

type AuthMethod = AuthHook["methods"][number]
type StoredAuth = { readonly type: string; readonly key?: string }
type StoredAuthGetter = () => Promise<StoredAuth | undefined>

export interface DeviceAuthorizationDependencies {
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  readonly requestTimeoutMs?: number
  readonly sleep?: (milliseconds: number) => Promise<void>
}

interface DeviceAuthorizationResponse {
  readonly deviceCode: string
  readonly expiresInSeconds: number
  readonly intervalSeconds: number
  readonly userCode: string
  readonly verificationUrl: string
}

const DEFAULT_DEVICE_REQUEST_TIMEOUT_MS = 30_000

async function withRequestDeadline<T>(
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error("The Pippit website authorization request timed out."))
    }, timeoutMs)
  })
  try {
    return await Promise.race([task(controller.signal), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export class PippitCredentialSource {
  private storedAuthGetter: StoredAuthGetter | undefined

  setStoredAuthGetter(getter: StoredAuthGetter): void {
    this.storedAuthGetter = getter
  }

  async read(): Promise<string> {
    const environmentKey = process.env[PIPPIT_ACCESS_KEY_ENV]
    if (environmentKey !== undefined && environmentKey.trim() !== "") {
      return normalizeAccessKey(environmentKey)
    }

    const auth = await this.storedAuthGetter?.()
    if (auth?.type === "api" && typeof auth.key === "string") {
      return normalizeAccessKey(auth.key)
    }
    throw new Error(
      `Pippit is not connected. Run /connect, select Pippit (小云雀), and bind an Access Key issued by the official website.`,
    )
  }
}

export function normalizeAccessKey(value: string): string {
  const key = value.trim()
  if (key.length < 1 || key.length > 4_096 || !/^[\x21-\x7e]+$/u.test(key)) {
    throw new Error("The Pippit Access Key is not in a supported format.")
  }
  return key
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("The Pippit device authorization service returned an invalid response.")
  }
  return value
}

function positiveNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("The Pippit device authorization service returned an invalid response.")
  }
  return value
}

function safeVerificationUrl(value: string, issuerOrigin: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("The Pippit device authorization service returned an invalid verification URL.")
  }
  if (url.protocol !== "https:" || url.origin !== issuerOrigin || url.username || url.password) {
    throw new Error("The Pippit device authorization service returned an untrusted verification URL.")
  }
  return url.toString()
}

async function startDeviceAuthorization(
  options: DeviceAuthorizationOptions,
  fetchImpl: typeof fetch,
  requestTimeoutMs: number,
): Promise<DeviceAuthorizationResponse> {
  const value = await withRequestDeadline(requestTimeoutMs, async (signal) => {
    const response = await fetchImpl(options.authorizationURL, {
      body: new URLSearchParams({ client_id: options.clientID, scope: options.scope }),
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "error",
      signal,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error("Pippit could not start website authorization.")
    }
    return await response.json() as unknown
  })
  if (!isRecord(value)) {
    throw new Error("The Pippit device authorization service returned an invalid response.")
  }
  const issuerOrigin = new URL(options.authorizationURL).origin
  const verificationUri = requiredString(value, "verification_uri")
  const verificationUriComplete =
    typeof value.verification_uri_complete === "string" && value.verification_uri_complete.trim() !== ""
      ? value.verification_uri_complete
      : verificationUri
  return {
    deviceCode: requiredString(value, "device_code"),
    expiresInSeconds: positiveNumber(value, "expires_in"),
    intervalSeconds: value.interval === undefined ? 5 : positiveNumber(value, "interval"),
    userCode: requiredString(value, "user_code"),
    verificationUrl: safeVerificationUrl(verificationUriComplete, issuerOrigin),
  }
}

async function readTokenResponse(response: Response): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new Error("The Pippit device token service returned an invalid response.")
  }
  if (!isRecord(value)) {
    throw new Error("The Pippit device token service returned an invalid response.")
  }
  return value
}

export function createDeviceAuthorizationMethod(
  options: DeviceAuthorizationOptions,
  dependencies: DeviceAuthorizationDependencies = {},
): AuthMethod {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
  const now = dependencies.now ?? Date.now
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_DEVICE_REQUEST_TIMEOUT_MS
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))

  return {
    type: "oauth",
    label: "小云雀官网一键绑定 / Bind on Pippit website",
    async authorize() {
      const device = await startDeviceAuthorization(options, fetchImpl, requestTimeoutMs)
      return {
        instructions: `Confirm the Pippit Access Key grant in your browser. If asked, enter code ${device.userCode}.`,
        method: "auto",
        url: device.verificationUrl,
        async callback() {
          let intervalMs = Math.max(1_000, device.intervalSeconds * 1_000)
          const deadline = now() + device.expiresInSeconds * 1_000

          while (now() < deadline) {
            await sleep(intervalMs)
            if (now() >= deadline) return { type: "failed" }
            let response: Response
            let body: Record<string, unknown>
            try {
              const result = await withRequestDeadline(
                Math.min(requestTimeoutMs, Math.max(1, deadline - now())),
                async (signal) => {
                  const response = await fetchImpl(options.tokenURL, {
                    body: new URLSearchParams({
                      client_id: options.clientID,
                      device_code: device.deviceCode,
                      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                    }),
                    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
                    method: "POST",
                    redirect: "error",
                    signal,
                  })
                  return { body: await readTokenResponse(response), response }
                },
              )
              response = result.response
              body = result.body
            } catch {
              intervalMs = Math.min(intervalMs * 2, 30_000)
              continue
            }

            if (now() >= deadline) {
              await response.body?.cancel().catch(() => undefined)
              return { type: "failed" }
            }
            if (response.ok) {
              const accessToken = requiredString(body, "access_token")
              return { key: normalizeAccessKey(accessToken), provider: PIPPIT_PROVIDER_ID, type: "success" }
            }

            const error = typeof body.error === "string" ? body.error : ""
            if (error === "authorization_pending") continue
            if (error === "slow_down") {
              intervalMs += 5_000
              continue
            }
            if (error === "access_denied" || error === "expired_token") return { type: "failed" }
            return { type: "failed" }
          }
          return { type: "failed" }
        },
      }
    },
  }
}

export function createPippitAuthHook(
  credentials: PippitCredentialSource,
  deviceAuthorization?: DeviceAuthorizationOptions,
  dependencies: DeviceAuthorizationDependencies = {},
): AuthHook {
  const methods: AuthHook["methods"] = [
    ...(deviceAuthorization === undefined ? [] : [createDeviceAuthorizationMethod(deviceAuthorization, dependencies)]),
    {
      type: "api",
      label: "粘贴官网已签发的 AK / Paste an Access Key issued by Pippit",
    },
  ]
  return {
    provider: PIPPIT_PROVIDER_ID,
    async loader(getAuth) {
      credentials.setStoredAuthGetter(getAuth as StoredAuthGetter)
      return { apiKey: "opencode-managed-pippit-access-key" }
    },
    methods,
  }
}
