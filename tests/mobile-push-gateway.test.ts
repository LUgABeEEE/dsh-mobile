import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as requestHttp, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessGateway } from '../src/gateway.js'
import type { PushGatewayService } from '../src/mobile-push/gateway.js'
import type { PushEnrollment, PushEnrollmentResult, PushMutationGuard, PushOwner, PushPreferences, PushRegistration, PushTarget } from '../src/mobile-push/contracts.js'
import { CSRF_HEADER, SESSION_COOKIE } from '../src/http-security.js'
import { MemoryDeviceStore } from '../src/storage.js'

interface HttpResult {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
  readonly rawBody: Buffer
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return (server.address() as { port: number }).port
}

async function request(port: number, path: string, options: {
  method?: string
  headers?: Record<string, string>
  body?: string
} = {}): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const headers = { ...options.headers }
    if (options.body !== undefined) headers['content-length'] ??= String(Buffer.byteLength(options.body))
    const outgoing = requestHttp({
      host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers, agent: false,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('error', reject)
      response.once('end', () => {
        const rawBody = Buffer.concat(chunks)
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: rawBody.toString('utf8'), rawBody })
      })
    })
    outgoing.once('error', reject)
    outgoing.end(options.body)
  })
}

function cookies(headers: IncomingHttpHeaders): Map<string, string> {
  const result = new Map<string, string>()
  for (const value of headers['set-cookie'] ?? []) {
    const pair = value.split(';', 1)[0] ?? ''
    const split = pair.indexOf('=')
    if (split > 0) result.set(pair.slice(0, split), pair.slice(split + 1))
  }
  return result
}

async function fixture(
  overrides: Partial<PushGatewayService> = {},
  options: {
    readonly allowedCidrs?: readonly string[]
    readonly pairFromDisallowedAddress?: boolean
    readonly stateFile?: string
  } = {},
): Promise<{
  readonly gateway: MobileAccessGateway
  readonly push: PushGatewayService
  readonly paired: { readonly deviceId: string; readonly session: string; readonly csrf: string }
  readonly headers: Record<string, string>
}> {
  const upstream = createServer((_request, response) => { response.writeHead(200); response.end('upstream') })
  const upstreamPort = await listen(upstream)
  cleanups.push(async () => {
    if (!upstream.listening) return
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
  })
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-push-gateway-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const config = parseGatewayConfig({
    listenHost: '127.0.0.1', listenPort: 0,
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    publicAuthorities: ['127.0.0.1'], allowedCidrs: options.allowedCidrs ?? ['127.0.0.0/8'],
    stateFile: options.stateFile ?? join(directory, 'mobile-access.json'),
    tls: { mode: 'disabled' },
  })
  const push: PushGatewayService = {
    config: vi.fn(async (_owner: PushOwner, installationId: string) => ({
      available: true, publicKey: 'public-key', keyFingerprint: 'fingerprint', installationId,
      ownerGeneration: 3, registrationGeneration: 4, status: 'enabled' as const,
      preferences: { question: true, plan: true, approval: true, response: true, goal: true, failure: true },
    })),
    enroll: vi.fn(async (_owner: PushOwner, _input: PushEnrollment): Promise<PushEnrollmentResult> => { throw new Error('push enrollment unavailable') }),
    preferences: vi.fn(async (_owner: PushOwner, _installationId: string, _value: PushPreferences, _guard: PushMutationGuard): Promise<PushRegistration> => { throw new Error('push preferences unavailable') }),
    disable: vi.fn(async (_owner: PushOwner, _installationId: string, _ifGeneration?: number) => undefined),
    logout: vi.fn(async (_owner: PushOwner) => undefined),
    test: vi.fn(async (_owner: PushOwner, _installationId: string) => undefined),
    resolve: vi.fn(async (_owner: PushOwner, _reference: string): Promise<PushTarget | undefined> => undefined),
    ...overrides,
  }
  type GatewayWithPush = new (...args: unknown[]) => MobileAccessGateway
  const GatewayWithOptionalPush = MobileAccessGateway as unknown as GatewayWithPush
  const gateway = new GatewayWithOptionalPush(
    config, new MemoryDeviceStore(), undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, push,
  )
  await gateway.start()
  cleanups.push(() => gateway.close())
  const origin = gateway.address().origin
  const opened = await gateway.access.openPairing()
  let paired: { deviceId: string; session: string; csrf: string }
  if (options.pairFromDisallowedAddress) {
    const result = await gateway.access.pair('192.0.2.1', opened.token, 'Push test device')
    paired = { deviceId: result.deviceId, session: result.sessionToken, csrf: result.csrfToken }
  } else {
    const pairing = await request(gateway.address().port, '/mobile-access/auth/pair', {
      method: 'POST',
      headers: { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: opened.token, label: 'Push test device' }),
    })
    expect(pairing.status).toBe(201)
    const pairingBody = JSON.parse(pairing.body) as { deviceId: string; csrfToken: string }
    const issued = cookies(pairing.headers)
    paired = { deviceId: pairingBody.deviceId, session: issued.get(SESSION_COOKIE) ?? '', csrf: pairingBody.csrfToken }
  }
  const headers = {
    host: new URL(origin).host,
    origin,
    'sec-fetch-site': 'same-origin',
    cookie: `${SESSION_COOKIE}=${paired.session}`,
    'content-type': 'application/json',
  }
  return { gateway, push, paired, headers }
}

const installationId = '11111111-1111-4111-8111-111111111111'
const csrf = (token: string): Record<string, string> => ({ [CSRF_HEADER]: token })
const pushPreferences: PushPreferences = {
  question: true, plan: false, approval: true, response: true, goal: false, failure: true,
}
function validSubscriptionKeys() {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' })
  return {
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  }
}
const validEnrollment: PushEnrollment = {
  installationId,
  subscription: {
    endpoint: 'https://web.push.apple.com/device-token',
    keys: validSubscriptionKeys(),
  },
  locale: 'en', preferences: pushPreferences, keyFingerprint: 'public-fingerprint',
  ownerGeneration: 3, registrationGeneration: 4,
}
function registration(owner: PushOwner, enrollment: PushEnrollment): PushRegistration {
  return {
    ...owner, installationId: enrollment.installationId, subscription: enrollment.subscription,
    locale: enrollment.locale, preferences: enrollment.preferences, generation: 5,
    keyFingerprint: enrollment.keyFingerprint, enabled: true, health: 'ready',
  }
}

describe('authenticated mobile push HTTP protocol', () => {
  it('requires an authenticated session for public config and exposes no private snapshot data', async () => {
    const { gateway, headers } = await fixture()
    const anonymous = await request(gateway.address().port, `/mobile-access/push/config?installationId=${installationId}`, {
      headers: { ...headers, cookie: '' },
    })
    expect(anonymous.status).toBe(401)

    const authenticated = await request(gateway.address().port, `/mobile-access/push/config?installationId=${installationId}`, { headers })
    expect(authenticated.status).toBe(200)
    const config = JSON.parse(authenticated.body) as Record<string, unknown>
    expect(config).toMatchObject({ available: true, installationId, ownerGeneration: 3, registrationGeneration: 4, status: 'enabled' })
    expect(authenticated.body).not.toMatch(/privateKey|ownerGenerationFloor|endpoint|subscription/i)
  })

  it('serves only fixed credential-free push assets before pairing while config remains authenticated', async () => {
    const { gateway, headers } = await fixture()
    const anonymous = { ...headers, cookie: '' }
    const manifest = await request(gateway.address().port, '/mobile-access/push/manifest.webmanifest', { headers: anonymous })
    expect(manifest.status).toBe(200)
    expect(manifest.headers['set-cookie']).toBeUndefined()
    expect(manifest.headers['content-type']).toContain('application/manifest+json')
    const metadata = JSON.parse(manifest.body) as Record<string, unknown>
    expect(metadata).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone' })
    expect(manifest.body).not.toMatch(/token|credential|mobile-push=|reference/i)
    for (const [path, size] of [
      ['/mobile-access/push/icon-180.png', 180],
      ['/mobile-access/push/icon-192.png', 192],
      ['/mobile-access/push/icon-512.png', 512],
    ] as const) {
      const icon = await request(gateway.address().port, path, { headers: anonymous })
      expect(icon.status).toBe(200)
      expect(icon.headers['set-cookie']).toBeUndefined()
      expect(icon.headers['content-type']).toBe('image/png')
      expect(icon.rawBody.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(icon.rawBody.readUInt32BE(16)).toBe(size)
      expect(icon.rawBody.readUInt32BE(20)).toBe(size)
    }
    const config = await request(gateway.address().port, `/mobile-access/push/config?installationId=${installationId}`, { headers: anonymous })
    expect(config.status).toBe(401)
  })

  it('rejects wrong Host, wrong Origin and missing CSRF before invoking a push mutation', async () => {
    const { gateway, push, paired, headers } = await fixture()
    const path = '/mobile-access/push/disable'
    const body = JSON.stringify({ installationId })
    const wrongHost = await request(gateway.address().port, path, {
      method: 'POST', headers: { ...headers, host: 'attacker.example', ...csrf(paired.csrf) }, body,
    })
    expect(wrongHost.status).toBe(403)
    const wrongOrigin = await request(gateway.address().port, path, {
      method: 'POST', headers: { ...headers, origin: 'https://attacker.example', ...csrf(paired.csrf) }, body,
    })
    expect(wrongOrigin.status).toBe(403)
    const noCsrf = await request(gateway.address().port, path, { method: 'POST', headers, body })
    expect(noCsrf.status).toBe(403)
    expect(push.disable).not.toHaveBeenCalled()
  })

  it('rejects request-supplied owner, scope, origin and unknown fields rather than accepting an ownership override', async () => {
    const { gateway, push, paired, headers } = await fixture()
    const response = await request(gateway.address().port, '/mobile-access/push/disable', {
      method: 'POST', headers: { ...headers, ...csrf(paired.csrf) },
      body: JSON.stringify({ installationId, deviceId: 'attacker-device', scopeId: 'attacker-scope', origin: 'https://attacker.example' }),
    })
    expect(response.status).toBe(400)
    expect(push.disable).not.toHaveBeenCalled()
  })

  it('bounds actual HTTP bodies and requires JSON content type on mutation routes', async () => {
    const { gateway, push, paired, headers } = await fixture()
    const route = '/mobile-access/push/preferences'
    const missingContentType = await request(gateway.address().port, route, {
      method: 'POST', headers: { ...headers, 'content-type': 'text/plain', ...csrf(paired.csrf) }, body: '{}',
    })
    expect(missingContentType.status).toBe(415)
    const malformed = await request(gateway.address().port, route, {
      method: 'POST', headers: { ...headers, ...csrf(paired.csrf) }, body: '{broken',
    })
    expect(malformed.status).toBe(400)
    const oversized = await request(gateway.address().port, route, {
      method: 'POST', headers: { ...headers, ...csrf(paired.csrf) }, body: JSON.stringify({ padding: 'x'.repeat(16 * 1024) }),
    })
    expect(oversized.status).toBe(413)
    expect(push.preferences).not.toHaveBeenCalled()
  })

  it('persists push disable before logout cookies are cleared', async () => {
    const disableError = new Error('private store path /private/push.json failed')
    const { gateway, push, paired, headers } = await fixture({ logout: vi.fn(async () => { throw disableError }) })
    const response = await request(gateway.address().port, '/mobile-access/auth/logout', {
      method: 'POST', headers: { ...headers, ...csrf(paired.csrf) }, body: '{}',
    })
    expect(push.logout).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(500)
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.body).not.toContain(disableError.message)
  })

  it('dispatches an enrollment under the authenticated owner and preserves owned-write versus idempotent results', async () => {
    const enroll = vi.fn(async (owner: PushOwner, input: PushEnrollment) => ({
      registration: registration(owner, input),
      ...(enroll.mock.calls.length === 1 ? { mutationGeneration: 5 } : {}),
    }))
    const { gateway, paired, headers } = await fixture({ enroll })
    const path = '/mobile-access/push/subscription'
    const sendEnrollment = () => request(gateway.address().port, path, {
      method: 'POST', headers: { ...headers, ...csrf(paired.csrf), 'x-forwarded-host': 'attacker.example' },
      body: JSON.stringify(validEnrollment),
    })

    const first = await sendEnrollment()
    expect([200, 201]).toContain(first.status)
    expect(JSON.parse(first.body)).toMatchObject({ mutationGeneration: 5, registration: { installationId, enabled: true } })
    const owner = enroll.mock.calls[0]?.[0]
    expect(owner).toMatchObject({ deviceId: paired.deviceId, origin: gateway.address().origin })
    expect(owner?.scopeId).toBe(gateway.config.stateFile)

    const repeated = await sendEnrollment()
    expect([200, 201]).toContain(repeated.status)
    expect(JSON.parse(repeated.body)).toMatchObject({ registration: { installationId, enabled: true } })
    expect(JSON.parse(repeated.body)).not.toHaveProperty('mutationGeneration')
    expect(enroll).toHaveBeenCalledTimes(2)
  })

  it('keeps enrollment failures generic and does not leak endpoint ownership details', async () => {
    const endpointConflict = new Error('subscription endpoint is already owned by device secret-device-id')
    const enroll = vi.fn(async () => { throw endpointConflict })
    const { gateway, paired, headers } = await fixture({ enroll })
    const response = await request(gateway.address().port, '/mobile-access/push/subscription', {
      method: 'POST', headers: { ...headers, ...csrf(paired.csrf) }, body: JSON.stringify(validEnrollment),
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(600)
    expect(enroll).toHaveBeenCalledTimes(1)
    expect(response.body).not.toContain(endpointConflict.message)
    expect(response.body).not.toContain('secret-device-id')
  })

  it('applies preferences with the submitted generation guard and rejects replay without changing the body', async () => {
    const stale = new Error('stale push mutation generation')
    const preferences = vi.fn(async (_owner: PushOwner, _installationId: string, _value: PushPreferences, _guard: PushMutationGuard): Promise<PushRegistration> => { throw stale })
    const { gateway, paired, headers } = await fixture({ preferences })
    const body = { installationId, preferences: pushPreferences, ownerGeneration: 3, registrationGeneration: 4 }
    const response = await request(gateway.address().port, '/mobile-access/push/preferences', {
      method: 'POST', headers: { ...headers, ...csrf(paired.csrf) }, body: JSON.stringify(body),
    })
    expect(response.status).toBe(409)
    expect(response.body).not.toContain(stale.message)
    expect(preferences).toHaveBeenCalledTimes(1)
    expect(preferences.mock.calls[0]?.[1]).toBe(installationId)
    expect(preferences.mock.calls[0]?.[2]).toEqual(pushPreferences)
    expect(preferences.mock.calls[0]?.[3]).toEqual({ ownerGeneration: 3, registrationGeneration: 4 })
  })

  it('makes explicit disable unconditional, and only forwards a generation for conditional cleanup', async () => {
    const disable = vi.fn(async (_owner: PushOwner, _installationId: string, _ifGeneration?: number) => undefined)
    const { gateway, paired, headers } = await fixture({ disable })
    const send = (body: Record<string, unknown>) => request(gateway.address().port, '/mobile-access/push/disable', {
      method: 'POST', headers: { ...headers, ...csrf(paired.csrf) }, body: JSON.stringify(body),
    })
    const explicit = await send({ installationId })
    expect(explicit.status).toBe(200)
    expect(disable.mock.calls[0]).toEqual([expect.objectContaining({ deviceId: paired.deviceId }), installationId, undefined])

    const cleanup = await send({ installationId, ifGeneration: 12 })
    expect(cleanup.status).toBe(200)
    expect(disable.mock.calls[1]?.[1]).toBe(installationId)
    expect(disable.mock.calls[1]?.[2]).toBe(12)
    expect(disable).toHaveBeenCalledTimes(2)
  })

  it('waits for the provider-accepted test send and throttles overlapping attempts per installation', async () => {
    let release!: () => void
    const accepted = new Promise<void>(resolve => { release = resolve })
    const testPush = vi.fn(async () => accepted)
    const { gateway, paired, headers } = await fixture({ test: testPush })
    const send = () => request(gateway.address().port, '/mobile-access/push/test', {
      method: 'POST', headers: { ...headers, ...csrf(paired.csrf) }, body: JSON.stringify({ installationId }),
    })
    const first = send()
    await vi.waitFor(() => expect(testPush).toHaveBeenCalledTimes(1), { timeout: 250 })
    const second = await send()
    expect(second.status).toBe(429)
    let completed = false
    void first.then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    release()
    expect((await first).status).toBe(200)
    expect(testPush).toHaveBeenCalledTimes(1)
  })

  it('returns a neutral missing result for a reference not owned by the authenticated device', async () => {
    const resolve = vi.fn(async (_owner: PushOwner, _reference: string) => undefined)
    const { gateway, paired, headers } = await fixture({ resolve })
    const secondWindow = await gateway.access.openPairing()
    const secondPair = await request(gateway.address().port, '/mobile-access/auth/pair', {
      method: 'POST', headers: { ...headers, cookie: '', 'content-type': 'application/json' },
      body: JSON.stringify({ token: secondWindow.token, label: 'Other device' }),
    })
    expect(secondPair.status).toBe(201)
    const anotherDevice = cookies(secondPair.headers).get(SESSION_COOKIE)
    const denied = await request(gateway.address().port, '/mobile-access/push/resolve', {
      method: 'POST',
      headers: { ...headers, cookie: `${SESSION_COOKIE}=${anotherDevice}`, ...csrf(JSON.parse(secondPair.body).csrfToken as string) },
      body: JSON.stringify({ reference: 'opaque-reference-secret' }),
    })
    const missing = await request(gateway.address().port, '/mobile-access/push/resolve', {
      method: 'POST', headers: { ...headers, ...csrf(paired.csrf) },
      body: JSON.stringify({ reference: 'opaque-reference-secret' }),
    })
    expect(denied.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(denied.body).not.toContain('opaque-reference-secret')
    expect(denied.body).not.toContain(paired.deviceId)
    expect(JSON.parse(denied.body)).toEqual(JSON.parse(missing.body))
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(resolve.mock.calls[0]?.[0].deviceId).not.toBe(paired.deviceId)
  })

  it('rejects push HTTP requests from a disallowed source CIDR even with a valid session', async () => {
    const { gateway, paired, headers } = await fixture({}, {
      allowedCidrs: ['192.0.2.0/24'], pairFromDisallowedAddress: true,
    })
    const response = await request(gateway.address().port, `/mobile-access/push/config?installationId=${installationId}`, { headers })
    expect(response.status).toBe(403)
    expect(response.body).not.toContain(paired.deviceId)
  })

  it('scopes opaque references to the exact canonical origin when authorization scope is shared', async () => {
    let originWithReference: string | undefined
    const resolve = vi.fn(async (owner: PushOwner, _reference: string) => owner.origin === originWithReference
      ? { sessionId: 'owned-session', interaction: 'current' as const }
      : undefined)
    const first = await fixture({ resolve })
    originWithReference = first.gateway.address().origin
    const firstResult = await request(first.gateway.address().port, '/mobile-access/push/resolve', {
      method: 'POST', headers: { ...first.headers, ...csrf(first.paired.csrf) },
      body: JSON.stringify({ reference: 'same-opaque-reference' }),
    })
    expect(firstResult.status).toBe(200)
    expect(firstResult.body).toContain('owned-session')

    const second = await fixture({ resolve }, { stateFile: first.gateway.config.stateFile })
    expect(second.gateway.address().origin).not.toBe(first.gateway.address().origin)
    const secondResult = await request(second.gateway.address().port, '/mobile-access/push/resolve', {
      method: 'POST', headers: { ...second.headers, ...csrf(second.paired.csrf) },
      body: JSON.stringify({ reference: 'same-opaque-reference' }),
    })
    expect(secondResult.status).toBe(404)
    expect(secondResult.body).not.toContain('owned-session')
    expect(secondResult.body).not.toContain('same-opaque-reference')
    expect(JSON.parse(secondResult.body)).toEqual({ error: 'not_found' })
    expect(resolve.mock.calls[0]?.[0].scopeId).toBe(resolve.mock.calls[1]?.[0].scopeId)
    expect(resolve.mock.calls[0]?.[0].origin).not.toBe(resolve.mock.calls[1]?.[0].origin)
  })
})
