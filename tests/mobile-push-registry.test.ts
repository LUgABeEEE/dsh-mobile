import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MemoryPushStore } from '../src/mobile-push/store.js'
import { PushRegistry } from '../src/mobile-push/registry.js'
import type { PushOwner, PushPreferences, VapidKeys } from '../src/mobile-push/contracts.js'

const prefs: PushPreferences = { question: true, plan: true, approval: true, response: true, goal: true, failure: true }
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' })
const keys: VapidKeys = { publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(pair.x!, 'base64url'), Buffer.from(pair.y!, 'base64url')]).toString('base64url'), privateKey: pair.d! }
const owner: PushOwner = { scopeId: 'scope-a', deviceId: 'device-a', origin: 'https://mobile.example.test' }
const subscription = { endpoint: 'https://push.apple.com/topic/token-a', keys: { p256dh: 'p256dh-a', auth: 'auth-a' } }
const keyFingerprint = createHash('sha256').update(Buffer.from(keys.publicKey, 'base64url')).digest('hex')
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
    await service.transact(snapshot => ({ ...snapshot, receipts: [{ sourceId: 'source-opaque', key: { ...owner, installationId: 'install-a' }, recipientGeneration: 0, expiresAt: Date.now() + 60_000 }] }))
    expect(service.snapshot().receipts).toHaveLength(1)
    const source = { sourceId: 'source-opaque', sessionId: 'session-id', targetSessionId: 'session-id', category: 'response' as const, createdAt: Date.now(), expiresAt: Date.now() + 60_000, lifetime: 'committed' as const }
    await service.transact(snapshot => ({ ...snapshot, references: [{ reference: 'opaque-tap-ref', key: { ...owner, installationId: 'install-a' }, source, expiresAt: source.expiresAt }] }))
    expect(service.snapshot().references).toHaveLength(1)
    await expect(service.transact(snapshot => ({ ...snapshot, registrations: [{ ...snapshot.registrations[0]!, enabled: true }] }))).rejects.toThrow(/only update delivery state/u)
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
    expect((await service.config(owner, 'install-a')).ownerGeneration).toBe(1)
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

  it('rejects a fifth registration on one device without evicting prior installations', async () => {
    const store = new MemoryPushStore()
    const service = registry(store)
    await service.initialize()
    for (let n = 0; n < 4; n++) await service.upsert(owner, enrollment({ installationId: `install-${n}`, subscription: { ...subscription, endpoint: `${subscription.endpoint}-${n}` } }))
    await expect(service.upsert(owner, enrollment({ installationId: 'install-overflow', subscription: { ...subscription, endpoint: `${subscription.endpoint}-overflow` } }))).rejects.toThrow(/limit/u)
    expect(store.inspect().registrations).toHaveLength(4)
    await service.close()
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
