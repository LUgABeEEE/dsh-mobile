/** Versioned parent-to-sidecar protocol for the iroh transport host.
 *
 * Ported from the independent `dsh-mobile-iroh` companion's sidecar
 * controller. Only the pure command/event codec lives here; child-process
 * ownership stays with the provider controller so lifecycle, timeouts and
 * test doubles follow this repository's existing controller conventions.
 * Every message is versioned, bounded and rejected closed on unknown fields.
 */

import { isIP } from 'node:net'

const MAX_LINE_BYTES = 16 * 1024
const ENDPOINT_ID_PATTERN = /^[0-9a-f]{64}$/u

function isPlainText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function hasExactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).sort().join(',') === [...fields].sort().join(',')
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function isEndpointId(value: unknown): value is string {
  return typeof value === 'string' && ENDPOINT_ID_PATTERN.test(value)
}

/** Validate the loopback socket destination; TLS remains end to end. */
export function validateIrohProxyTarget(value: string): string {
  const target = new URL(value)
  if (!['http:', 'https:'].includes(target.protocol)
    || !['127.0.0.1', '::1'].includes(stripBrackets(target.hostname))
    || target.username !== '' || target.password !== '' || target.pathname !== '/'
    || target.search !== '' || target.hash !== '') {
    throw new Error('sidecar proxy target must be an explicit HTTP(S) loopback origin')
  }
  return target.origin
}

export type IrohSidecarCommand =
  | { readonly version: 1; readonly type: 'pairing-begin' }
  | { readonly version: 1; readonly type: 'device-list' }
  | { readonly version: 1; readonly type: 'device-forget'; readonly id: string }
  | { readonly version: 1; readonly type: 'shutdown' }

/** Strict parent-to-sidecar v1 command encoder. */
export function encodeIrohCommand(message: IrohSidecarCommand): string {
  if (message?.version !== 1) throw new Error('invalid sidecar command version')
  const fields = message.type === 'device-forget' ? ['version', 'type', 'id'] as const : ['version', 'type'] as const
  if (!hasExactFields(message, fields)
    || !['pairing-begin', 'device-list', 'device-forget', 'shutdown'].includes(message.type)
    || (message.type === 'device-forget' && !isEndpointId((message as { id: unknown }).id))) {
    throw new Error('invalid sidecar command')
  }
  const line = JSON.stringify(message)
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('sidecar command too large')
  return `${line}\n`
}

export interface IrohSidecarDevice {
  readonly id: string
  readonly name: string
  readonly paired_at: string
  readonly online: boolean
}

export type IrohSidecarEvent =
  | { readonly version: 1; readonly type: 'ready'; readonly endpoint_id: string; readonly direct_addresses: readonly string[]; readonly local_only: boolean }
  | { readonly version: 1; readonly type: 'pairing'; readonly code: string; readonly expires_in_sec: number }
  | { readonly version: 1; readonly type: 'pairing-closed'; readonly reason: string }
  | { readonly version: 1; readonly type: 'pairing-done'; readonly peer: string; readonly name: string }
  | { readonly version: 1; readonly type: 'peer-connected'; readonly peer: string; readonly name: string }
  | { readonly version: 1; readonly type: 'peer-path'; readonly peer: string; readonly kind: 'direct' | 'relay'; readonly remote: string }
  | { readonly version: 1; readonly type: 'peer-disconnected'; readonly peer: string }
  | { readonly version: 1; readonly type: 'proxy-opened'; readonly peer: string }
  | { readonly version: 1; readonly type: 'devices'; readonly devices: readonly IrohSidecarDevice[] }
  | { readonly version: 1; readonly type: 'error'; readonly code: string; readonly message: string }
  | { readonly version: 1; readonly type: 'stopped' }

function isDirectAddress(value: unknown): boolean {
  if (!isPlainText(value, 128)) return false
  try {
    const url = new URL(`http://${value}`)
    return isIP(stripBrackets(url.hostname)) !== 0 && url.port !== '' && url.pathname === '/'
      && url.username === '' && url.password === '' && url.search === '' && url.hash === ''
  } catch { return false }
}

/** Decode exact first-party stdout events; no extension fields grant authority. */
export function decodeIrohEvent(line: string): IrohSidecarEvent {
  if (typeof line !== 'string' || Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('sidecar event too large')
  let event: Record<string, unknown>
  try { event = JSON.parse(line) as Record<string, unknown> } catch { throw new Error('invalid sidecar event JSON') }
  if (event?.version !== 1 || typeof event.type !== 'string') throw new Error('invalid sidecar event version')
  const base = ['version', 'type'] as const
  const fields = {
    ready: ['endpoint_id', 'direct_addresses', 'local_only'],
    pairing: ['code', 'expires_in_sec'],
    'pairing-closed': ['reason'],
    'pairing-done': ['peer', 'name'],
    'peer-connected': ['peer', 'name'],
    'peer-path': ['peer', 'kind', 'remote'],
    'peer-disconnected': ['peer'],
    'proxy-opened': ['peer'],
    devices: ['devices'],
    error: ['code', 'message'],
    stopped: [],
  }[(event.type as string)] as readonly string[] | undefined
  if (fields === undefined || !hasExactFields(event, [...base, ...fields])) throw new Error('invalid sidecar event fields')
  if ('peer' in event && !isEndpointId(event.peer)) throw new Error('invalid sidecar event peer')
  if ('name' in event && !isPlainText(event.name, 128)) throw new Error('invalid sidecar event name')
  switch (event.type) {
    case 'ready': {
      const addresses = event.direct_addresses
      if (!isEndpointId(event.endpoint_id) || typeof event.local_only !== 'boolean' || !Array.isArray(addresses)
        || addresses.length > 64 || !addresses.every(isDirectAddress)) throw new Error('invalid sidecar ready event')
      return Object.freeze({ version: 1, type: 'ready', endpoint_id: event.endpoint_id, direct_addresses: Object.freeze([...addresses]), local_only: event.local_only }) as IrohSidecarEvent
    }
    case 'pairing':
      if (!/^[0-9]{6}$/u.test(String(event.code)) || !Number.isSafeInteger(event.expires_in_sec)
        || (event.expires_in_sec as number) < 1 || (event.expires_in_sec as number) > 3600) throw new Error('invalid sidecar pairing event')
      break
    case 'pairing-closed':
      if (!isPlainText(event.reason, 128)) throw new Error('invalid sidecar reason')
      break
    case 'peer-path':
      if ((event.kind !== 'direct' && event.kind !== 'relay') || !isPlainText(event.remote, 512)) throw new Error('invalid sidecar path event')
      break
    case 'devices': {
      const devices = event.devices
      if (!Array.isArray(devices) || devices.length > 256 || !devices.every(device =>
        hasExactFields(device, ['id', 'name', 'paired_at', 'online']) && isEndpointId(device.id)
        && isPlainText(device.name, 128) && isPlainText(device.paired_at, 64) && typeof device.online === 'boolean')) {
        throw new Error('invalid sidecar device event')
      }
      return Object.freeze({ version: 1, type: 'devices', devices: Object.freeze(devices.map(device => Object.freeze({ ...(device as object) }))) }) as IrohSidecarEvent
    }
    case 'error':
      if (!isPlainText(event.code, 128) || !isPlainText(event.message, 1024)) throw new Error('invalid sidecar error event')
      break
  }
  return Object.freeze(event) as unknown as IrohSidecarEvent
}
