import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureIrohTls,
  irohGatewayConfig,
  irohTlsPaths,
  IROH_LEAF_RENEW_BEFORE_DAYS,
  IROH_LEAF_VALIDITY_DAYS,
} from '../src/iroh-tls.js'
import { irohHostname } from '../src/iroh-origin.js'
import type { ResolvedGatewayConfig } from '../src/config.js'

const ENDPOINT = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const OTHER_ENDPOINT = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
const roots: string[] = []
const prefix = 'dsh-mobile-iroh-tls-test-'

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (resolve(root) === root && basename(root).startsWith(prefix) && resolve(root, '..') === resolve(tmpdir())) {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } else throw new Error('Refusing to remove an unowned fixture')
  }
})

async function fixtureRoot(): Promise<{ root: string; stateFile: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return { root, stateFile: join(root, 'remote', 'devices.json') }
}

describe('iroh TLS identity', () => {
  it('creates a CA and an endpoint leaf with an exact DNS name', async () => {
    const { root, stateFile } = await fixtureRoot()
    const tls = await ensureIrohTls(ENDPOINT, stateFile, root)
    expect(tls.caFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(tls.endpointId).toBe(ENDPOINT)
    expect(tls.ca.ca).toBe(true)
    expect(tls.leaf.ca).toBe(false)
    expect(tls.leaf.subjectAltName).toBe(`DNS:${irohHostname(ENDPOINT)}`)
    expect(tls.leaf.verify(tls.ca.publicKey)).toBe(true)
    const leafDays = (Date.parse(tls.leaf.validTo) - Date.parse(tls.leaf.validFrom)) / 86_400_000
    expect(leafDays).toBeGreaterThanOrEqual(IROH_LEAF_VALIDITY_DAYS - 1)
    expect(leafDays).toBeLessThanOrEqual(IROH_LEAF_VALIDITY_DAYS + 1)
    const identity = JSON.parse(await readFile(tls.paths.statusFile, 'utf8')) as { endpointId: string; caFingerprint: string }
    expect(identity).toEqual({ version: 1, endpointId: ENDPOINT, caFingerprint: tls.caFingerprint })
  })

  it('reuses intact material and re-issues for a new endpoint or an expiring leaf', async () => {
    const { root, stateFile } = await fixtureRoot()
    const first = await ensureIrohTls(ENDPOINT, stateFile, root)
    const second = await ensureIrohTls(ENDPOINT, stateFile, root)
    expect(second.leaf.raw.equals(first.leaf.raw)).toBe(true)
    const moved = await ensureIrohTls(OTHER_ENDPOINT, stateFile, root)
    expect(moved.caFingerprint).toBe(first.caFingerprint)
    expect(moved.leaf.subjectAltName).toBe(`DNS:${irohHostname(OTHER_ENDPOINT)}`)
    const future = Date.now() + (IROH_LEAF_VALIDITY_DAYS - IROH_LEAF_RENEW_BEFORE_DAYS + 1) * 86_400_000
    const renewed = await ensureIrohTls(OTHER_ENDPOINT, stateFile, root, future)
    expect(renewed.leaf.raw.equals(moved.leaf.raw)).toBe(false)
    expect(renewed.caFingerprint).toBe(first.caFingerprint)
  })

  it('fails closed on corrupt or foreign material', async () => {
    const { root, stateFile } = await fixtureRoot()
    await ensureIrohTls(ENDPOINT, stateFile, root)
    const paths = irohTlsPaths(stateFile, root)
    await writeFile(paths.caCertFile, 'not a certificate')
    await expect(ensureIrohTls(ENDPOINT, stateFile, root)).rejects.toThrow('iroh_tls_ca_invalid')
    const fresh = await fixtureRoot()
    await ensureIrohTls(ENDPOINT, fresh.stateFile, fresh.root)
    const freshPaths = irohTlsPaths(fresh.stateFile, fresh.root)
    await writeFile(freshPaths.statusFile, JSON.stringify({ version: 1, endpointId: ENDPOINT, caFingerprint: '0'.repeat(64) }))
    await expect(ensureIrohTls(ENDPOINT, fresh.stateFile, fresh.root)).rejects.toThrow('iroh_tls_ca_invalid')
  })

  it('builds an endpoint-pinned provided-TLS gateway config', async () => {
    const { root, stateFile } = await fixtureRoot()
    const tls = await ensureIrohTls(ENDPOINT, stateFile, root)
    const template = { pairingCaFile: undefined, instanceId: 'plugin-wide' } as unknown as ResolvedGatewayConfig
    const config = irohGatewayConfig(template, ENDPOINT, stateFile, tls)
    expect(config.listenHost).toBe('127.0.0.1')
    expect(config.instanceId).toBe(tls.caFingerprint)
    expect(config.pairingCaFile).toBe(tls.paths.caCertFile)
    expect(config.tls).toMatchObject({ mode: 'provided', certFile: tls.paths.certFile, keyFile: tls.paths.keyFile })
    expect(config.publicTls).toBe(true)
    expect(config.discovery).toBe(false)
    // The gateway must admit the controller's five-minute pairing windows.
    expect(config.pairingTtlMs).toBe(300_000)
    const authorities = config.authorities as readonly { hostname: string; port?: number }[]
    expect(authorities).toHaveLength(1)
    expect(`${authorities[0]?.hostname}:${String(authorities[0]?.port)}`).toBe(new URL(`https://${irohHostname(ENDPOINT)}:25443`).host)
    expect(config.stateFile).toBe(stateFile)
  })
})
