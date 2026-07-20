import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type {
  PippitAccessKeyCredential,
  PippitAccessKeyEnrollment,
  PippitAccessKeySelection,
} from "./contracts.ts"

const DEFAULT_BODY_LIMIT_BYTES = 8 * 1024
const DEFAULT_MAX_SESSIONS = 128
const MAX_SESSION_LIMIT = 1024
const ACCESS_KEY_GUIDE_URL = "https://bytedance.larkoffice.com/docx/CQOYdJNLioLz6fxRzKXcCsKLnJh"

const PAGE_STYLES = `
:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;color:#1d1d1f;background:#f5f5f7;font-synthesis:none}
*{box-sizing:border-box}
body{margin:0;min-width:320px;background:#f5f5f7;color:#1d1d1f;font-size:17px;line-height:1.47;letter-spacing:-.022em}
.page-shell{min-height:100svh;display:grid;place-items:center;padding:clamp(24px,7vw,80px) 20px}
.card{width:min(100%,560px);padding:40px;background:#fff;border:1px solid #e0e0e0;border-radius:18px}
.eyebrow{margin:0 0 12px;color:#6e6e73;font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
h1{margin:0;font-size:40px;font-weight:600;line-height:1.1;letter-spacing:-.035em}
.lead{margin:16px 0 0;color:#3a3a3c}
.account{display:inline-block;margin-top:10px;padding:5px 10px;border-radius:999px;background:#f5f5f7;color:#1d1d1f;font-size:14px;font-weight:600;line-height:1.4;letter-spacing:-.01em;overflow-wrap:anywhere}
.guide{margin:28px 0 0;padding:17px;background:#f5f5f7;border-radius:14px}
.guide-title{margin:0;color:#6e6e73;font-size:14px;letter-spacing:-.01em}
.guide-link,.status-link{display:inline-flex;align-items:center;gap:4px;margin-top:4px;color:#0066cc;font-weight:600;text-decoration:none}
.guide-link:hover,.status-link:hover{text-decoration:underline;text-underline-offset:3px}
.guide-link:focus-visible,.status-link:focus-visible{outline:2px solid #0071e3;outline-offset:4px;border-radius:4px}
.security-note{position:relative;margin:20px 0 0;padding-left:27px;color:#6e6e73;font-size:14px;line-height:1.45;letter-spacing:-.01em}
.security-note::before{content:"✓";position:absolute;left:0;top:0;width:19px;height:19px;border-radius:50%;background:#e8f2ff;color:#0066cc;font-size:12px;font-weight:700;line-height:19px;text-align:center}
form{margin-top:28px}
label{display:block;margin-bottom:8px;font-size:15px;font-weight:600;letter-spacing:-.01em}
input{display:block;width:100%;height:54px;padding:0 15px;border:1px solid rgba(0,0,0,.18);border-radius:12px;background:#fff;color:#1d1d1f;font:inherit;letter-spacing:0;outline:none;transition:border-color .16s ease,box-shadow .16s ease}
input::placeholder{color:#86868b}
input:hover{border-color:rgba(0,0,0,.32)}
input:focus{border-color:#0071e3;box-shadow:0 0 0 3px rgba(0,113,227,.18)}
button{width:100%;min-height:50px;margin-top:17px;padding:12px 22px;border:0;border-radius:999px;background:#0066cc;color:#fff;font:inherit;font-weight:400;cursor:pointer;transition:background-color .16s ease,transform .12s ease}
button:hover{background:#0071e3}
button:active{transform:scale(.98)}
button:focus-visible{outline:2px solid #0071e3;outline-offset:3px}
.form-hint{margin:12px 0 0;color:#86868b;font-size:13px;line-height:1.45;text-align:center;letter-spacing:-.01em}
.status-card{text-align:center}
.status-icon{display:grid;place-items:center;width:48px;height:48px;margin:0 auto 20px;border-radius:50%;background:#e8f2ff;color:#0066cc;font-size:24px;font-weight:600}
.status-card h1{font-size:34px}
.status-message{margin:16px auto 0;max-width:28rem;color:#6e6e73}
.status-link{margin-top:24px;font-size:15px}
@media (max-width:640px){.page-shell{place-items:start center;padding:20px}.card{padding:28px 24px}h1{font-size:34px}.status-card h1{font-size:30px}.guide{margin-top:24px}form{margin-top:24px}}
@media (prefers-reduced-motion:reduce){input,button{transition:none}button:active{transform:none}}
`

export interface PippitEnrollmentManagementBackend {
  addAccessKey(
    input: { readonly accessKey: string; readonly accountName: string },
    signal?: AbortSignal,
  ): Promise<PippitAccessKeyCredential>
  switchAccessKey(credentialId: string, signal?: AbortSignal): Promise<PippitAccessKeySelection>
}

export interface PippitAccessKeyEnrollmentBackend {
  close(): Promise<void>
  createEnrollment(accountName: string): Promise<PippitAccessKeyEnrollment>
}

export interface PippitAccessKeyEnrollmentServerOptions {
  readonly bodyLimitBytes?: number
  readonly managementClient: PippitEnrollmentManagementBackend
  readonly maxSessions?: number
  readonly now?: () => number
  readonly port?: number
  readonly tokenFactory?: () => string
  readonly ttlMs?: number
}

interface EnrollmentSession {
  readonly accountName: string
  readonly expiresAt: number
}

class EnrollmentBodyTooLargeError extends Error {}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store")
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  )
  response.setHeader("referrer-policy", "strict-origin")
  response.setHeader("x-content-type-options", "nosniff")
  response.setHeader("x-frame-options", "DENY")
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  securityHeaders(response)
  response.statusCode = status
  response.setHeader("content-type", "text/html; charset=utf-8")
  response.end(body)
}

function pageDocument(title: string, content: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(title)} · Pippit</title><style>${PAGE_STYLES}</style></head><body><main class="page-shell">${content}</main></body></html>`
}

function guideLink(className: string, label: string): string {
  return `<a class="${className}" href="${ACCESS_KEY_GUIDE_URL}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${label}<span aria-hidden="true">↗</span></a>`
}

function statusPage(title: string, message: string, tone: "error" | "success" = "error"): string {
  const icon = tone === "success" ? "✓" : "!"
  const recovery = tone === "success" ? "" : guideLink("status-link", "查看 Access Key 配置指南")
  return pageDocument(
    title,
    `<section class="card status-card" aria-labelledby="status-title"><div class="status-icon" aria-hidden="true">${icon}</div><h1 id="status-title">${escapeHtml(title)}</h1><p class="status-message">${escapeHtml(message)}</p>${recovery}</section>`,
  )
}

function enrollmentPage(accountName: string): string {
  return pageDocument(
    "连接 Pippit",
    `<section class="card" aria-labelledby="enrollment-title"><p class="eyebrow">Pippit · 安全连接</p><h1 id="enrollment-title">连接 Pippit</h1><p class="lead">为以下账号添加 Access Key</p><div class="account">${escapeHtml(accountName)}</div><div class="guide"><p class="guide-title">还没有 Access Key？</p>${guideLink("guide-link", "打开获取与配置指南")}</div><p class="security-note" id="security-note">Access Key 仅提交到本机 MCP，不会写入 Codex 对话、工具参数或日志。</p><form method="post"><label for="access_key">Pippit Access Key</label><input id="access_key" name="access_key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done" placeholder="粘贴 Pippit Access Key" aria-describedby="security-note form-hint" required maxlength="4096" autofocus><button type="submit">保存并启用</button><p class="form-hint" id="form-hint">此链接仅可使用一次，并会自动过期。</p></form></section>`,
  )
}

async function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  const declared = request.headers["content-length"]
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
    throw new EnrollmentBodyTooLargeError()
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    bytes += buffer.byteLength
    if (bytes > maximum) throw new EnrollmentBodyTooLargeError()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, bytes).toString("utf8")
}

function normalizeAccountName(value: string): string {
  const normalized = value.trim()
  if (normalized === "" || normalized.length > 128) {
    throw new Error("account_name must be a non-empty string of at most 128 characters.")
  }
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      throw new Error("account_name must not contain control characters.")
    }
  }
  return normalized
}

export class PippitAccessKeyEnrollmentServer implements PippitAccessKeyEnrollmentBackend {
  readonly #bodyLimitBytes: number
  readonly #managementClient: PippitEnrollmentManagementBackend
  readonly #maxSessions: number
  readonly #now: () => number
  readonly #port: number
  readonly #sessions = new Map<string, EnrollmentSession>()
  readonly #tokenFactory: () => string
  readonly #ttlMs: number
  #closed = false
  #origin: string | undefined
  #server: Server | undefined
  #startPromise: Promise<void> | undefined

  constructor(options: PippitAccessKeyEnrollmentServerOptions) {
    this.#managementClient = options.managementClient
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.#now = options.now ?? Date.now
    this.#port = options.port ?? 0
    this.#ttlMs = options.ttlMs ?? 5 * 60_000
    this.#bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"))
    if (!Number.isSafeInteger(this.#port) || this.#port < 0 || this.#port > 65_535) {
      throw new Error("Enrollment port must be an integer from 0 to 65535.")
    }
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1 || this.#ttlMs > 15 * 60_000) {
      throw new Error("Enrollment TTL must be an integer from 1 to 900000 milliseconds.")
    }
    if (!Number.isSafeInteger(this.#bodyLimitBytes) || this.#bodyLimitBytes < 1 || this.#bodyLimitBytes > 64 * 1024) {
      throw new Error("Enrollment body limit must be an integer from 1 to 65536 bytes.")
    }
    if (!Number.isSafeInteger(this.#maxSessions) || this.#maxSessions < 1 || this.#maxSessions > MAX_SESSION_LIMIT) {
      throw new Error(`Enrollment session limit must be an integer from 1 to ${MAX_SESSION_LIMIT}.`)
    }
  }

  async createEnrollment(accountNameValue: string): Promise<PippitAccessKeyEnrollment> {
    if (this.#closed) throw new Error("Pippit Access Key enrollment server is closed.")
    const accountName = normalizeAccountName(accountNameValue)
    await this.#start()
    const now = this.#now()
    for (const [token, session] of this.#sessions) {
      if (now >= session.expiresAt) this.#sessions.delete(token)
    }
    if (this.#sessions.size >= this.#maxSessions) {
      throw new Error("Enrollment session capacity reached. Try again after an existing link expires.")
    }
    let token = ""
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = this.#tokenFactory()
      if (/^[A-Za-z0-9_-]{32,256}$/u.test(candidate) && !this.#sessions.has(candidate)) {
        token = candidate
        break
      }
    }
    if (token === "") throw new Error("Could not create a secure enrollment token.")
    const expiresAt = now + this.#ttlMs
    this.#sessions.set(token, { accountName, expiresAt })
    return {
      account_name: accountName,
      enrollment_url: `${this.#origin}/enroll/${token}`,
      expires_at: new Date(expiresAt).toISOString(),
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#sessions.clear()
    await this.#startPromise?.catch(() => undefined)
    const server = this.#server
    if (server === undefined || !server.listening) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  async #start(): Promise<void> {
    if (this.#startPromise !== undefined) return this.#startPromise
    this.#startPromise = new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.#handle(request, response).catch(() => {
          if (!response.headersSent) {
            sendHtml(response, 500, statusPage("录入失败", "请关闭此页面，并从 Codex 重新获取录入链接后重试。"))
          } else if (!response.writableEnded) {
            response.end()
          }
        })
      })
      this.#server = server
      server.once("error", reject)
      server.listen(this.#port, "127.0.0.1", () => {
        server.off("error", reject)
        const address = server.address() as AddressInfo | null
        if (address === null) {
          reject(new Error("Enrollment server did not receive a loopback address."))
          return
        }
        this.#origin = `http://127.0.0.1:${address.port}`
        resolve()
      })
    })
    return this.#startPromise
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.#origin === undefined || request.headers.host !== new URL(this.#origin).host) {
      sendHtml(response, 403, statusPage("链接不可用", "此录入链接只能通过本机 loopback 地址访问。"))
      return
    }
    const requestOrigin = request.headers.origin
    if (requestOrigin !== undefined && requestOrigin !== this.#origin) {
      sendHtml(
        response,
        403,
        statusPage("提交未完成", "请求来源校验失败。请关闭此页面，并从 Codex 重新获取新的录入链接。"),
      )
      return
    }
    const url = new URL(request.url ?? "/", this.#origin)
    const match = /^\/enroll\/([A-Za-z0-9_-]{32,256})$/u.exec(url.pathname)
    if (match === null || url.search !== "") {
      sendHtml(response, 404, statusPage("链接无效", "请关闭此页面，并从 Codex 重新获取录入链接。"))
      return
    }
    const token = match[1] as string
    const session = this.#sessions.get(token)
    if (session === undefined || this.#now() >= session.expiresAt) {
      this.#sessions.delete(token)
      sendHtml(response, 410, statusPage("链接已失效", "此一次性链接已使用或过期，请从 Codex 重新获取。"))
      return
    }
    if (request.method === "GET") {
      sendHtml(response, 200, enrollmentPage(session.accountName))
      return
    }
    if (request.method !== "POST") {
      securityHeaders(response)
      response.setHeader("allow", "GET, POST")
      sendHtml(response, 405, statusPage("不支持此操作", "请在浏览器中打开录入链接并使用页面表单。"))
      return
    }

    // A POST consumes the token before any asynchronous work, preventing replay races.
    this.#sessions.delete(token)
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase()
    if (contentType !== "application/x-www-form-urlencoded") {
      sendHtml(response, 415, statusPage("录入失败", "表单格式不正确，请从 Codex 重新获取录入链接。"))
      return
    }
    let body: string
    try {
      body = await readBody(request, this.#bodyLimitBytes)
    } catch (error) {
      if (error instanceof EnrollmentBodyTooLargeError) {
        sendHtml(response, 413, statusPage("录入失败", "提交内容超出限制，请从 Codex 重新获取录入链接。"))
        return
      }
      throw error
    }
    const form = new URLSearchParams(body)
    if ([...form.keys()].some((key) => key !== "access_key") || form.getAll("access_key").length !== 1) {
      sendHtml(response, 400, statusPage("录入失败", "表单内容无效，请从 Codex 重新获取录入链接。"))
      return
    }
    const accessKey = form.get("access_key") ?? ""
    try {
      const credential = await this.#managementClient.addAccessKey({
        accessKey,
        accountName: session.accountName,
      })
      await this.#managementClient.switchAccessKey(credential.credential_id)
    } catch {
      sendHtml(
        response,
        502,
        statusPage("录入失败", "未能保存 Access Key。请确认 Key 有效后，从 Codex 获取新链接重试。"),
      )
      return
    }
    sendHtml(
      response,
      200,
      statusPage(
        "已保存并启用",
        `账号「${session.accountName}」已激活。你可以关闭此页面，回到 Codex 继续生成视频。`,
        "success",
      ),
    )
  }
}

export function createPippitAccessKeyEnrollmentServer(
  options: PippitAccessKeyEnrollmentServerOptions,
): PippitAccessKeyEnrollmentServer {
  return new PippitAccessKeyEnrollmentServer(options)
}
