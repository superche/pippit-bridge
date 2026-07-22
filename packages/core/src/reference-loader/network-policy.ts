import { lookup as dnsLookup } from "node:dns/promises"
import { isIP } from "node:net"
import {
  ReferenceLoadError,
  type ReferenceLookup,
  type ReferenceLookupAddress,
} from "./contracts.js"

export const defaultLookup: ReferenceLookup = async (hostname, options) => dnsLookup(hostname, options)

export function parseUrl(value: string): URL {
  if (typeof value !== "string" || value.length === 0) throw new ReferenceLoadError("INVALID_URL")
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new ReferenceLoadError("INVALID_URL") }
  if (parsed.username !== "" || parsed.password !== "") throw new ReferenceLoadError("URL_CREDENTIALS_NOT_ALLOWED")
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ReferenceLoadError("UNSUPPORTED_SCHEME")
  return parsed
}

function parseIpv4(address: string): readonly number[] | undefined {
  const parts = address.split(".")
  if (parts.length !== 4) return undefined
  const octets = parts.map(part => Number(part))
  return octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255) ? undefined : octets
}

function isBlockedIpv4(address: string): boolean {
  const octets = parseIpv4(address)
  if (octets === undefined) return true
  const first = octets[0] ?? 0
  const second = octets[1] ?? 0
  return first === 0 || first === 10 || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0) || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && octets[2] === 100)
    || (first === 203 && second === 0 && octets[2] === 113) || first >= 224
}

function ipv4ToWords(address: string): readonly [number, number] | undefined {
  const octets = parseIpv4(address)
  if (octets === undefined) return undefined
  return [((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)]
}

function parseIpv6(address: string): readonly number[] | undefined {
  let normalized = address.toLowerCase()
  const zoneIndex = normalized.indexOf("%")
  if (zoneIndex !== -1) normalized = normalized.slice(0, zoneIndex)
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":")
    if (lastColon === -1) return undefined
    const words = ipv4ToWords(normalized.slice(lastColon + 1))
    if (words === undefined) return undefined
    normalized = `${normalized.slice(0, lastColon)}:${words[0].toString(16)}:${words[1].toString(16)}`
  }
  const halves = normalized.split("::")
  if (halves.length > 2) return undefined
  const left = halves[0] === "" ? [] : (halves[0]?.split(":") ?? [])
  const right = halves.length === 1 || halves[1] === "" ? [] : (halves[1]?.split(":") ?? [])
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined
  const wordStrings = [...left, ...Array.from({ length: missing }, () => "0"), ...right]
  if (wordStrings.length !== 8) return undefined
  const words = wordStrings.map(word => Number.parseInt(word, 16))
  if (wordStrings.some(word => !/^[0-9a-f]{1,4}$/u.test(word))
    || words.some(word => !Number.isInteger(word) || word < 0 || word > 0xffff)) return undefined
  return words
}

function isBlockedIpv6(address: string): boolean {
  const words = parseIpv6(address)
  if (words === undefined) return true
  const first = words[0] ?? 0
  const allButLastAreZero = words.slice(0, 7).every(word => word === 0)
  if (words.every(word => word === 0) || (allButLastAreZero && words[7] === 1)) return true
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return true
  if ((first & 0xff00) === 0xff00) return true
  if ((first === 0x0064 && words[1] === 0xff9b && words.slice(2, 6).every(word => word === 0))
    || (first === 0x0100 && words.slice(1, 4).every(word => word === 0))
    || (first === 0x2001 && (words[1] === 0x0db8 || (words[1] ?? 0) < 0x0200)) || first === 0x2002) return true
  const isIpv4Mapped = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff
  const isIpv4Compatible = words.slice(0, 6).every(word => word === 0)
  if (isIpv4Mapped || isIpv4Compatible) {
    const high = words[6] ?? 0
    const low = words[7] ?? 0
    return isBlockedIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`)
  }
  return false
}

function isBlockedAddress(address: string): boolean {
  const withoutBrackets = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address
  const version = isIP(withoutBrackets.split("%", 1)[0] ?? withoutBrackets)
  return version === 4 ? isBlockedIpv4(withoutBrackets) : version === 6 ? isBlockedIpv6(withoutBrackets) : true
}

export async function assertPublicHttpUrl(
  url: URL,
  allowPrivateUrls: boolean,
  lookup: ReferenceLookup,
): Promise<ReferenceLookupAddress | undefined> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ReferenceLoadError("UNSUPPORTED_SCHEME")
  if (url.username !== "" || url.password !== "") throw new ReferenceLoadError("URL_CREDENTIALS_NOT_ALLOWED")
  if (allowPrivateUrls) return undefined
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname
  if (isIP(hostname) !== 0) {
    if (isBlockedAddress(hostname)) throw new ReferenceLoadError("PRIVATE_ADDRESS")
    return { address: hostname, family: isIP(hostname) }
  }
  let addresses: readonly ReferenceLookupAddress[]
  try { addresses = await lookup(hostname, { all: true, verbatim: true }) } catch {
    throw new ReferenceLoadError("DNS_LOOKUP_FAILED")
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isIP(address) === 0)) {
    throw new ReferenceLoadError("DNS_LOOKUP_FAILED")
  }
  if (addresses.some(({ address }) => isBlockedAddress(address))) throw new ReferenceLoadError("PRIVATE_ADDRESS")
  const selected = addresses[0]
  if (selected === undefined) throw new ReferenceLoadError("DNS_LOOKUP_FAILED")
  return { address: selected.address, family: isIP(selected.address) }
}
