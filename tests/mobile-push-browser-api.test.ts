import { describe, expect, it, vi } from 'vitest'
import { createMobilePushBrowserApi, type MobilePushRequest } from '../src/mobile-push/browser-api.js'
import type { MobilePushApiAdapter } from '../src/mobile-push/client.js'
import type { PushEnrollment, PushEnrollmentResult, PushPreferences, PushTarget } from '../src/mobile-push/contracts.js'

const preferences: PushPreferences = { question: true, plan: true, approval: false, response: true, goal: true, failure: true }
const enrollment: PushEnrollment = {
  installationId: 'install-id', ownerGeneration: 4, registrationGeneration: 8, keyFingerprint: 'fingerprint',
  locale: 'en', preferences,
  subscription: { endpoint: 'https://push.example/sub', keys: { p256dh: 'p256dh', auth: 'auth' } },
}
const result: PushEnrollmentResult = {
  registration: {
    scopeId: 'scope', deviceId: 'device', origin: 'https://example.test', installationId: 'install-id',
    subscription: enrollment.subscription, locale: 'en', preferences, generation: 9,
    keyFingerprint: 'fingerprint', enabled: true, health: 'ready',
  }, mutationGeneration: 9,
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function adapter(request: MobilePushRequest = vi.fn<MobilePushRequest>(async () => response({}))): { api: MobilePushApiAdapter & { resolve(reference: string): Promise<PushTarget | undefined> }; request: MobilePushRequest } {
  return { api: createMobilePushBrowserApi(request), request }
}

describe('authenticated mobile push browser HTTP adapter', () => {
  it('reads direct config JSON at the URL-encoded installation query', async () => {
    const config = { available: true, installationId: 'install /?', ownerGeneration: 0, registrationGeneration: 0, status: 'disabled', preferences }
    const { api, request } = adapter(vi.fn(async () => response(config)))
    await expect(api.getConfig('install /?')).resolves.toEqual(config)
    expect(request).toHaveBeenCalledExactlyOnceWith('/mobile-access/push/config?installationId=install%20%2F%3F', { method: 'GET', signal: undefined })
  })

  it('sends each mutation once with its frozen route and payload', async () => {
    const request = vi.fn(async () => response({}))
    const { api } = adapter(request)
    await api.enroll(enrollment)
    await api.updatePreferences({ installationId: enrollment.installationId, preferences, ownerGeneration: 4, registrationGeneration: 8 })
    await api.disable({ installationId: enrollment.installationId })
    await api.disable({ installationId: enrollment.installationId, ifGeneration: 9 })
    await api.sendTest({ installationId: enrollment.installationId, ownerGeneration: 4, registrationGeneration: 8 })
    await expect(api.resolve('opaque/ref')).resolves.toBeUndefined()
    const calls = request.mock.calls as unknown as Array<[string, RequestInit | undefined]>
    expect(calls.map(([path, init]) => [path, init?.method, init?.body && JSON.parse(String(init.body))])).toEqual([
      ['/mobile-access/push/subscription', 'POST', enrollment],
      ['/mobile-access/push/preferences', 'POST', { installationId: 'install-id', preferences, ownerGeneration: 4, registrationGeneration: 8 }],
      ['/mobile-access/push/disable', 'POST', { installationId: 'install-id' }],
      ['/mobile-access/push/disable', 'POST', { installationId: 'install-id', ifGeneration: 9 }],
      ['/mobile-access/push/test', 'POST', { installationId: 'install-id' }],
      ['/mobile-access/push/resolve', 'POST', { reference: 'opaque/ref' }],
    ])
    expect(request).toHaveBeenCalledTimes(6)
  })

  it.each(['enroll', 'preferences', 'disable', 'test', 'resolve'] as const)('does not retry %s after a 401 or 409 response', async operation => {
    const request = vi.fn(async () => response({ error: 'stale_generation', detail: 'private provider response' }, 409))
    const { api } = adapter(request)
    const invoke = async (): Promise<unknown> => {
      switch (operation) {
        case 'enroll': return api.enroll(enrollment)
        case 'preferences': return api.updatePreferences({ installationId: 'install-id', preferences, ownerGeneration: 1, registrationGeneration: 2 })
        case 'disable': return api.disable({ installationId: 'install-id', ifGeneration: 9 })
        case 'test': return api.sendTest({ installationId: 'install-id', ownerGeneration: 1, registrationGeneration: 2 })
        case 'resolve': return api.resolve('opaque')
      }
    }
    await expect(invoke()).rejects.toMatchObject({ code: 'stale_generation' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('converts non-stale HTTP and network errors to generic safe errors', async () => {
    const http = adapter(vi.fn(async () => response({ error: 'some_private_code', detail: 'provider secret' }, 401)))
    await expect(http.api.sendTest({ installationId: 'install-id', ownerGeneration: 1, registrationGeneration: 2 })).rejects.toMatchObject({ code: 'request_failed' })
    const network = adapter(vi.fn(async () => { throw new Error('secret transport detail') }))
    await expect(network.api.disable({ installationId: 'install-id' })).rejects.toMatchObject({ code: 'request_failed' })
    expect(http.request).toHaveBeenCalledTimes(1)
    expect(network.request).toHaveBeenCalledTimes(1)
  })
})
