import { describe, expect, it } from 'vitest'
import { decodeIrohEvent, encodeIrohCommand, validateIrohProxyTarget } from '../src/iroh-sidecar.js'

const ENDPOINT = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('iroh sidecar protocol', () => {
  it('validates loopback proxy targets only', () => {
    expect(validateIrohProxyTarget('http://127.0.0.1:3443/')).toBe('http://127.0.0.1:3443')
    expect(validateIrohProxyTarget('https://[::1]:3443/')).toBe('https://[::1]:3443')
    expect(() => validateIrohProxyTarget('http://192.168.1.2:3443/')).toThrow('loopback origin')
    expect(() => validateIrohProxyTarget('http://127.0.0.1:3443/path')).toThrow('loopback origin')
  })

  it('encodes strict v1 commands', () => {
    expect(encodeIrohCommand({ version: 1, type: 'device-list' })).toBe('{"version":1,"type":"device-list"}\n')
    expect(encodeIrohCommand({ version: 1, type: 'device-forget', id: ENDPOINT }))
      .toBe(`{"version":1,"type":"device-forget","id":"${ENDPOINT}"}\n`)
    expect(() => encodeIrohCommand({ version: 1, type: 'device-forget', id: 'short' })).toThrow('invalid sidecar command')
    expect(() => encodeIrohCommand({ version: 2, type: 'device-list' } as never)).toThrow('command version')
  })

  it('decodes exact first-party events and rejects extensions', () => {
    expect(decodeIrohEvent(JSON.stringify({ version: 1, type: 'ready', endpoint_id: ENDPOINT, direct_addresses: ['10.0.0.2:4001'], local_only: false })))
      .toEqual({ version: 1, type: 'ready', endpoint_id: ENDPOINT, direct_addresses: ['10.0.0.2:4001'], local_only: false })
    expect(decodeIrohEvent(JSON.stringify({ version: 1, type: 'pairing', code: '123456', expires_in_sec: 300 })))
      .toEqual({ version: 1, type: 'pairing', code: '123456', expires_in_sec: 300 })
    expect(() => decodeIrohEvent(JSON.stringify({ version: 1, type: 'ready', endpoint_id: ENDPOINT, direct_addresses: [], local_only: false, extra: 1 })))
      .toThrow('event fields')
    expect(() => decodeIrohEvent(JSON.stringify({ version: 1, type: 'pairing', code: 'abc', expires_in_sec: 300 })))
      .toThrow('pairing event')
    expect(() => decodeIrohEvent(JSON.stringify({ version: 1, type: 'pairing-closed', reason: 'done\u007f' })))
      .toThrow('sidecar reason')
    expect(() => decodeIrohEvent('not json')).toThrow('event JSON')
    expect(() => decodeIrohEvent(JSON.stringify({ version: 1, type: 'nope' }))).toThrow('event fields')
  })

  it('validates device lists element-wise', () => {
    const device = { id: ENDPOINT, name: 'phone', paired_at: '2026-10-24', online: true }
    expect(decodeIrohEvent(JSON.stringify({ version: 1, type: 'devices', devices: [device] })))
      .toEqual({ version: 1, type: 'devices', devices: [device] })
    expect(() => decodeIrohEvent(JSON.stringify({ version: 1, type: 'devices', devices: [{ ...device, id: 'x' }] })))
      .toThrow('device event')
  })
})
