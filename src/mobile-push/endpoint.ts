import { lookup as dnsLookup } from 'node:dns/promises'
import { createPublicKey } from 'node:crypto'
import { isIP } from 'node:net'
import { isGloballyRoutableIpv4 } from '../network.js'
import type { PushSubscriptionData } from './contracts.js'

const MAX_ENDPOINT_BYTES = 2048
const APPLE_SUFFIX = '.push.apple.com'
const BASE64URL = /^[A-Za-z0-9_-]+$/u

/** Canonical URL identity for push endpoint ownership; policy checks live elsewhere. */
export function canonicalPushEndpoint(value: string): string {
  try {
    return new URL(value).href
  } catch {
    throw new TypeError('push_endpoint_invalid')
  }
}

function invalid(): never {
  throw new TypeError('push_subscription_invalid')
}

function decodeBase64url(value: unknown): Buffer {
  if (typeof value !== 'string' || !BASE64URL.test(value)) return invalid()
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) return invalid()
  return decoded
}

function validateEndpoint(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_ENDPOINT_BYTES) return invalid()
  let url: URL
  try { url = new URL(value) } catch { return invalid() }
  const hostname = url.hostname.toLowerCase()
  const authority = /^https:\/\/([^/?#]*)/iu.exec(value)?.[1] ?? ''
  if (url.protocol !== 'https:'
    || authority.includes('@') || url.username !== '' || url.password !== '' || value.includes('#') || url.hash !== ''
    || (url.port !== '' && url.port !== '443')
    || url.pathname === '' || url.pathname === '/'
    || !hostname.endsWith(APPLE_SUFFIX)
    || hostname.length <= APPLE_SUFFIX.length
    || isIP(hostname) !== 0
    || hostname.endsWith('.')
    || hostname.split('.').some(label => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))) {
    return invalid()
  }
  const canonical = canonicalPushEndpoint(value)
  if (Buffer.byteLength(canonical, 'utf8') > MAX_ENDPOINT_BYTES) return invalid()
  return canonical
}

function validateP256PublicKey(value: unknown): string {
  const bytes = decodeBase64url(value)
  if (bytes.length !== 65 || bytes[0] !== 4) return invalid()
  try {
    createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: bytes.subarray(1, 33).toString('base64url'),
        y: bytes.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    })
  } catch {
    return invalid()
  }
  return value as string
}

/** Validate an untrusted browser subscription before persisting or sending it. */
export function validatePushSubscription(value: unknown): PushSubscriptionData {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as { endpoint?: unknown; keys?: unknown }
  if (input.keys === null || typeof input.keys !== 'object' || Array.isArray(input.keys)) return invalid()
  const keys = input.keys as { p256dh?: unknown; auth?: unknown }
  const p256dh = validateP256PublicKey(keys.p256dh)
  const authBytes = decodeBase64url(keys.auth)
  if (authBytes.length !== 16) return invalid()
  return Object.freeze({
    endpoint: validateEndpoint(input.endpoint),
    keys: Object.freeze({ p256dh, auth: keys.auth as string }),
  })
}

function ipv6Value(address: string): bigint {
  const [leftText = '', rightText] = address.toLowerCase().split('::')
  const left = leftText === '' ? [] : leftText.split(':')
  const right = rightText === undefined || rightText === '' ? [] : rightText.split(':')
  const omitted = 8 - left.length - right.length
  const groups = [...left, ...Array.from({ length: omitted }, () => '0'), ...right]
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/u.test(group))) throw new Error('invalid IPv6')
  return groups.reduce((n, group) => (n << 16n) | BigInt(`0x${group}`), 0n)
}

/** Reject non-global, special-purpose and IPv4-mapped DNS answers. */
export function isGloballyRoutableAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isGloballyRoutableIpv4(address)
  if (family !== 6 || address.includes('%') || address.includes('.')) return false
  try {
    const value = ipv6Value(address)
    const first16 = value >> 112n
    // Global Unicast is 2000::/3; special-use, documentation and transition ranges are excluded.
    if ((value >> 125n) !== 1n) return false
    if (first16 === 0x2001n && (value >> 105n) === (0x2001n << 7n)) return false // 2001::/23 special-purpose
    if (first16 === 0x2001n && (value >> 96n) === 0x20010db8n) return false // 2001:db8::/32 documentation
    if (first16 === 0x2002n) return false // deprecated 6to4
    if (first16 === 0x3fffn && ((value >> 108n) & 0xfn) === 0n) return false // 3fff::/20 documentation
    return true
  } catch {
    return false
  }
}

export interface AppleEndpointAddress { readonly address: string; readonly family: 4 | 6 }
export type AppleEndpointResolver = (hostname: string) => Promise<readonly AppleEndpointAddress[]>

async function systemResolver(hostname: string): Promise<readonly AppleEndpointAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true })
  return addresses.filter(item => item.family === 4 || item.family === 6) as AppleEndpointAddress[]
}

/** Resolve and vet every answer before a caller opens a socket. */
export async function resolveAppleEndpoint(
  endpoint: string,
  resolver: AppleEndpointResolver = systemResolver,
): Promise<{ readonly url: URL; readonly addresses: readonly AppleEndpointAddress[] }> {
  const url = new URL(validateEndpoint(endpoint))
  const addresses = await resolver(url.hostname)
  if (addresses.length === 0 || addresses.some(item => !isGloballyRoutableAddress(item.address)
    || (item.family !== 4 && item.family !== 6)
    || isIP(item.address) !== item.family)) {
    throw new TypeError('push_endpoint_address_rejected')
  }
  return Object.freeze({ url, addresses: Object.freeze([...addresses]) })
}
