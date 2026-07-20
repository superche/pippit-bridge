import { createHash } from "node:crypto"

export function normalizeAccessKey(value: string): string {
  const key = value.trim()
  if (key.length < 1 || key.length > 4_096 || !/^[\x21-\x7e]+$/u.test(key)) {
    throw new Error("The Pippit Access Key is not in a supported format.")
  }
  return key
}

export function accessKeyFingerprint(value: string): string {
  return createHash("sha256").update(normalizeAccessKey(value), "utf8").digest("hex")
}

export function maskedAccessKey(value: string): string {
  const accessKey = normalizeAccessKey(value)
  const prefix = accessKey.startsWith("ak-") ? "ak-" : ""
  const suffix = accessKey.length >= 12 ? accessKey.slice(-4) : ""
  return `${prefix}****${suffix}`
}
