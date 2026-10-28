import { describe, expect, it } from 'vitest'
import { DEFAULT_IROH_LOCAL_PORT, irohHostname, irohOrigin, validateIrohOrigin } from '../src/iroh-origin.js'

const ENDPOINT = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('iroh origin contract', () => {
  it('derives a DNS-safe hostname from the full endpoint key', () => {
    expect(irohHostname(ENDPOINT)).toBe(
      '0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef.iroh.localhost')
  })

  it('uses the default local port unless overridden', () => {
    expect(irohOrigin(ENDPOINT)).toBe(`https://${irohHostname(ENDPOINT)}:${DEFAULT_IROH_LOCAL_PORT}`)
    expect(irohOrigin(ENDPOINT, 3443)).toBe(`https://${irohHostname(ENDPOINT)}:3443`)
  })

  it('rejects malformed endpoint ids and ports', () => {
    expect(() => irohHostname('0123')).toThrow('lowercase 32-byte public key')
    expect(() => irohHostname(ENDPOINT.toUpperCase())).toThrow('lowercase 32-byte public key')
    expect(() => irohOrigin(ENDPOINT, 80)).toThrow('from 1024 through 65535')
    expect(() => irohOrigin(ENDPOINT, 70000)).toThrow('from 1024 through 65535')
  })

  it('accepts only the exact selected origin', () => {
    const origin = irohOrigin(ENDPOINT)
    expect(validateIrohOrigin(origin, ENDPOINT)).toBe(origin)
    expect(() => validateIrohOrigin(irohOrigin(ENDPOINT, 3443), ENDPOINT)).toThrow('does not match')
    expect(() => validateIrohOrigin(origin, `${ENDPOINT.slice(0, 63)}0`)).toThrow()
  })
})
