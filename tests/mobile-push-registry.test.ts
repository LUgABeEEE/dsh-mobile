import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MemoryPushStore } from '../src/mobile-push/store.js'
import { PushRegistry } from '../src/mobile-push/registry.js'
import type { PushOwner, PushPreferences, PushRegistration, PushSnapshot, VapidKeys } from '../src/mobile-push/contracts.js'

const prefs: PushPreferences = { question: true, plan: true, approval: true, response: true, goal: true, failure: true }
function generateVapidKeys(): VapidKeys {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' })
  return { publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(pair.x!, 'base64url'), Buffer.from(pair.y!, 'base64url')]).toString('base64url'), privateKey: pair.d! }
}
function fingerprintOf(keys: VapidKeys): string { return createHash('sha256').update(Buffer.from(keys.publicKey, 'base64url')).digest('hex') }
const keys = generateVapidKeys()
const owner: PushOwner = { scopeId: 'scope-a', deviceId: 'device-a', origin: 'https://mobile.example.test' }
const subscription = { endpoint: 'https://push.apple.com/topic/token-a', keys: { p256dh: 'p256dh-a', auth: 'auth-a' } }
const keyFingerprint = fingerprintOf(keys)
function storedRegistration(ownerFields: PushOwner, installationId: string, generation: number, endpoint: string): PushRegistration {
  return { ...ownerFields, installationId, subscription: { ...subscription, endpoint }, locale: 'en', preferences: prefs, generation, keyFingerprint, enabled: true, health: 'ready' }
}
function pushSnapshot(overrides: Partial<PushSnapshot> = {}): PushSnapshot {
  return { version: 1, keys: { ...keys, fingerprint: keyFingerprint }, ownerGenerations: [], registrations: [], pending: [], receipts: [], references: [], ...overrides }
}
function registry(store: import('../src/mobile-push/registry.js').PushStore = new MemoryPushStore()) { return new PushRegistry(store, () => keys) }
function enrollment(overrides: Record<string, unknown> = {}) { return { installationId: 'install-a', subscription, locale: 'en' as const, preferences: prefs, keyFingerprint, ownerGeneration: 0, registrationGeneration: 0, ...overrides } }

describe('push registration ownership and consent', () => {
  it('creates keys once, persists explicit consent, and reconciles idempotently without another cleanup right', async () => {
    const store = new MemoryPushStore()
    const first = registry(store)
    await first.initialize()
    const publicKey = await first.publicKey()
    expect(publicKey).toBe(keys.publicKey)
    const enabled = await first.upsert(owner, enrollment())
    expect(enabled.registration.enabled).toBe(true)
    expect(enabled.mutationGeneration).toBe(1)
    const again = await first.upsert(owner, enrollment({ ownerGeneration: 0, registrationGeneration: enabled.registration.generation }))
    expect(again.registration).toEqual(enabled.registration)
    expect(again.mutationGeneration).toBeUndefined()
    const restarted = registry(store)
    await restarted.initialize()
    expect(await restarted.publicKey()).toBe(publicKey)
    await restarted.close()
    await first.close()
  })

  it('rejects stale enrollment even when the subscription data is identical', async () => {
    const service = registry()
    await service.initialize()
    const enabled = await service.upsert(owner, enrollment())
    await expect(service.upsert(owner, enrollment({ registrationGeneration: 0 }))).rejects.toThrow(/generation/u)
    await service.close()
    expect(enabled.registration.enabled).toBe(true)
  })

  it('disable advances owner generation, blocks prepared enrollment, and conditional disable cannot disable newer consent', async () => {
    const service = registry()
    await service.initialize()
    const first = await service.upsert(owner, enrollment())
    const preparedGeneration = first.registration.generation
    await service.disable({ ...owner, installationId: 'install-a' }, preparedGeneration)
    await expect(service.upsert(owner, enrollment())).rejects.toThrow(/generation/u)
    const reenabled = await service.upsert(owner, enrollment({ ownerGeneration: 1, registrationGeneration: preparedGeneration + 1 }))
    expect(reenabled.registration.enabled).toBe(true)
    await service.disable({ ...owner, installationId: 'install-a' }, preparedGeneration)
    expect((await service.upsert(owner, enrollment({ ownerGeneration: 1, registrationGeneration: reenabled.registration.generation }))).registration.enabled).toBe(true)
    await service.close()
  })

  it('does not allow an enrollment queued behind a durable Disable to resurrect consent', async () => {
    const backing = new MemoryPushStore()
    let arm = false
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const service = registry({
      load: () => backing.load(),
      async save(snapshot) { if (arm) { arm = false; announce(); await gate }; await backing.save(snapshot) },
    })
    await service.initialize()
    const enabled = await service.upsert(owner, enrollment())
    arm = true
    const disabling = service.disable({ ...owner, installationId: 'install-a' })
    await started
    expect((await service.config(owner, 'install-a')).status).toBe('enabled')
    const oldPrepared = service.upsert(owner, enrollment({ registrationGeneration: enabled.registration.generation }))
    release()
    await disabling
    await expect(oldPrepared).rejects.toThrow(/generation/u)
    expect(backing.inspect().registrations[0]?.enabled).toBe(false)
    await service.close()
  })

  it('exposes fresh config guards and serializes bounded delivery-state transactions', async () => {
    const store = new MemoryPushStore()
    const service = registry(store)
    await service.initialize()
    const config = await service.config(owner, 'install-a')
    expect(config).toMatchObject({ available: true, installationId: 'install-a', ownerGeneration: 0, registrationGeneration: 0, status: 'disabled', publicKey: keys.publicKey, keyFingerprint })
    expect(config).not.toHaveProperty('privateKey')
    await service.transact(snapshot => ({ ...snapshot, receipts: [{ sourceId: 'source-opaque', key: { ...owner, installationId: 'install-a' }, recipientGeneration: 0, expiresAt: Date.now() + 60_000 }] }))
    expect(service.snapshot().receipts).toHaveLength(1)
    const source = { sourceId: 'source-opaque', sessionId: 'session-id', targetSessionId: 'session-id', category: 'response' as const, createdAt: Date.now(), expiresAt: Date.now() + 60_000, lifetime: 'committed' as const }
    await service.transact(snapshot => ({ ...snapshot, references: [{ reference: 'opaque-tap-ref', key: { ...owner, installationId: 'install-a' }, source, expiresAt: source.expiresAt }] }))
    expect(service.snapshot().references).toHaveLength(1)
    await expect(service.transact(snapshot => ({ ...snapshot, registrations: [{ ...snapshot.registrations[0]!, enabled: true }] }))).rejects.toThrow(/only update delivery state/u)
    await expect(service.transact(snapshot => ({ ...snapshot, ownerGenerationFloor: 10 }))).rejects.toThrow(/only update delivery state/u)
    await service.close()
  })

  it('ignores late recipient outcomes and applies a current outcome only to its matching generation', async () => {
    const store = new MemoryPushStore()
    const service = registry(store)
    await service.initialize()
    const first = await service.upsert(owner, enrollment())
    const key = { ...owner, installationId: 'install-a' }
    const changed = await service.preferences(key, { ...prefs, failure: false }, { ownerGeneration: 0, registrationGeneration: first.registration.generation })
    await service.settleRecipient(key, first.registration.generation, 'gone')
    expect(service.snapshot().registrations[0]).toEqual(changed)
    await service.settleRecipient(key, changed.generation, 'suspended')
    expect(service.snapshot().registrations[0]).toMatchObject({ enabled: true, health: 'suspended', generation: changed.generation + 1 })
    await service.settleRecipient(key, changed.generation, 'gone')
    expect(service.snapshot().registrations).toHaveLength(1)
    await service.settleRecipient(key, changed.generation + 1, 'gone')
    expect(service.snapshot().registrations).toHaveLength(0)
    expect((await service.config(owner, 'install-a')).ownerGeneration).toBe(changed.generation + 2)
    await service.close()
  })

  it('rejects endpoint takeover but permits canonical-id recovery for the same owner', async () => {
    const service = registry()
    await service.initialize()
    const first = await service.upsert(owner, enrollment())
    const recovered = await service.upsert(owner, enrollment({ installationId: 'new-local-id', ownerGeneration: 0, registrationGeneration: 0 }))
    expect(recovered.registration.installationId).toBe('install-a')
    expect(recovered.mutationGeneration).toBeUndefined()
    await expect(service.upsert({ ...owner, deviceId: 'device-b' }, enrollment({ installationId: 'install-b' }))).rejects.toThrow(/owner|endpoint|conflict/u)
    await service.close()
    expect(first.registration.deviceId).toBe('device-a')
  })

  it('stores canonical endpoint identity on enrollment', async () => {
    const service = registry()
    await service.initialize()
    const alias = { ...subscription, endpoint: 'https://WEB.PUSH.APPLE.COM:443/topic/canonical-enroll' }
    const result = await service.upsert(owner, enrollment({ subscription: alias }))
    expect(result.registration.subscription.endpoint).toBe('https://web.push.apple.com/topic/canonical-enroll')
    await service.close()
  })

  it('rejects case and explicit-default-port aliases of another owner endpoint', async () => {
    const service = registry()
    await service.initialize()
    const canonical = { ...subscription, endpoint: 'https://web.push.apple.com/topic/token-a' }
    await service.upsert(owner, enrollment({ subscription: canonical }))
    const alias = { ...subscription, endpoint: 'https://WEB.PUSH.APPLE.COM:443/topic/token-a' }
    await expect(service.upsert({ ...owner, deviceId: 'device-b' }, enrollment({ installationId: 'install-b', subscription: alias }))).rejects.toThrow(/owner|endpoint|conflict/u)
    expect(service.snapshot().registrations).toHaveLength(1)
    await service.close()
  })

  it('rejects a fifth registration on one device without evicting prior installations', async () => {
    const store = new MemoryPushStore()
    const service = registry(store)
    await service.initialize()
    for (let n = 0; n < 4; n++) await service.upsert(owner, enrollment({ installationId: `install-${n}`, subscription: { ...subscription, endpoint: `${subscription.endpoint}-${n}` } }))
    await expect(service.upsert(owner, enrollment({ installationId: 'install-overflow', subscription: { ...subscription, endpoint: `${subscription.endpoint}-overflow` } }))).rejects.toThrow(/limit/u)
    expect(store.inspect().registrations).toHaveLength(4)
    await service.close()
  })

  it('closes admission before mutations queued behind a held save can commit', async () => {
    const backing = new MemoryPushStore()
    let hold = false
    let saves = 0
    let announce!: () => void
    const saveStarted = new Promise<void>(resolve => { announce = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const service = registry({
      load: () => backing.load(),
      async save(snapshot) { saves++; if (hold) { hold = false; announce(); await gate }; await backing.save(snapshot) },
    })
    await service.initialize()
    const registered = await service.upsert(owner, enrollment())
    const key = { ...owner, installationId: 'install-a' }
    const baselineSaves = saves
    hold = true
    const disabling = service.disable(key)
    await saveStarted
    const closing = service.close()
    const queuedDisable = service.disable(key)
    release()
    await expect(disabling).resolves.toBeUndefined()
    await closing
    await expect(queuedDisable).rejects.toThrow(/closed/u)
    expect(saves).toBe(baselineSaves + 1)
    expect(backing.inspect().registrations[0]?.generation).toBe(registered.registration.generation + 1)
  })

  it('does not revive a prepared enrollment when key reset is held at its durable save barrier', async () => {
    const backing = new MemoryPushStore()
    let arm = false
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const service = registry({ load: () => backing.load(), async save(snapshot) { if (arm) { arm = false; announce(); await gate }; await backing.save(snapshot) } })
    await service.initialize()
    const enabled = await service.upsert(owner, enrollment())
    arm = true
    const resetting = service.resetKeys()
    await started
    const prepared = service.upsert(owner, enrollment({ registrationGeneration: enabled.registration.generation }))
    release()
    await resetting
    await expect(prepared).rejects.toThrow(/generation/u)
    expect(backing.inspect().registrations).toHaveLength(0)
    await service.close()
  })

  it('ignores a stale conditional disable after distinct-key reset', async () => {
    const initialKeys = generateVapidKeys()
    const rotatedKeys = generateVapidKeys()
    expect(rotatedKeys.publicKey).not.toBe(initialKeys.publicKey)
    const generated = [initialKeys, rotatedKeys]
    let keyFactoryCalls = 0
    const service = new PushRegistry(new MemoryPushStore(), () => generated[keyFactoryCalls++]!)
    await service.initialize()
    const initial = await service.upsert(owner, enrollment({ keyFingerprint: fingerprintOf(initialKeys) }))
    await service.resetKeys()
    const config = await service.config(owner, 'install-a')
    const fresh = await service.upsert(owner, enrollment({
      keyFingerprint: fingerprintOf(rotatedKeys), ownerGeneration: config.ownerGeneration, registrationGeneration: config.registrationGeneration,
      subscription: { ...subscription, endpoint: 'https://push.apple.com/topic/fresh-after-reset' },
    }))
    expect(fresh.registration.generation).toBeGreaterThan(initial.registration.generation)
    await service.disable({ ...owner, installationId: 'install-a' }, initial.registration.generation)
    expect(service.snapshot().registrations[0]).toEqual(fresh.registration)
    await service.close()
  })

  it('ignores a stale gone result after distinct-key reset', async () => {
    const initialKeys = generateVapidKeys()
    const rotatedKeys = generateVapidKeys()
    expect(rotatedKeys.publicKey).not.toBe(initialKeys.publicKey)
    const generated = [initialKeys, rotatedKeys]
    let keyFactoryCalls = 0
    const service = new PushRegistry(new MemoryPushStore(), () => generated[keyFactoryCalls++]!)
    await service.initialize()
    const initial = await service.upsert(owner, enrollment({ keyFingerprint: fingerprintOf(initialKeys) }))
    const key = { ...owner, installationId: 'install-a' }
    await service.resetKeys()
    const config = await service.config(owner, 'install-a')
    const fresh = await service.upsert(owner, enrollment({
      keyFingerprint: fingerprintOf(rotatedKeys), ownerGeneration: config.ownerGeneration, registrationGeneration: config.registrationGeneration,
      subscription: { ...subscription, endpoint: 'https://push.apple.com/topic/fresh-after-reset-gone' },
    }))
    expect(fresh.registration.generation).toBeGreaterThan(initial.registration.generation)
    await service.settleRecipient(key, initial.registration.generation, 'gone')
    expect(service.snapshot().registrations[0]).toEqual(fresh.registration)
    await service.close()
  })

  it('ignores an old gone callback after a same-key recipient is removed and re-enrolled', async () => {
    const service = registry()
    await service.initialize()
    const initial = await service.upsert(owner, enrollment())
    const key = { ...owner, installationId: 'install-a' }
    await service.settleRecipient(key, initial.registration.generation, 'gone')
    const config = await service.config(owner, 'install-a')
    const fresh = await service.upsert(owner, enrollment({
      ownerGeneration: config.ownerGeneration, registrationGeneration: config.registrationGeneration,
      subscription: { ...subscription, endpoint: 'https://push.apple.com/topic/re-enrolled-after-gone' },
    }))
    expect(fresh.registration.generation).toBeGreaterThan(initial.registration.generation)
    await service.settleRecipient(key, initial.registration.generation, 'gone')
    expect(service.snapshot().registrations[0]).toEqual(fresh.registration)
    await service.close()
  })

  it('ignores a stale suspended outcome after reset assigns a nonrepeating recipient generation', async () => {
    const initialKeys = generateVapidKeys()
    const rotatedKeys = generateVapidKeys()
    expect(rotatedKeys.publicKey).not.toBe(initialKeys.publicKey)
    const generated = [initialKeys, rotatedKeys]
    let keyFactoryCalls = 0
    const service = new PushRegistry(new MemoryPushStore(), () => generated[keyFactoryCalls++]!)
    await service.initialize()
    const initial = await service.upsert(owner, enrollment({ keyFingerprint: fingerprintOf(initialKeys) }))
    const key = { ...owner, installationId: 'install-a' }
    await service.resetKeys()
    const config = await service.config(owner, 'install-a')
    const fresh = await service.upsert(owner, enrollment({
      keyFingerprint: fingerprintOf(rotatedKeys), ownerGeneration: config.ownerGeneration, registrationGeneration: config.registrationGeneration,
      subscription: { ...subscription, endpoint: 'https://push.apple.com/topic/fresh-after-reset-suspended' },
    }))
    await service.settleRecipient(key, initial.registration.generation, 'suspended')
    expect(service.snapshot().registrations[0]).toEqual(fresh.registration)
    expect(fresh.registration.generation).toBeGreaterThan(initial.registration.generation)
    await service.close()
  })

  it('rejects a pre-reset preference guard after distinct-key re-enrollment', async () => {
    const initialKeys = generateVapidKeys()
    const rotatedKeys = generateVapidKeys()
    expect(rotatedKeys.publicKey).not.toBe(initialKeys.publicKey)
    const initialFingerprint = fingerprintOf(initialKeys)
    const rotatedFingerprint = fingerprintOf(rotatedKeys)
    const generated = [initialKeys, rotatedKeys]
    let keyFactoryCalls = 0
    const store = new MemoryPushStore()
    const service = new PushRegistry(store, () => generated[keyFactoryCalls++]!)
    await service.initialize()
    const initial = await service.upsert(owner, enrollment({ keyFingerprint: initialFingerprint }))
    await service.resetKeys()
    const refreshed = await service.config(owner, 'install-a')
    expect(refreshed).toMatchObject({ ownerGeneration: 2, registrationGeneration: 0, keyFingerprint: rotatedFingerprint })
    const reenabled = await service.upsert(owner, enrollment({
      keyFingerprint: rotatedFingerprint,
      ownerGeneration: refreshed.ownerGeneration,
      registrationGeneration: refreshed.registrationGeneration,
      subscription: { ...subscription, endpoint: 'https://push.apple.com/topic/rotated-token' },
    }))
    expect(reenabled.registration.generation).toBe(initial.registration.generation + 2)
    const oldRecipient = { ...owner, installationId: 'install-a' }
    await expect(service.preferences(oldRecipient, { ...prefs, response: false }, {
      ownerGeneration: 0, registrationGeneration: initial.registration.generation,
    })).rejects.toThrow(/generation/u)
    expect(service.snapshot().registrations[0]).toEqual(reenabled.registration)
    await service.close()
  })

  it('sets reset floor above old floor, every owner row, and every removed registration', async () => {
    const otherOwner = { ...owner, deviceId: 'device-b' }
    const store = new MemoryPushStore(pushSnapshot({
      ownerGenerationFloor: 10,
      ownerGenerations: [{ ...owner, generation: 4 }, { ...otherOwner, generation: 8 }],
      registrations: [
        storedRegistration(owner, 'install-a', 20, 'https://web.push.apple.com/topic/reset-20'),
        storedRegistration(otherOwner, 'install-b', 18, 'https://web.push.apple.com/topic/reset-18'),
      ],
    }))
    const service = registry(store)
    await service.initialize()
    await service.resetKeys()
    expect(service.snapshot().ownerGenerationFloor).toBe(21)
    expect(service.snapshot().registrations).toEqual([])
    expect(service.snapshot().pending).toEqual([])
    expect(service.snapshot().receipts).toEqual([])
    expect(service.snapshot().references).toEqual([])
    await service.close()
  })

  it('defaults a legacy snapshot to zero and retains the reset floor after registry restart', async () => {
    const store = new MemoryPushStore()
    const service = registry(store)
    await service.initialize()
    await expect(service.config(owner, 'install-a')).resolves.toMatchObject({ ownerGeneration: 0, registrationGeneration: 0 })
    await service.upsert(owner, enrollment())
    await service.resetKeys()
    expect(service.snapshot().ownerGenerationFloor).toBe(2)
    await service.close()
    const restarted = registry(store)
    await restarted.initialize()
    expect(await restarted.config(owner, 'install-a')).toMatchObject({ ownerGeneration: 2, registrationGeneration: 0 })
    await restarted.close()
  })

  it('fails closed on lost key material when registrations already exist', async () => {
    const store = new MemoryPushStore()
    const service = registry(store)
    await service.initialize()
    const reg = await service.upsert(owner, enrollment())
    const { keys: _keys, ...withoutKeys } = store.inspect()
    await store.save(withoutKeys)
    const recovered = registry(store)
    await recovered.initialize()
    await expect(recovered.publicKey()).rejects.toThrow(/repair/u)
    expect(store.inspect().registrations[0]?.health).toBe('repair-required')
    expect(reg.registration.enabled).toBe(true)
    await service.close()
    await recovered.close()
  })

  it('marks corrupted persisted VAPID material repair-required without generating replacements', async () => {
    const store = new MemoryPushStore()
    const service = registry(store)
    await service.initialize()
    await service.upsert(owner, enrollment())
    const before = store.inspect()
    const corruptPublic = Buffer.from(keys.publicKey, 'base64url')
    corruptPublic[1] = (corruptPublic[1] ?? 0) ^ 1
    await store.save({ ...before, keys: { ...before.keys!, publicKey: corruptPublic.toString('base64url') } })
    const recovered = registry(store)
    await recovered.initialize()
    await expect(recovered.publicKey()).rejects.toThrow(/repair/u)
    expect(store.inspect().keys?.fingerprint).toBe(keyFingerprint)
    expect(store.inspect().registrations[0]?.health).toBe('repair-required')
    await service.close()
    await recovered.close()
  })

  it('holds the purge floor with the state until the durable save completes', async () => {
    const initial = pushSnapshot({
      ownerGenerationFloor: 4,
      ownerGenerations: [{ ...owner, generation: 6 }],
      registrations: [storedRegistration(owner, 'install-a', 10, 'https://web.push.apple.com/topic/barrier-purge')],
    })
    const backing = new MemoryPushStore(initial)
    let hold = false
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const service = registry({
      load: () => backing.load(),
      async save(snapshot) { if (hold) { hold = false; announce(); await gate }; await backing.save(snapshot) },
    })
    await service.initialize()
    hold = true
    const purging = service.purgeDevices('scope-a', [owner.deviceId])
    await started
    expect(backing.inspect()).toEqual(initial)
    await expect(service.config(owner, 'install-a')).resolves.toMatchObject({ ownerGeneration: 6, registrationGeneration: 10, status: 'enabled' })
    release()
    await purging
    expect(backing.inspect().ownerGenerationFloor).toBe(11)
    expect(backing.inspect().registrations).toEqual([])
    await service.close()
  })

  it('keeps registry state unchanged when a durable purge save fails', async () => {
    const initial = pushSnapshot({
      ownerGenerationFloor: 4,
      ownerGenerations: [{ ...owner, generation: 6 }],
      registrations: [storedRegistration(owner, 'install-a', 10, 'https://web.push.apple.com/topic/failed-purge')],
    })
    const backing = new MemoryPushStore(initial)
    const service = registry({ load: () => backing.load(), async save() { throw new Error('durable save failed') } })
    await service.initialize()
    await expect(service.purgeDevices('scope-a', [owner.deviceId])).rejects.toThrow('durable save failed')
    expect(backing.inspect()).toEqual(initial)
    expect(service.snapshot()).toEqual(initial)
    await service.close()
  })

  it('makes empty device purge a no-op but advances the global floor for an unknown withdrawn id', async () => {
    const backing = new MemoryPushStore(pushSnapshot())
    let saves = 0
    const service = registry({ load: () => backing.load(), async save(snapshot) { saves++; await backing.save(snapshot) } })
    await service.initialize()
    const before = backing.inspect()
    await service.purgeDevices('scope-a', [])
    expect(backing.inspect()).toEqual(before)
    expect(saves).toBe(0)
    await service.purgeDevices('scope-a', ['device-a'])
    expect(service.snapshot().ownerGenerationFloor).toBe(1)
    await expect(service.config(owner, 'install-a')).resolves.toMatchObject({ ownerGeneration: 1, registrationGeneration: 0 })
    await expect(service.upsert(owner, enrollment({ ownerGeneration: 0 }))).rejects.toThrow(/generation/u)
    await service.close()
  })

  it('advances from max row and removed-recipient generations without changing other consent', async () => {
    const otherOwner = { ...owner, deviceId: 'device-b' }
    const removed = storedRegistration(owner, 'install-a', 20, 'https://web.push.apple.com/topic/removed-20')
    const preserved = storedRegistration(otherOwner, 'install-b', 3, 'https://web.push.apple.com/topic/preserved-3')
    const store = new MemoryPushStore(pushSnapshot({
      ownerGenerationFloor: 2,
      ownerGenerations: [{ ...owner, generation: 4 }, { ...otherOwner, generation: 8 }],
      registrations: [removed, preserved],
    }))
    const service = registry(store)
    await service.initialize()
    await service.purgeDevices('scope-a', [owner.deviceId])
    expect(store.inspect().ownerGenerationFloor).toBe(21)
    expect(store.inspect().ownerGenerations).toEqual([{ ...otherOwner, generation: 8 }])
    expect(store.inspect().registrations).toEqual([preserved])
    await expect(service.config(otherOwner, 'install-b')).resolves.toMatchObject({ ownerGeneration: 21, registrationGeneration: 3, status: 'enabled' })
    const otherKey = { ...otherOwner, installationId: 'install-b' }
    await expect(service.preferences(otherKey, { ...prefs, response: false }, { ownerGeneration: 8, registrationGeneration: 3 })).rejects.toThrow(/generation/u)
    const changed = await service.preferences(otherKey, { ...prefs, response: false }, { ownerGeneration: 21, registrationGeneration: 3 })
    expect(changed).toMatchObject({ enabled: true, generation: 4, preferences: { ...prefs, response: false } })
    await service.close()
  })

  it('rejects a floor advance that would exceed safe integer range without committing', async () => {
    const floor = Number.MAX_SAFE_INTEGER
    const store = new MemoryPushStore(pushSnapshot({ ownerGenerationFloor: floor }))
    const service = registry(store)
    await service.initialize()
    await expect(service.purgeDevices('scope-a', ['unknown-device'])).rejects.toThrow(/safe|generation floor/u)
    expect(store.inspect().ownerGenerationFloor).toBe(floor)
    await service.close()
  })

  it('settles gone at the owner-row cap without inserting a tombstone', async () => {
    const ownerRows = Array.from({ length: 1024 }, (_, index) => ({
      scopeId: 'scope-a', deviceId: `retired-${String(index).padStart(4, '0')}`, origin: owner.origin, generation: 5,
    }))
    const goneOwner = { ...owner, deviceId: 'gone-device' }
    const goneRegistration = storedRegistration(goneOwner, 'gone-install', 20, 'https://web.push.apple.com/topic/gone-at-cap')
    const store = new MemoryPushStore(pushSnapshot({ ownerGenerations: ownerRows, registrations: [goneRegistration] }))
    const service = registry(store)
    await service.initialize()
    await service.settleRecipient({ ...goneOwner, installationId: 'gone-install' }, 20, 'gone')
    expect(store.inspect().ownerGenerationFloor).toBe(21)
    expect(store.inspect().registrations).toEqual([])
    expect(store.inspect().ownerGenerations).toHaveLength(1024)
    expect(store.inspect().ownerGenerations.some(row => row.deviceId === 'gone-device')).toBe(false)
    await service.close()
  })

  it('reclaims only selected retired owners at the generation cap without reviving their stale guards', async () => {
    const retired = Array.from({ length: 1024 }, (_, index) => ({
      scopeId: 'scope-a', deviceId: `retired-${String(index).padStart(4, '0')}`, origin: owner.origin, generation: 5,
    }))
    const store = new MemoryPushStore({ version: 1, keys: { ...keys, fingerprint: keyFingerprint }, ownerGenerations: retired, registrations: [], pending: [], receipts: [], references: [] })
    const service = registry(store)
    await service.initialize()
    const purgedOwner = { ...owner, deviceId: 'retired-0000' }
    await service.purgeDevices('scope-a', [purgedOwner.deviceId])
    await expect(service.upsert(purgedOwner, enrollment({
      installationId: 'old-install', ownerGeneration: 5, registrationGeneration: 0,
      subscription: { ...subscription, endpoint: 'https://push.apple.com/topic/old-install' },
    }))).rejects.toThrow(/generation/u)
    await expect(service.disable({ ...owner, deviceId: 'new-device', installationId: 'new-install' })).resolves.toBeUndefined()
    const ownerRows = store.inspect().ownerGenerations
    expect(ownerRows).toHaveLength(1024)
    expect(ownerRows.some(row => row.deviceId === purgedOwner.deviceId)).toBe(false)
    expect(ownerRows.some(row => row.deviceId === 'retired-0001')).toBe(true)
    expect(ownerRows.some(row => row.deviceId === 'new-device')).toBe(true)
    await service.close()
  })

  it('rejects a registration beyond the authorization-scope limit without evicting an owner', async () => {
    const rows = Array.from({ length: 256 }, (_, index) => ({
      scopeId: 'scope-a', deviceId: `device-${index}`, origin: owner.origin, installationId: `i-${index}`,
      subscription: { endpoint: `https://push.apple.com/${index}`, keys: { p256dh: 'p', auth: 'a' } }, locale: 'en' as const,
      preferences: prefs, generation: 1, keyFingerprint, enabled: true, health: 'ready' as const,
    }))
    const store = new MemoryPushStore({ version: 1, keys: { ...keys, fingerprint: keyFingerprint }, ownerGenerations: [], registrations: rows, pending: [], receipts: [], references: [] })
    const service = registry(store)
    await service.initialize()
    await expect(service.upsert({ ...owner, deviceId: 'device-overflow' }, enrollment({ installationId: 'overflow' }))).rejects.toThrow(/scope/u)
    expect(store.inspect().registrations).toHaveLength(256)
    await service.close()
  })

  it('never stores user prompt or tool text in push state', async () => {
    const store = new MemoryPushStore()
    const service = registry(store)
    await service.initialize()
    await service.upsert(owner, enrollment())
    const persisted = JSON.stringify(store.inspect())
    expect(persisted).not.toContain('question text')
    expect(persisted).not.toContain('tool arguments')
    await service.close()
  })
})
