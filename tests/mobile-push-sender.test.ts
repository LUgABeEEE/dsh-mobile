import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { RequestOptions as HttpsRequestOptions } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { buildDeclarativePayload } from '../src/mobile-push/payload.js'
import { createVapidKeys, PushSender } from '../src/mobile-push/sender.js'
import { canonicalPushEndpoint, resolveAppleEndpoint, validatePushSubscription } from '../src/mobile-push/endpoint.js'
import type { PushRegistration } from '../src/mobile-push/contracts.js'

const GENERATOR_POINT = 'BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU'
const AUTH_KEY = 'AAAAAAAAAAAAAAAAAAAAAA'
const ENDPOINT = 'https://web.push.apple.com/opaque-token'
const subscription = { endpoint: ENDPOINT, keys: { p256dh: GENERATOR_POINT, auth: AUTH_KEY } }

class FakeRequest extends EventEmitter {
  destroyed = false
  body: Buffer | undefined
  response: Readable | undefined
  constructor(private readonly onEnd: (request: FakeRequest) => void) { super() }
  end(body?: Buffer): this { this.body = body; this.onEnd(this); return this }
  destroy(error?: Error): this {
    this.destroyed = true
    this.response?.destroy(error)
    if (error) this.emit('error', error)
    return this
  }
}

function response(statusCode: number, headers: IncomingMessage['headers'] = {}, chunks: readonly Buffer[] = []): Readable {
  const result = new Readable({ read() {} })
  Object.defineProperties(result, { statusCode: { value: statusCode }, headers: { value: headers } })
  queueMicrotask(() => { for (const chunk of chunks) result.push(chunk); result.push(null) })
  return result
}

const registration = {
  scopeId: 'scope', deviceId: 'device', installationId: 'install', origin: 'https://100.64.0.5',
  subscription, locale: 'en',
  preferences: { question: true, plan: true, approval: true, response: true, goal: true, failure: true },
  generation: 1, keyFingerprint: 'fingerprint', enabled: true, health: 'ready',
} satisfies PushRegistration

function input(signal = new AbortController().signal) {
  return {
    registration,
    payload: buildDeclarativePayload('question', 'en', '/?mobile-push=opaque-123', 'test-tag'),
    ttlSeconds: 60,
    subject: '',
    keys: createVapidKeys(),
    signal,
  }
}

function senderFor(status: number, headers: IncomingMessage['headers'] = {}, body: readonly Buffer[] = [], options: { timeout?: number } = {}) {
  let requestCount = 0
  let lastUrl: URL | undefined
  let lastOptions: HttpsRequestOptions | undefined
  let lastRequest: FakeRequest | undefined
  const sender = new PushSender({
    ...(options.timeout === undefined ? {} : { attemptTimeoutMs: options.timeout }),
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    request: (url, requestOptions) => {
      requestCount++
      lastUrl = url
      lastOptions = requestOptions
      lastRequest = new FakeRequest(request => {
        request.response = response(status, headers, body)
        queueMicrotask(() => request.emit('response', request.response))
      })
      return lastRequest as unknown as ClientRequest
    },
  })
  return { sender, requestCount: () => requestCount, get url() { return lastUrl }, get options() { return lastOptions }, get request() { return lastRequest } }
}

describe('Apple Web Push endpoint validation', () => {
  it('canonicalizes WHATWG URL identity without applying push policy', () => {
    expect(canonicalPushEndpoint('https://PUSH.APPLE.COM:443/opaque-token')).toBe('https://push.apple.com/opaque-token')
    expect(canonicalPushEndpoint('https://other.example:443')).toBe('https://other.example/')
    let errorMessage = ''
    try { canonicalPushEndpoint('not a URL with sensitive text') } catch (error) { errorMessage = (error as Error).message }
    expect(errorMessage).toBe('push_endpoint_invalid')
  })

  it('accepts a valid Apple endpoint and canonical uncompressed P-256 subscription keys', () => {
    expect(validatePushSubscription(subscription)).toEqual(subscription)
  })

  it('normalizes endpoint identity for WHATWG-equivalent Apple URLs', () => {
    for (const endpoint of [
      'https://WEB.PUSH.APPLE.COM/opaque-token',
      'https://web.push.apple.com:443/opaque-token',
    ]) {
      expect(validatePushSubscription({ ...subscription, endpoint }).endpoint).toBe(ENDPOINT)
    }
  })

  it('rejects non-Apple, non-HTTPS, ambiguous and oversized endpoint URLs', () => {
    const invalid = [
      'http://web.push.apple.com/token',
      'https://127.0.0.1/token',
      'https://user:pass@web.push.apple.com/token',
      'https://@web.push.apple.com/token',
      'https://web.push.apple.com/token#',
      'https://web.push.apple.com:444/token',
      'https://web.push.apple.com/token#fragment',
      'https://push.apple.com/token',
      'https://web.push.apple.com.attacker.example/token',
      'https://attackerpush.apple.com/token',
      'https://web.push.apple.com',
      `https://web.push.apple.com/${'a'.repeat(2048)}`,
      `https://web.push.apple.com/${'é'.repeat(350)}`,
    ]
    for (const endpoint of invalid) expect(() => validatePushSubscription({ ...subscription, endpoint })).toThrow()
  })

  it('rejects every non-global DNS answer, including IPv4-mapped IPv6', async () => {
    const forbidden = [
      { address: '127.0.0.1', family: 4 },
      { address: '10.1.2.3', family: 4 },
      { address: '169.254.1.2', family: 4 },
      { address: '203.0.113.4', family: 4 },
      { address: '::1', family: 6 },
      { address: 'fc00::1', family: 6 },
      { address: 'fe80::1', family: 6 },
      { address: '::ffff:127.0.0.1', family: 6 },
      { address: '2001:db8::1', family: 6 },
      { address: '2001::1', family: 6 },
      { address: '2002::1', family: 6 },
      { address: '3fff::1', family: 6 },
    ] as const
    for (const answer of forbidden) {
      await expect(resolveAppleEndpoint(ENDPOINT, async () => [answer])).rejects.toThrow()
    }
    const vetted = await resolveAppleEndpoint(ENDPOINT, async () => [
      { address: '17.0.0.1', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ])
    expect(vetted.addresses).toHaveLength(2)
  })

  it('rejects malformed base64url, off-curve or wrong-length P-256 keys and invalid auth keys', () => {
    const malformed = [
      { p256dh: 'not+base64/', auth: AUTH_KEY },
      { p256dh: Buffer.from([4, ...new Array(64).fill(0)]).toString('base64url'), auth: AUTH_KEY },
      { p256dh: Buffer.alloc(64, 1).toString('base64url'), auth: AUTH_KEY },
      { p256dh: GENERATOR_POINT, auth: 'not-base64url' },
      { p256dh: GENERATOR_POINT, auth: Buffer.alloc(15, 1).toString('base64url') },
      { p256dh: GENERATOR_POINT, auth: Buffer.alloc(17, 1).toString('base64url') },
    ]
    for (const keys of malformed) expect(() => validatePushSubscription({ endpoint: ENDPOINT, keys })).toThrow()
  })
})

describe('bounded Apple Web Push sender', () => {
  it('encrypts and signs with web-push, and pins the vetted connection while preserving Apple TLS identity', async () => {
    const fixture = senderFor(201)
    const result = await fixture.sender.send(input())
    expect(result).toEqual({ kind: 'accepted' })
    expect(fixture.requestCount()).toBe(1)
    expect(fixture.url?.hostname).toBe('web.push.apple.com')
    expect(fixture.options?.servername).toBe('web.push.apple.com')
    expect(fixture.options?.rejectUnauthorized).toBe(true)
    expect(fixture.options?.agent).toBe(false)
    const headers = fixture.options?.headers as Record<string, string>
    expect(headers.Authorization).toMatch(/^vapid /iu)
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    expect(fixture.request?.body).toBeInstanceOf(Buffer)
    expect(fixture.request?.body?.toString('utf8')).not.toContain('Input requested')
    const pinned = await new Promise<string>((resolve, reject) => {
      const lookup = fixture.options?.lookup as (host: string, options: object, callback: (error: Error | null, address?: string) => void) => void
      lookup('web.push.apple.com', {}, (error, address) => error ? reject(error) : resolve(address!))
    })
    expect(pinned).toBe('8.8.8.8')
    await expect(new Promise<void>((resolve, reject) => {
      const lookup = fixture.options?.lookup as (host: string, options: object, callback: (error: Error | null) => void) => void
      lookup('attacker.example', {}, error => error ? resolve() : reject(new Error('unvetted hostname accepted')))
    })).resolves.toBeUndefined()
  })

  it.each([
    [200, 'accepted'], [404, 'gone'], [410, 'gone'], [401, 'suspended'], [403, 'suspended'],
    [429, 'retry'], [500, 'retry'], [302, 'permanent'], [400, 'permanent'],
  ] as const)('maps HTTP %i to a redacted %s result', async (status, kind) => {
    const fixture = senderFor(status, { 'content-type': 'text/plain' }, [Buffer.from('private response detail')])
    const result = await fixture.sender.send(input())
    expect(result).toEqual({ kind })
    expect(JSON.stringify(result)).not.toContain('private response detail')
    expect(fixture.requestCount()).toBe(1)
  })

  it('does not follow a redirect to an attacker-controlled URL', async () => {
    const fixture = senderFor(307, { location: 'http://127.0.0.1/admin' })
    expect(await fixture.sender.send(input())).toEqual({ kind: 'permanent' })
    expect(fixture.requestCount()).toBe(1)
  })

  it('rejects an unsafe DNS answer before invoking the HTTPS request boundary', async () => {
    const request = vi.fn()
    const sender = new PushSender({ resolve: async () => [{ address: '127.0.0.1', family: 4 }], request })
    expect(await sender.send(input())).toEqual({ kind: 'permanent' })
    expect(request).not.toHaveBeenCalled()
  })

  it('honors Retry-After only when it fits the original remaining freshness', async () => {
    const valid = senderFor(429, { 'retry-after': '15' })
    expect(await valid.sender.send(input())).toEqual({ kind: 'retry', retryAfterMs: 15_000 })
    const beyondTtl = senderFor(429, { 'retry-after': '61' })
    expect(await beyondTtl.sender.send(input())).toEqual({ kind: 'permanent' })
  })

  it('aborts a slow-trickling response at the absolute deadline and destroys its owned request', async () => {
    let request: FakeRequest | undefined
    const sender = new PushSender({
      attemptTimeoutMs: 60,
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      request: () => {
        request = new FakeRequest(current => {
          const stream = new Readable({ read() {} })
          Object.defineProperties(stream, { statusCode: { value: 200 }, headers: { value: {} } })
          current.response = stream
          queueMicrotask(() => current.emit('response', stream))
          const timer = setInterval(() => stream.push(Buffer.from('x')), 8)
          stream.once('close', () => clearInterval(timer))
        })
        return request as unknown as ClientRequest
      },
    })
    const started = Date.now()
    const result = await sender.send(input())
    expect(result).toEqual({ kind: 'retry' })
    expect(Date.now() - started).toBeLessThan(500)
    expect(request?.destroyed).toBe(true)
  })

  it('cancels before opening a socket when the caller aborts during DNS resolution', async () => {
    const request = vi.fn()
    let finishLookup!: () => void
    const sender = new PushSender({
      resolve: () => new Promise(resolve => { finishLookup = () => resolve([{ address: '8.8.8.8', family: 4 }]) }),
      request,
    })
    const controller = new AbortController()
    const pending = sender.send(input(controller.signal))
    controller.abort()
    expect(await pending).toEqual({ kind: 'retry' })
    finishLookup()
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects oversized payloads and caps response streams without losing 2xx acceptance', async () => {
    const oversizedPayload = input()
    oversizedPayload.payload = JSON.stringify({ web_push: 8030, notification: { title: 'x', body: 'z'.repeat(3100), lang: 'en', navigate: '/?mobile-push=x', tag: 't' } })
    const unused = senderFor(200)
    expect(await unused.sender.send(oversizedPayload)).toEqual({ kind: 'permanent' })
    expect(unused.requestCount()).toBe(0)

    const forbiddenSchema = input()
    forbiddenSchema.payload = JSON.stringify({ web_push: 8030, notification: { title: 'x', body: 'y', lang: 'en', navigate: '/?mobile-push=x', tag: 't', badge: '/badge.png' } })
    expect(await unused.sender.send(forbiddenSchema)).toEqual({ kind: 'permanent' })
    expect(unused.requestCount()).toBe(0)

    const relativeNavigation = input()
    relativeNavigation.payload = JSON.stringify({ web_push: 8030, notification: { title: 'x', body: 'y', lang: 'en', navigate: '?mobile-push=x', tag: 't' } })
    expect(await unused.sender.send(relativeNavigation)).toEqual({ kind: 'permanent' })
    expect(unused.requestCount()).toBe(0)

    const oversizedResponse = senderFor(201, {}, [Buffer.alloc(8193)])
    const accepted = await oversizedResponse.sender.send(input())
    expect(oversizedResponse.request?.destroyed).toBe(true)
    expect(oversizedResponse.request?.response?.destroyed).toBe(true)
    expect(accepted).toEqual({ kind: 'accepted' })
  })

  it.each([
    [404, 'gone'], [410, 'gone'], [401, 'suspended'], [403, 'suspended'],
    [429, 'retry'], [500, 'retry'], [400, 'permanent'],
  ] as const)('preserves HTTP %i result mapping when the capped response body is oversized', async (status, kind) => {
    const fixture = senderFor(status, {}, [Buffer.alloc(8193)])
    const result = await fixture.sender.send(input())
    expect(fixture.request?.destroyed).toBe(true)
    expect(fixture.request?.response?.destroyed).toBe(true)
    expect(result).toEqual({ kind })
  })

  it('terminates stalled DNS and stalled TLS/response phases at the same absolute budget', async () => {
    let finishLookup!: () => void
    const unusedRequest = vi.fn()
    const dnsSender = new PushSender({
      attemptTimeoutMs: 45,
      resolve: () => new Promise(resolve => { finishLookup = () => resolve([{ address: '8.8.8.8', family: 4 }]) }),
      request: unusedRequest,
    })
    const dnsStarted = performance.now()
    expect(await dnsSender.send(input())).toEqual({ kind: 'retry' })
    expect(performance.now() - dnsStarted).toBeLessThan(500)
    finishLookup()
    expect(unusedRequest).not.toHaveBeenCalled()

    let stalledRequest: FakeRequest | undefined
    const handshakeSender = new PushSender({
      attemptTimeoutMs: 45,
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      request: () => {
        stalledRequest = new FakeRequest(() => {})
        return stalledRequest as unknown as ClientRequest
      },
    })
    const handshakeStarted = performance.now()
    expect(await handshakeSender.send(input())).toEqual({ kind: 'retry' })
    expect(performance.now() - handshakeStarted).toBeLessThan(500)
    expect(stalledRequest?.destroyed).toBe(true)
  })

  it('uses a canonical HTTPS app-origin subject by default and rejects localhost subjects', async () => {
    const fixture = senderFor(201)
    const sendInput = input()
    expect(await fixture.sender.send(sendInput)).toEqual({ kind: 'accepted' })
    const authorization = (fixture.options?.headers as Record<string, string>).Authorization!
    expect(authorization).toMatch(/^vapid /iu)
    const jwt = /t=([^,]+)/u.exec(authorization)?.[1]
    expect(jwt).toBeDefined()
    const claims = JSON.parse(Buffer.from(jwt!.split('.')[1]!, 'base64url').toString('utf8')) as { sub?: string }
    expect(claims.sub).toBe('https://100.64.0.5/')

    for (const subject of ['https://localhost/', 'https://127.0.0.1/', 'https://[::1]/']) {
      expect(await fixture.sender.send({ ...input(), subject })).toEqual({ kind: 'permanent' })
    }
  })
})
