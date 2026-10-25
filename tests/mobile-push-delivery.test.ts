import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccessController } from '../src/access.js'
import { createPushHost } from '../src/mobile-push/host.js'
import { PushDelivery } from '../src/mobile-push/delivery.js'
import { MemoryPushStore } from '../src/mobile-push/store.js'
import { PushRegistry } from '../src/mobile-push/registry.js'
import type { ContextLike, PushHost, PushIntent, PushReceipt, PushRegistration, PushSource, PushTapReference, VapidKeys } from '../src/mobile-push/contracts.js'
import { PushSender, type PushSendResult } from '../src/mobile-push/sender.js'
import { MemoryDeviceStore } from '../src/storage.js'
import type { AccessControllerOptions } from '../src/access.js'

const preferences = { question: true, plan: true, approval: true, response: true, goal: true, failure: true }
const owner = (deviceId: string) => ({ scopeId: 'scope-a', deviceId, origin: 'https://mobile.example.test' })
const source = (sourceId: string, overrides: Partial<PushSource> = {}): PushSource => ({
  sourceId, sessionId: 'session-a', targetSessionId: 'session-a', category: 'response',
  createdAt: Date.now(), expiresAt: Date.now() + 60_000, lifetime: 'committed', turn: 1, ...overrides,
})

function makeKeys(): VapidKeys {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' })
  return {
    publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(pair.x!, 'base64url'), Buffer.from(pair.y!, 'base64url')]).toString('base64url'),
    privateKey: pair.d!,
  }
}
function fingerprint(keys: VapidKeys): string { return createHash('sha256').update(Buffer.from(keys.publicKey, 'base64url')).digest('hex') }
function makeSubscriptionKeys() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' })
  return {
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.from(pair.x!, 'base64url'), Buffer.from(pair.y!, 'base64url')]).toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  }
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function accessOptions(now: () => number = Date.now): AccessControllerOptions {
  return { pairingTtlMs: 60_000, deviceTtlMs: 86_400_000, sessionTtlMs: 60_000, maxDevices: 16, maxSessions: 16, rateLimitWindowMs: 10_000, maxPairingAttempts: 5, maxRateLimitKeys: 64, now }
}

async function makeRegistry(deviceIds: readonly string[] = ['device-a']) {
  const store = new MemoryPushStore()
  const keys = makeKeys()
  const registry = new PushRegistry(store, () => keys)
  await registry.initialize()
  const registrations: PushRegistration[] = []
  for (const deviceId of deviceIds) {
    const fields = owner(deviceId)
    const config = await registry.config(fields, `install-${deviceId}`)
    const result = await registry.upsert(fields, {
      installationId: `install-${deviceId}`,
      subscription: { endpoint: `https://web.push.apple.com/topic/${deviceId}`, keys: makeSubscriptionKeys() },
      locale: 'en', preferences, keyFingerprint: fingerprint(keys),
      ownerGeneration: config.ownerGeneration, registrationGeneration: config.registrationGeneration,
    })
    registrations.push(result.registration)
  }
  return { keys, store, registry, registrations }
}

function hostDouble(overrides: Partial<PushHost> = {}): PushHost {
  return {
    available: true,
    subscribe: () => () => undefined,
    reconcile: async () => 'eligible',
    eligible: async () => true,
    sessionExists: async () => true,
    resolveTarget: async item => ({ sessionId: item.targetSessionId, interaction: 'current' }),
    close: async () => undefined,
    ...overrides,
  }
}
function senderDouble(send: PushSender['send']): PushSender { return { send } as unknown as PushSender }

const opened: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(opened.splice(0).map(close => close()))
})

describe('push delivery coordination', () => {
  it('keeps a consented queued recipient eligible when another device purges and rotates the control floor', async () => {
    const deviceIds = ['device-a', 'device-b', 'device-c', 'device-d', 'device-e']
    const { registry } = await makeRegistry(deviceIds)
    const started = deferred<void>()
    const releaseA = deferred<void>()
    const releaseOthers = deferred<void>()
    let firstFour = 0
    const sentDevices: string[] = []
    const sender = senderDouble(async ({ registration }) => {
      sentDevices.push(registration.deviceId)
      if (registration.deviceId !== 'device-e') {
        firstFour += 1
        if (firstFour === 4) started.resolve()
        if (registration.deviceId === 'device-a') await releaseA.promise
        else await releaseOthers.promise
      }
      return { kind: 'accepted' }
    })
    const host = hostDouble()
    const delivery = new PushDelivery({ host, registry, sender })
    opened.push(() => delivery.close())
    delivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => deviceIds.map(id => ({ id, expiresAt: Date.now() + 60_000 })) })
    await delivery.start()

    // Four earlier recipients occupy the pool, leaving E queued when A is purged.
    delivery.observe(source('alert-a'))
    await started.promise
    await registry.purgeDevices('scope-a', ['device-a'])
    releaseA.resolve()
    await vi.waitFor(() => expect(sentDevices).toContain('device-e'))
    releaseOthers.resolve()
    expect(registry.snapshot().registrations.map(row => row.deviceId)).toEqual(deviceIds.slice(1))
  })

  it('does not settle or retry an in-flight send after recipient consent is disabled', async () => {
    const { registry, store, registrations } = await makeRegistry()
    const sending = deferred<void>()
    const release = deferred<void>()
    const sender = senderDouble(async () => { sending.resolve(); await release.promise; return { kind: 'retry' } })
    const delivery = new PushDelivery({ host: hostDouble(), registry, sender })
    opened.push(() => delivery.close())
    delivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => [{ id: 'device-a', expiresAt: Date.now() + 60_000 }] })
    await delivery.start()

    delivery.observe(source('disable-barrier'))
    await sending.promise
    const recipient = registrations[0]!
    await registry.disable({ ...owner(recipient.deviceId), installationId: recipient.installationId })
    release.resolve()
    await vi.waitFor(() => expect(store.inspect().pending).toHaveLength(0))
    expect(store.inspect().receipts).toHaveLength(0)
  })

  it('ignores a stale accepted callback after same-installation re-enrollment', async () => {
    const { registry, store } = await makeRegistry()
    const oldRequestStarted = deferred<void>()
    const releaseOldRequest = deferred<void>()
    let sends = 0
    const sender = senderDouble(async input => {
      sends += 1
      const allowed = input.beforeRequest ? await input.beforeRequest(input.signal) : false
      if (!allowed) return { kind: 'cancelled' }
      if (sends === 1) { oldRequestStarted.resolve(); await releaseOldRequest.promise }
      return { kind: 'accepted' }
    })
    const delivery = new PushDelivery({ host: hostDouble(), registry, sender })
    opened.push(() => delivery.close())
    delivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => [{ id: 'device-a', expiresAt: Date.now() + 60_000 }] })
    await delivery.start()

    delivery.observe(source('old-generation'))
    await oldRequestStarted.promise
    const oldRegistration = registry.snapshot().registrations[0]!
    const key = { scopeId: oldRegistration.scopeId, deviceId: oldRegistration.deviceId, origin: oldRegistration.origin, installationId: oldRegistration.installationId }
    await registry.disable(key)
    const config = await registry.config(owner('device-a'), key.installationId)
    await registry.upsert(owner('device-a'), {
      installationId: key.installationId, subscription: { endpoint: 'https://web.push.apple.com/topic/re-enrolled', keys: makeSubscriptionKeys() },
      locale: 'en', preferences, keyFingerprint: fingerprint(registry.snapshot().keys!), ownerGeneration: config.ownerGeneration, registrationGeneration: config.registrationGeneration,
    })
    const freshGeneration = registry.snapshot().registrations[0]!.generation
    delivery.observe(source('new-generation'))
    await vi.waitFor(() => expect(store.inspect().receipts.some(row => row.sourceId === 'new-generation')).toBe(true))
    releaseOldRequest.resolve()
    await vi.waitFor(() => expect(store.inspect().pending).toHaveLength(0))

    expect(registry.snapshot().registrations[0]?.generation).toBe(freshGeneration)
    expect(store.inspect().receipts.map(row => row.sourceId)).toEqual(['new-generation'])
  })

  it('cancels at the real sender boundary when another AccessController revokes during DNS', async () => {
    const deviceId = 'a'.repeat(32)
    const now = Date.now()
    const deviceStore = new MemoryDeviceStore({ version: 2, devices: [{
      id: deviceId, label: 'Fixture', tokenDigest: 'b'.repeat(64), createdAt: now - 1_000, expiresAt: now + 60_000, lastSeenAt: now,
    }] })
    const readerA = new AccessController(deviceStore, accessOptions())
    const revoker = new AccessController(deviceStore, accessOptions())
    await Promise.all([readerA.initialize(), revoker.initialize()])
    opened.push(async () => { await Promise.all([readerA.close(), revoker.close()]) })
    expect(readerA.metrics().sessions).toBe(0)
    const { registry, store, registrations } = await makeRegistry([deviceId])
    const dnsStarted = deferred<void>()
    const releaseDns = deferred<void>()
    const settled = deferred<PushSendResult>()
    let authorizationReads = 0
    let requestFactoryCalls = 0
    const subjects: string[] = []
    const actualSender = new PushSender({
      async resolve() {
        dnsStarted.resolve()
        await releaseDns.promise
        return [{ address: '8.8.8.8', family: 4 }]
      },
      request: (() => { requestFactoryCalls += 1; throw new Error('request factory must not run') }) as never,
    })
    const sender = {
      send(input: Parameters<PushSender['send']>[0]) {
        subjects.push(input.subject)
        const sending = actualSender.send(input)
        void sending.then(settled.resolve)
        return sending
      },
    } as PushSender
    const delivery = new PushDelivery({ host: hostDouble(), registry, sender })
    opened.push(() => delivery.close())
    delivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => {
      authorizationReads += 1
      return readerA.authorizedDevices()
    } })
    await delivery.start()

    delivery.observe(source('held-dns-revoke', { expiresAt: Date.now() + 30_000 }))
    await dnsStarted.promise
    // No callback is wired to this provider: its peer revokes in the shared durable store.
    await expect(revoker.revokeDevice(deviceId)).resolves.toBe(true)
    expect(await readerA.authorizedDevices()).toEqual([])
    releaseDns.resolve()
    await expect(settled.promise).resolves.toMatchObject({ kind: 'cancelled' })
    await delivery.close()

    expect(authorizationReads).toBeGreaterThanOrEqual(2)
    expect(subjects).toEqual(['https://mobile.example.test'])
    expect(requestFactoryCalls).toBe(0)
    expect(store.inspect().receipts).toHaveLength(0)
    expect(registrations[0]?.deviceId).toBe(deviceId)
  })

  it.each(['persistent authorization', 'recipient disable', 'expiry', 'origin replacement', 'key reset'])('denies a held pre-request guard after %s changes', async change => {
    let currentNow = Date.now()
    const { registry, store, registrations } = await makeRegistry()
    const entered = deferred<void>()
    const release = deferred<void>()
    const settled = deferred<string>()
    let authorized = true
    const sender = senderDouble(async input => {
      entered.resolve()
      await release.promise
      const allowed = input.beforeRequest ? await input.beforeRequest(input.signal) : false
      settled.resolve(allowed ? 'accepted' : 'cancelled')
      return allowed ? { kind: 'accepted' } : { kind: 'cancelled' }
    })
    const delivery = new PushDelivery({ host: hostDouble(), registry, sender, now: () => currentNow })
    opened.push(() => delivery.close())
    const originInput = { scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => authorized ? [{ id: 'device-a', expiresAt: currentNow + 60_000 }] : [] }
    delivery.attachOrigin(originInput)
    await delivery.start()
    const intentSource = source(`guard-${change}`, { createdAt: currentNow, expiresAt: currentNow + 30_000 })
    delivery.observe(intentSource)
    await entered.promise

    const key = registrations[0]!
    if (change === 'persistent authorization') authorized = false
    else if (change === 'recipient disable') await registry.disable({ ...owner(key.deviceId), installationId: key.installationId })
    else if (change === 'expiry') currentNow = intentSource.expiresAt + 1
    else if (change === 'origin replacement') delivery.attachOrigin(originInput)
    else await registry.resetKeys()

    release.resolve()
    await expect(settled.promise).resolves.toBe('cancelled')
    await delivery.close()
    expect(store.inspect().receipts).toHaveLength(0)
    if (change === 'persistent authorization' || change === 'expiry' || change === 'origin replacement') expect(store.inspect().pending).toHaveLength(0)
  })

  it('uses at most four concurrent provider requests and bounds retained scope intents at 256', async () => {
    const { registry, store } = await makeRegistry(['a', 'b', 'c', 'd', 'e'])
    const firstFour = deferred<void>()
    const release = deferred<void>()
    const allSourcesAdmitted = deferred<void>()
    const admitted = new Set<string>()
    let concurrent = 0
    let maximum = 0
    let entered = 0
    const sender = senderDouble(async () => {
      concurrent += 1
      maximum = Math.max(maximum, concurrent)
      entered += 1
      if (entered === 4) firstFour.resolve()
      await release.promise
      concurrent -= 1
      return { kind: 'accepted' }
    })
    const host = hostDouble({ async eligible(item) {
      if (!admitted.has(item.sourceId)) {
        admitted.add(item.sourceId)
        if (admitted.size === 257) allSourcesAdmitted.resolve()
      }
      return true
    } })
    const delivery = new PushDelivery({ host, registry, sender })
    opened.push(() => delivery.close())
    delivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, expiresAt: Date.now() + 60_000 })) })
    await delivery.start()

    for (let n = 0; n < 257; n += 1) delivery.observe(source(`bounded-${n}`))
    await allSourcesAdmitted.promise
    await firstFour.promise
    await vi.waitFor(() => expect(store.inspect().pending).toHaveLength(256))
    expect(maximum).toBe(4)
    release.resolve()
  })

  it('caps accepted receipts and tap references to 1024 rows per scope', async () => {
    const { registry, store, registrations } = await makeRegistry()
    const registration = registrations[0]!
    const key = { scopeId: registration.scopeId, deviceId: registration.deviceId, origin: registration.origin, installationId: registration.installationId }
    const expiresAt = Date.now() + 60_000
    const receipts: PushReceipt[] = []
    const references: PushTapReference[] = []
    for (let n = 0; n < 1_023; n += 1) {
      const item = source(`seeded-${n}`, { expiresAt })
      receipts.push({ sourceId: item.sourceId, key, recipientGeneration: registration.generation, expiresAt })
      references.push({ reference: `seeded-ref-${n}`, key, source: item, expiresAt })
    }
    await registry.transact(snapshot => ({ ...snapshot, receipts, references }))
    const delivery = new PushDelivery({ host: hostDouble(), registry, sender: senderDouble(async () => ({ kind: 'accepted' })) })
    opened.push(() => delivery.close())
    delivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => [{ id: 'device-a', expiresAt: Date.now() + 60_000 }] })
    await delivery.start()
    delivery.observe(source('last-bounded-receipt'))
    await vi.waitFor(() => expect(store.inspect().receipts.some(row => row.sourceId === 'last-bounded-receipt')).toBe(true))
    expect(store.inspect().receipts).toHaveLength(1_024)
    expect(store.inspect().references).toHaveLength(1_024)
  })

  it('reads revocation durably across two live authorization readers and purges without a short Session', async () => {
    const deviceId = 'a'.repeat(32)
    const now = Date.now()
    const deviceStore = new MemoryDeviceStore({ version: 2, devices: [{
      id: deviceId, label: 'Fixture', tokenDigest: 'b'.repeat(64), createdAt: now - 1_000, expiresAt: now + 60_000, lastSeenAt: now,
    }] })
    const readerA = new AccessController(deviceStore, accessOptions())
    const readerB = new AccessController(deviceStore, accessOptions())
    await Promise.all([readerA.initialize(), readerB.initialize()])
    expect(readerA.metrics().sessions).toBe(0)
    const { registry } = await makeRegistry([deviceId])
    const send = vi.fn(async () => ({ kind: 'accepted' as const }))
    const delivery = new PushDelivery({ host: hostDouble(), registry, sender: senderDouble(send) })
    opened.push(() => delivery.close())
    delivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: () => readerA.authorizedDevices() })
    let callbacks = 0
    const detachRemoval = readerB.onDevicesRemoved((ids) => {
      callbacks += 1
      void delivery.invalidateDevices('scope-a', ids)
    })
    await delivery.start()

    await expect(readerB.revokeDevice(deviceId)).resolves.toBe(true)
    await vi.waitFor(() => expect(registry.snapshot().registrations).toHaveLength(0))
    expect(await readerA.authorizedDevices()).toEqual([])
    expect(callbacks).toBe(1)
    delivery.observe(source('after-persistent-revoke'))
    await delivery.close()
    expect(send).not.toHaveBeenCalled()
    detachRemoval()
    await Promise.all([readerA.close(), readerB.close()])
  })

  it('retains persistent push consent after explicit logout and short-Session expiry', async () => {
    let clock = Date.now()
    const access = new AccessController(new MemoryDeviceStore(), {
      ...accessOptions(() => clock), sessionTtlMs: 1_000,
    })
    await access.initialize()
    const pairing = await access.openPairing()
    const paired = await access.pair('fixture-peer', pairing.token, 'Fixture device')
    const logout = access.authorizeSession(paired.sessionToken)
    access.logout(logout)
    await expect(access.renew(paired.deviceToken)).resolves.toMatchObject({ deviceId: paired.deviceId })
    const renewed = await access.renew(paired.deviceToken)
    clock += 1_001
    expect(() => access.authorizeSession(renewed.sessionToken)).toThrow()
    await expect(access.authorizedDevices()).resolves.toEqual([{ id: paired.deviceId, expiresAt: paired.deviceExpiresAt }])
    opened.push(() => access.close())

    const { registry, registrations } = await makeRegistry([paired.deviceId])
    const send = vi.fn(async () => ({ kind: 'accepted' as const }))
    const delivery = new PushDelivery({ host: hostDouble(), registry, sender: senderDouble(send) })
    opened.push(() => delivery.close())
    delivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: () => access.authorizedDevices() })
    await delivery.start()
    delivery.observe(source('after-session-end'))
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(registrations[0]?.deviceId).toBe(paired.deviceId)
    expect(registry.snapshot().registrations).toHaveLength(1)
  })

  it('purges only notification-owned unauthorized candidates and does not churn the floor later', async () => {
    vi.useFakeTimers()
    const { registry, store, registrations } = await makeRegistry()
    let reads = 0
    const delivery = new PushDelivery({ host: hostDouble(), registry, sender: senderDouble(async () => ({ kind: 'accepted' })) })
    opened.push(() => delivery.close())
    delivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => { reads += 1; return [] } })
    await delivery.start()
    expect(store.inspect().registrations).toHaveLength(0)
    const firstFloor = store.inspect().ownerGenerationFloor
    expect(firstFloor).toBeGreaterThan(registrations[0]!.generation)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(store.inspect().ownerGenerationFloor).toBe(firstFloor)
  })

  it('purges an explicitly removed device once even when it has no push metadata', async () => {
    const deviceId = 'c'.repeat(32)
    const now = Date.now()
    const deviceStore = new MemoryDeviceStore({ version: 2, devices: [{
      id: deviceId, label: 'Fixture', tokenDigest: 'd'.repeat(64), createdAt: now - 1_000, expiresAt: now + 60_000, lastSeenAt: now,
    }] })
    const access = new AccessController(deviceStore, accessOptions())
    await access.initialize()
    const { registry } = await makeRegistry([])
    const delivery = new PushDelivery({ host: hostDouble(), registry, sender: senderDouble(async () => ({ kind: 'accepted' })) })
    opened.push(() => delivery.close())
    let removals = 0
    const detach = access.onDevicesRemoved(ids => { removals += 1; void delivery.invalidateDevices('scope-a', ids) })
    await access.revokeDevice(deviceId)
    await vi.waitFor(() => expect(registry.snapshot().ownerGenerationFloor).toBe(1))
    expect(removals).toBe(1)
    expect(registry.snapshot().registrations).toHaveLength(0)
    detach()
    await delivery.close()
    await access.close()
  })

  it.each([
    ['provider unauthorized', 'suspended' as const],
    ['provider endpoint gone', 'gone' as const],
  ])('settles %s only against the current recipient generation', async (_name, outcome) => {
    const { registry, store, registrations } = await makeRegistry()
    const delivery = new PushDelivery({ host: hostDouble(), registry, sender: senderDouble(async () => ({ kind: outcome })) })
    opened.push(() => delivery.close())
    delivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => [{ id: 'device-a', expiresAt: Date.now() + 60_000 }] })
    await delivery.start()
    delivery.observe(source(`settle-${outcome}`))
    if (outcome === 'suspended') await vi.waitFor(() => expect(store.inspect().registrations[0]?.health).toBe('suspended'))
    else await vi.waitFor(() => expect(store.inspect().registrations).toHaveLength(0))
    expect(store.inspect().pending).toHaveLength(0)
    if (outcome === 'suspended') {
      expect(store.inspect().registrations).toMatchObject([{ health: 'suspended', generation: registrations[0]!.generation + 1 }])
    } else {
      expect(store.inspect().registrations).toHaveLength(0)
      expect(store.inspect().ownerGenerationFloor).toBeGreaterThan(registrations[0]!.generation)
    }
    expect(store.inspect().receipts).toHaveLength(0)
  })

  it('fails closed on authorization-reader errors without purging registrations', async () => {
    const { registry, store } = await makeRegistry()
    const send = vi.fn(async () => ({ kind: 'accepted' as const }))
    const delivery = new PushDelivery({ host: hostDouble(), registry, sender: senderDouble(send) })
    opened.push(() => delivery.close())
    delivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => { throw new Error('store unavailable') } })
    await delivery.start()
    delivery.observe(source('reader-failure'))
    await delivery.close()

    expect(send).not.toHaveBeenCalled()
    expect(store.inspect().registrations).toHaveLength(1)
    expect(store.inspect().ownerGenerationFloor).toBeUndefined()
  })

  it('keeps stale origin disposers idempotent and scoped to their own attachment', async () => {
    const { registry } = await makeRegistry()
    const sent: string[] = []
    const delivery = new PushDelivery({ host: hostDouble(), registry, sender: senderDouble(async ({ registration }) => { sent.push(registration.deviceId); return { kind: 'accepted' } }) })
    opened.push(() => delivery.close())
    const input = { scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => [{ id: 'device-a', expiresAt: Date.now() + 60_000 }] }
    const oldDispose = delivery.attachOrigin(input)
    oldDispose()
    oldDispose()
    delivery.attachOrigin(input)
    oldDispose()
    await delivery.start()
    delivery.observe(source('replacement-origin'))
    await vi.waitFor(() => expect(sent).toEqual(['device-a']))
  })

  it('rechecks current authorization and exact Host eligibility before a retry', async () => {
    vi.useFakeTimers()
    const { registry, registrations } = await makeRegistry()
    const hostGate = deferred<void>()
    const retryGuardEntered = deferred<void>()
    let eligibleCalls = 0
    let authReads = 0
    const host = hostDouble({
      async reconcile() { eligibleCalls += 1; return 'eligible' },
      async eligible() {
        eligibleCalls += 1
        if (eligibleCalls === 5) { retryGuardEntered.resolve(); await hostGate.promise }
        return true
      },
    })
    const retryStarted = deferred<void>()
    let attempts = 0
    const ttlSeconds: number[] = []
    const sender = senderDouble(async input => {
      ttlSeconds.push(input.ttlSeconds)
      attempts += 1
      if (attempts === 1) return { kind: 'retry' }
      retryStarted.resolve()
      return { kind: 'accepted' }
    })
    const delivery = new PushDelivery({ host, registry, sender })
    opened.push(() => delivery.close())
    delivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => {
      authReads += 1
      return [{ id: 'device-a', expiresAt: Date.now() + 60_000 }]
    } })
    await delivery.start()

    delivery.observe(source('retry-source', { expiresAt: Date.now() + 30_000 }))
    await vi.waitFor(() => expect(registry.snapshot().pending[0]?.attempts).toBe(1), { interval: 1 })
    vi.advanceTimersByTime(1_000)
    await retryGuardEntered.promise
    hostGate.resolve()
    await retryStarted.promise
    expect(attempts).toBe(2)
    expect(eligibleCalls).toBeGreaterThanOrEqual(2)
    expect(authReads).toBeGreaterThanOrEqual(2)
    expect(ttlSeconds[1]).toBeLessThan(ttlSeconds[0]!)
    expect(registrations[0]?.deviceId).toBe('device-a')
  })

  it('caps retryable failures at three attempts with 1000ms then 5000ms backoff and original TTL', async () => {
    vi.useFakeTimers()
    const { registry, store } = await makeRegistry()
    let attempts = 0
    const ttls: number[] = []
    const sender = senderDouble(async input => {
      ttls.push(input.ttlSeconds)
      attempts += 1
      return { kind: 'retry' }
    })
    const delivery = new PushDelivery({ host: hostDouble(), registry, sender })
    opened.push(() => delivery.close())
    delivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => [{ id: 'device-a', expiresAt: Date.now() + 60_000 }] })
    await delivery.start()

    delivery.observe(source('three-failures', { expiresAt: Date.now() + 30_000 }))
    await vi.waitFor(() => expect(store.inspect().pending[0]?.attempts).toBe(1), { interval: 1 })
    vi.advanceTimersByTime(999)
    expect(attempts).toBe(1)
    vi.advanceTimersByTime(1)
    await vi.waitFor(() => expect(store.inspect().pending[0]?.attempts).toBe(2), { interval: 1 })
    expect(ttls[1]).toBe(ttls[0]! - 1)
    vi.advanceTimersByTime(4_999)
    expect(attempts).toBe(2)
    vi.advanceTimersByTime(1)
    await vi.waitFor(() => expect(store.inspect().pending).toHaveLength(0), { interval: 1 })
    expect(attempts).toBe(3)
    expect(ttls[0]).toBeGreaterThan(0)
    expect(ttls[0]).toBeLessThanOrEqual(30)
    expect(ttls[1]).toBe(ttls[0]! - 1)
    expect(ttls[2]).toBe(ttls[0]! - 6)
    expect(store.inspect().receipts).toHaveLength(0)
  })

  it('real Host restart verifies a continued timed question from public cold projections and both inbox lanes', async () => {
    vi.useFakeTimers()
    const callId = 'continued-call'
    const active = [{ callId, state: 'continued', questions: [{ id: 'q1', question: 'private text not copied' }] }]
    const projectionValues: Record<string, any> = {
      userQuestions: { active, settled: [] },
      inbox: { 'next-turn': [], 'next-step': [] },
      mobilePushLifecycle: { latestTurn: 4, openTurn: null, lastTurnEnd: { turn: 4, reason: 'completed' }, latestGoalChange: null },
      goal: { current: { goal: { id: 'current-goal', revision: 9, phase: 'active' } } },
    }
    const { registry, store, keys } = await makeRegistry()
    const coldLeases: string[] = []
    const context = (isLive: boolean): ContextLike => {
      const listeners = new Map<string, Array<(...args: any[]) => unknown>>()
      const agent = { id: 'session-a', session: { id: 'session-a' }, inbox: { nextTurn: [], nextStep: [] } }
      return {
        on(event, listener) {
          const rows = listeners.get(event) ?? []
          rows.push(listener)
          listeners.set(event, rows)
          return () => listeners.set(event, rows.filter(item => item !== listener))
        },
        userQuestions: {}, approval: {},
        agents: { get: id => isLive && id === agent.id ? agent : undefined, list: () => isLive ? [agent] : [], roots: () => isLive ? [agent] : [], isOwnedBy: () => false },
        sessionProjections: {
          stateOf: (_session, key) => key === 'userQuestions' ? { questions: { active, settled: [] } } : key === 'turnBoundary' ? { openTurnStartSeq: 10, lastTurn: 4 } : undefined,
          snapshot: () => ({ asOfSeq: 10, values: projectionValues }),
          register: () => () => undefined,
        },
        sessionQuery: {
          async observeSession(id) {
            coldLeases.push(id)
            return { source: 'prepared', projections: { asOfSeq: 10, values: projectionValues }, [Symbol.dispose]() { coldLeases.push('disposed') } }
          },
        },
        // Used only by this harness to deliver the real public Host observer request.
        ...({ emit: (event: string, ...args: any[]) => {
          const chain = [...(listeners.get(event) ?? [])]
          const next = args.pop()
          const invoke = (index: number): unknown => chain[index]
            ? chain[index]!(...args, () => invoke(index + 1))
            : next(...args)
          return invoke(0)
        } } as unknown as Partial<ContextLike>),
      }
    }
    const firstContext = context(true) as ContextLike & { emit(event: string, ...args: any[]): unknown }
    const firstHost = createPushHost(firstContext)
    const emitted: PushSource[] = []
    firstHost.subscribe(item => emitted.push(item), () => undefined)
    const firstDelivery = new PushDelivery({ host: firstHost, registry, sender: senderDouble(async () => ({ kind: 'retry' })) })
    opened.push(async () => { await firstDelivery.close(); await firstHost.close(); await registry.close() })
    firstDelivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => [{ id: 'device-a', expiresAt: Date.now() + 60_000 }] })
    await firstDelivery.start()
    const noAnswerer = Object.assign(new Error('no public answerer'), { code: 'NO_PROVIDER' })
    const signal = new AbortController().signal
    void Promise.resolve(firstContext.emit('user-questions/request', {
      agent: { id: 'session-a', session: { id: 'session-a' } },
      questions: [{ id: 'q1', question: 'not persisted' }],
      wait: { callId, timed: true }, signal,
    }, async () => { throw noAnswerer })).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(250)
    expect(emitted).toHaveLength(1)
    const persistedSource = emitted[0]!
    expect(persistedSource.callId).toBe(callId)
    await vi.waitFor(() => expect(store.inspect().pending[0]?.attempts).toBe(1))
    expect(store.inspect().pending[0]?.source).toMatchObject({ sourceId: persistedSource.sourceId, callId })

    await firstDelivery.close()
    await firstHost.close()
    await registry.close()
    const restartedRegistry = new PushRegistry(store, () => keys)
    await restartedRegistry.initialize()
    const secondConfig = await restartedRegistry.config(owner('device-b'), 'install-device-b')
    await restartedRegistry.upsert(owner('device-b'), {
      installationId: 'install-device-b', subscription: { endpoint: 'https://web.push.apple.com/topic/device-b', keys: makeSubscriptionKeys() },
      locale: 'en', preferences, keyFingerprint: fingerprint(keys), ownerGeneration: secondConfig.ownerGeneration, registrationGeneration: secondConfig.registrationGeneration,
    })
    const retainedIntent = store.inspect().pending[0]!
    const unverifiable = (id: string, category: 'plan' | 'approval'): PushIntent => ({
      ...retainedIntent,
      id,
      source: { ...persistedSource, sourceId: id, category, callId: `${id}-call` },
      attempts: 0,
      nextAttemptAt: Date.now(),
    })
    await restartedRegistry.transact(snapshot => ({
      ...snapshot,
      pending: [...snapshot.pending, unverifiable('legacy-plan', 'plan'), unverifiable('legacy-approval', 'approval')],
    }))
    const restartedHost = createPushHost(context(false))
    const restartedSent: string[] = []
    const restartedDelivery = new PushDelivery({ host: restartedHost, registry: restartedRegistry, sender: senderDouble(async ({ registration }) => { restartedSent.push(registration.deviceId); return { kind: 'accepted' } }) })
    opened.push(async () => { await restartedDelivery.close(); await restartedHost.close(); await restartedRegistry.close() })
    restartedDelivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => [
      { id: 'device-a', expiresAt: Date.now() + 60_000 }, { id: 'device-b', expiresAt: Date.now() + 60_000 },
    ] })
    await restartedDelivery.start()
    await expect(restartedHost.reconcile(persistedSource)).resolves.toBe('eligible')
    expect(store.inspect().pending.map(item => item.source.sourceId)).toEqual([persistedSource.sourceId])
    expect(restartedSent).toEqual([])
    expect(coldLeases).toContain('session-a')
    expect(coldLeases).toContain('disposed')

    // A goal/reason projection and unrelated queue entries do not settle this call.
    projectionValues.inbox['next-turn'].push({ role: 'user', source: { kind: 'ordinary' } })
    projectionValues.inbox['next-step'].push({ role: 'assistant', source: { kind: 'internal' } })
    projectionValues.mobilePushLifecycle.latestTurn = 5
    projectionValues.mobilePushLifecycle.lastTurnEnd = { turn: 5, reason: 'completed' }
    projectionValues.goal.current.goal = { id: 'current-goal', revision: 10, phase: 'active' }
    await expect(restartedHost.reconcile(persistedSource)).resolves.toBe('eligible')

    // Either public inbox lane carrying the exact reply marker makes this source stale.
    projectionValues.inbox['next-turn'].push({ role: 'user', source: { kind: 'user-question-reply', callId, outcome: 'answered' } })
    await expect(restartedHost.reconcile(persistedSource)).resolves.toBe('stale')
    projectionValues.inbox['next-turn'].pop()
    projectionValues.inbox['next-step'].push({ role: 'user', source: { kind: 'user-question-reply', callId, outcome: 'answered' } })
    await expect(restartedHost.reconcile(persistedSource)).resolves.toBe('stale')
    await restartedHost.close()
  })

  it('preserves fresh duplicate receipts on restart and never backfills a new recipient', async () => {
    const { registry, store, keys, registrations } = await makeRegistry()
    const sent: string[] = []
    const first = new PushDelivery({ host: hostDouble(), registry, sender: senderDouble(async ({ registration }) => { sent.push(registration.deviceId); return { kind: 'accepted' } }) })
    opened.push(() => first.close())
    const originInput = { scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => [
      { id: 'device-a', expiresAt: Date.now() + 60_000 }, { id: 'device-b', expiresAt: Date.now() + 60_000 },
    ] }
    first.attachOrigin(originInput)
    await first.start()
    const persistedSource = source('restart-duplicate')
    first.observe(persistedSource)
    await vi.waitFor(() => expect(store.inspect().receipts).toHaveLength(1))
    const oldKey = registrations[0]!
    const duplicate: PushIntent = {
      id: 'pending-duplicate', key: { scopeId: oldKey.scopeId, deviceId: oldKey.deviceId, origin: oldKey.origin, installationId: oldKey.installationId },
      source: persistedSource, ownerGeneration: 0, recipientGeneration: oldKey.generation, attempts: 0, nextAttemptAt: Date.now(),
    }
    await registry.transact(snapshot => ({ ...snapshot, pending: [...snapshot.pending, duplicate] }))
    await first.close()
    await registry.close()

    const restartedRegistry = new PushRegistry(store, () => keys)
    await restartedRegistry.initialize()
    const config = await restartedRegistry.config(owner('device-b'), 'install-device-b')
    await restartedRegistry.upsert(owner('device-b'), {
      installationId: 'install-device-b', subscription: { endpoint: 'https://web.push.apple.com/topic/device-b', keys: makeSubscriptionKeys() },
      locale: 'en', preferences, keyFingerprint: fingerprint(keys), ownerGeneration: config.ownerGeneration, registrationGeneration: config.registrationGeneration,
    })
    const restarted = new PushDelivery({ host: hostDouble(), registry: restartedRegistry, sender: senderDouble(async ({ registration }) => { sent.push(registration.deviceId); return { kind: 'accepted' } }) })
    opened.push(() => restarted.close())
    restarted.attachOrigin(originInput)
    await restarted.start()
    await vi.waitFor(() => expect(store.inspect().pending).toHaveLength(0))

    expect(sent).toEqual(['device-a'])
    expect(store.inspect().receipts).toHaveLength(1)
    expect(store.inspect().references).toHaveLength(1)
  })

  it('drains owned requests on close and ignores a late Host observer', async () => {
    const { registry, store, registrations } = await makeRegistry()
    const requestStarted = deferred<void>()
    let observer: ((item: PushSource) => void) | undefined
    let unsubscribed = false
    const host = hostDouble({ subscribe(onSource) { observer = onSource; return () => { unsubscribed = true } } })
    const sender = senderDouble(async ({ signal }) => {
      requestStarted.resolve()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { kind: 'cancelled' }
    })
    const delivery = new PushDelivery({ host, registry, sender })
    opened.push(() => delivery.close())
    delivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => [{ id: 'device-a', expiresAt: Date.now() + 60_000 }] })
    await delivery.start()
    observer?.(source('close-barrier'))
    await requestStarted.promise
    const closing = delivery.close()
    await closing
    expect(unsubscribed).toBe(true)
    const pendingCount = store.inspect().pending.length
    observer?.(source('late-observer'))
    await expect(delivery.test({ ...owner('device-a'), installationId: registrations[0]!.installationId })).rejects.toThrow(/unavailable/u)
    expect(store.inspect().pending).toHaveLength(pendingCount)
    expect(store.inspect().receipts).toHaveLength(0)
  })

  it('does not resolve a reference when the public stored target Session is missing', async () => {
    const { registry, store } = await makeRegistry()
    const resolveTarget = vi.fn(async (item: PushSource) => ({ sessionId: item.targetSessionId, interaction: 'current' as const }))
    const sessionExists = vi.fn(async () => false)
    const delivery = new PushDelivery({ host: hostDouble({ sessionExists, resolveTarget }), registry, sender: senderDouble(async () => ({ kind: 'accepted' })) })
    opened.push(() => delivery.close())
    delivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => [{ id: 'device-a', expiresAt: Date.now() + 60_000 }] })
    await delivery.start()
    delivery.observe(source('deleted-session-tap'))
    await vi.waitFor(() => expect(store.inspect().references).toHaveLength(1))
    const reference = store.inspect().references[0]!.reference

    await expect(delivery.resolve(owner('device-a'), reference)).resolves.toBeUndefined()
    expect(sessionExists).toHaveBeenCalledWith('session-a')
    expect(resolveTarget).not.toHaveBeenCalled()
  })

  it('resolves only an unexpired tap reference belonging to the current owner', async () => {
    const { registry, store, registrations } = await makeRegistry()
    const delivery = new PushDelivery({ host: hostDouble(), registry, sender: senderDouble(async () => ({ kind: 'accepted' })) })
    opened.push(() => delivery.close())
    delivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => [{ id: 'device-a', expiresAt: Date.now() + 60_000 }] })
    await delivery.start()
    delivery.observe(source('tap-source'))
    await vi.waitFor(() => expect(store.inspect().references).toHaveLength(1))
    const reference = store.inspect().references[0]!.reference
    const key = registrations[0]!
    await expect(delivery.resolve(owner(key.deviceId), reference)).resolves.toEqual({ sessionId: 'session-a', interaction: 'current' })
    await expect(delivery.resolve(owner('other-device'), reference)).resolves.toBeUndefined()
    await expect(delivery.resolve(owner(key.deviceId), 'unknown-reference')).resolves.toBeUndefined()
  })

  it('rate-limits provider-accepted tests and shares the four-slot send pool with 60-second TTL', async () => {
    const deviceIds = ['device-a', 'device-b', 'device-c', 'device-d', 'device-e']
    const { registry, registrations } = await makeRegistry(deviceIds)
    const firstFour = deferred<void>()
    const releaseAlerts = deferred<void>()
    const testStarted = deferred<void>()
    let concurrent = 0
    let maximum = 0
    let activeAlerts = 0
    let testTtl: number | undefined
    const sender = senderDouble(async input => {
      concurrent += 1
      maximum = Math.max(maximum, concurrent)
      const title = (JSON.parse(input.payload) as { notification: { title: string } }).notification.title
      try {
        if (title === 'Test notification') {
          testTtl = input.ttlSeconds
          testStarted.resolve()
          return { kind: 'accepted' }
        }
        activeAlerts += 1
        if (activeAlerts === 4) firstFour.resolve()
        await releaseAlerts.promise
        return { kind: 'accepted' }
      } finally {
        concurrent -= 1
      }
    })
    const delivery = new PushDelivery({ host: hostDouble(), registry, sender })
    opened.push(() => delivery.close())
    delivery.attachOrigin({ scopeId: 'scope-a', origin: 'https://mobile.example.test', authorizedDevices: async () => deviceIds.map(id => ({ id, expiresAt: Date.now() + 60_000 })) })
    await delivery.start()
    delivery.observe(source('pool-before-test'))
    await firstFour.promise

    const key = { ...owner('device-e'), installationId: registrations[4]!.installationId }
    const result = delivery.test(key)
    await expect(delivery.test(key)).rejects.toThrow(/rate_limited/u)
    releaseAlerts.resolve()
    await testStarted.promise
    await expect(result).resolves.toBeUndefined()
    expect(testTtl).toBe(60)
    expect(maximum).toBe(4)
  })
})

// Compile-time anchor: persistent authorization is distinct from an expiring Session.
void AccessController
