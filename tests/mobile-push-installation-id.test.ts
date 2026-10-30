import { describe, expect, it } from 'vitest'
import { isPushInstallationId } from '../src/mobile-push/installation-id.js'

describe('isPushInstallationId', () => {
  it('accepts every allowed UUID version and variant nibble', () => {
    for (const version of ['1', '2', '3', '4', '5', '6', '7', '8']) {
      expect(isPushInstallationId(`e7b8a9c0-0000-${version}000-8000-000000000000`)).toBe(true)
    }
    for (const variant of ['8', '9', 'a', 'b']) {
      expect(isPushInstallationId(`e7b8a9c0-0000-4000-${variant}000-000000000000`)).toBe(true)
    }
  })

  it('rejects all-zero, wrong version or variant, and nonconforming shapes', () => {
    expect(isPushInstallationId('00000000-0000-0000-0000-000000000000')).toBe(false)
    expect(isPushInstallationId('e7b8a9c0-0000-9000-8000-000000000000')).toBe(false)
    expect(isPushInstallationId('e7b8a9c0-0000-0000-8000-000000000000')).toBe(false)
    expect(isPushInstallationId('e7b8a9c0-0000-4000-c000-000000000000')).toBe(false)
    expect(isPushInstallationId('e7b8a9c0-0000-4000-8000-00000000000g')).toBe(false)
    expect(isPushInstallationId('e7b8a9c0-0000-4000-80000-000000000000')).toBe(false)
    expect(isPushInstallationId('e7b8a9c0000040008000000000000000')).toBe(false)
    expect(isPushInstallationId('')).toBe(false)
    expect(isPushInstallationId('3f2a9c10-7b4e-4d8a-9c21-5e6f0a1b2c3d'.toUpperCase())).toBe(true)
    expect(isPushInstallationId(42)).toBe(false)
    expect(isPushInstallationId(null)).toBe(false)
    expect(isPushInstallationId(undefined)).toBe(false)
  })
})
