import { createECDH, createHash } from 'node:crypto'
import { canonicalPushEndpoint } from './endpoint.js'
import { MAX_PENDING_PER_SCOPE, MAX_REGISTRATIONS_PER_DEVICE, MAX_REGISTRATIONS_PER_SCOPE } from './contracts.js'
import type { PushConfig, PushEnrollment, PushEnrollmentResult, PushMutationGuard, PushOwner, PushPreferences, PushRecipientKey, PushRegistration, PushSnapshot, VapidKeys } from './contracts.js'

export interface PushStore { load(): Promise<PushSnapshot>; save(snapshot: PushSnapshot): Promise<void> }
const empty = (): PushSnapshot => ({ version: 1, ownerGenerations: [], registrations: [], pending: [], receipts: [], references: [] })
const idOfOwner = (owner: PushOwner) => JSON.stringify([owner.scopeId, owner.deviceId, owner.origin])
const idOfKey = (key: PushRecipientKey) => JSON.stringify([key.scopeId, key.deviceId, key.origin, key.installationId])
const sameOwner = (a: PushOwner, b: PushOwner) => idOfOwner(a) === idOfOwner(b)
export function vapidFingerprint(keys: VapidKeys): string {
  const rawPublic = Buffer.from(keys.publicKey, 'base64url')
  if (rawPublic.length !== 65 || rawPublic[0] !== 4 || rawPublic.toString('base64url') !== keys.publicKey) throw new Error('invalid uncompressed VAPID public key')
  const privateBytes = Buffer.from(keys.privateKey, 'base64url')
  if (privateBytes.length !== 32 || privateBytes.toString('base64url') !== keys.privateKey) throw new Error('invalid VAPID private key')
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(privateBytes)
  if (!ecdh.getPublicKey(undefined, 'uncompressed').equals(rawPublic)) throw new Error('VAPID public and private keys do not match')
  return createHash('sha256').update(rawPublic).digest('hex')
}
const fingerprint = vapidFingerprint
const defaultPreferences: PushPreferences = { question: true, plan: true, approval: true, response: true, goal: true, failure: true }
function clone<T>(value: T): T { return structuredClone(value) }
function boundedText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new Error(`invalid ${label}`)
}

/** Serializes and durably commits all push ownership and consent mutations. */
export class PushRegistry {
  private state: PushSnapshot = empty()
  private initialized = false
  private closed = false
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly store: PushStore, private readonly createKeys: () => VapidKeys) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => { if (this.closed) throw new Error('push registry is closed'); return operation() })
    this.queue = result.catch(() => undefined)
    return result
  }
  private assertReady() { if (!this.initialized) throw new Error('push registry is not initialized') }
  private ownerGeneration(owner: PushOwner): number {
    return Math.max(this.state.ownerGenerationFloor ?? 0, this.state.ownerGenerations.find(item => sameOwner(item, owner))?.generation ?? 0)
  }
  private advanceOwnerGenerationFloor(snapshot: PushSnapshot, removedRegistrationGenerations: readonly number[] = []): PushSnapshot {
    let maximum = snapshot.ownerGenerationFloor ?? 0
    for (const row of snapshot.ownerGenerations) maximum = Math.max(maximum, row.generation)
    for (const generation of removedRegistrationGenerations) maximum = Math.max(maximum, generation)
    if (!Number.isSafeInteger(maximum) || maximum >= Number.MAX_SAFE_INTEGER) throw new Error('owner generation floor exceeds safe integer range')
    return { ...snapshot, ownerGenerationFloor: maximum + 1 }
  }
  private async commit(next: PushSnapshot): Promise<void> { await this.store.save(next); this.state = next }
  private putOwnerGeneration(next: PushSnapshot, owner: PushOwner, generation: number): PushSnapshot {
    const rows = [...next.ownerGenerations]
    const index = rows.findIndex(item => sameOwner(item, owner))
    if (index >= 0) rows[index] = { ...rows[index]!, generation }
    else {
      const count = rows.filter(item => item.scopeId === owner.scopeId).length
      if (count >= 1024) throw new Error('owner generation limit reached for authorization scope')
      rows.push({ scopeId: owner.scopeId, deviceId: owner.deviceId, origin: owner.origin, generation })
    }
    return { ...next, ownerGenerations: rows }
  }
  async initialize(): Promise<void> {
    await this.serialize(async () => {
      let loaded = await this.store.load()
      let keyIntegrity = false
      try { keyIntegrity = !!loaded.keys && loaded.keys.fingerprint === fingerprint(loaded.keys) } catch (_error) { keyIntegrity = false }
      if (!keyIntegrity) {
        if (loaded.registrations.length) {
          loaded = { ...loaded, registrations: loaded.registrations.map(reg => ({ ...reg, health: 'repair-required' })) }
          await this.store.save(loaded)
        } else {
          const keys = this.createKeys()
          if (!keys || typeof keys.publicKey !== 'string' || !keys.publicKey || typeof keys.privateKey !== 'string' || !keys.privateKey) throw new Error('key factory returned invalid VAPID keys')
          loaded = { ...loaded, keys: { ...keys, fingerprint: fingerprint(keys) } }
          await this.store.save(loaded)
        }
      }
      this.state = clone(loaded)
      this.initialized = true
    })
  }
  async publicKey(): Promise<string> { this.assertReady(); if (!this.state.keys || this.state.registrations.some(reg => reg.health === 'repair-required')) throw new Error('push VAPID keys require repair'); return this.state.keys.publicKey }
  async config(owner: PushOwner, installationId: string): Promise<PushConfig> {
    this.assertReady()
    const key: PushRecipientKey = { ...owner, installationId }
    const registration = this.state.registrations.find(row => idOfKey(row) === idOfKey(key))
    const keyUsable = !!this.state.keys && !this.state.registrations.some(row => row.health === 'repair-required')
    return {
      available: keyUsable, ...(keyUsable ? { publicKey: this.state.keys!.publicKey, keyFingerprint: this.state.keys!.fingerprint } : {}),
      installationId, ownerGeneration: this.ownerGeneration(owner), registrationGeneration: registration?.generation ?? 0,
      status: registration?.health === 'repair-required' ? 'repair-required' : registration?.health === 'suspended' ? 'suspended' : registration?.enabled ? 'enabled' : 'disabled',
      preferences: clone(registration?.preferences ?? defaultPreferences),
    }
  }
  /** Server-internal persistence snapshot; includes private VAPID material and is not a public config projection. */
  snapshot(): PushSnapshot { this.assertReady(); return clone(this.state) }
  async transact(update: (snapshot: PushSnapshot) => PushSnapshot): Promise<void> {
    await this.serialize(async () => {
      this.assertReady()
      const next = update(clone(this.state))
      if (JSON.stringify(next.keys) !== JSON.stringify(this.state.keys)
        || next.ownerGenerationFloor !== this.state.ownerGenerationFloor
        || JSON.stringify(next.ownerGenerations) !== JSON.stringify(this.state.ownerGenerations)
        || JSON.stringify(next.registrations) !== JSON.stringify(this.state.registrations)) throw new Error('push transactions may only update delivery state')
      const validated = { ...next, ...this.pruneExpired(next) }
      await this.commit(validated)
    })
  }

  async upsert(owner: PushOwner, input: PushEnrollment): Promise<PushEnrollmentResult> {
    return this.serialize(async () => {
      this.assertReady()
      boundedText(owner.scopeId, 'scope'); boundedText(owner.deviceId, 'device'); boundedText(owner.origin, 'origin')
      boundedText(input.installationId, 'installation'); boundedText(input.keyFingerprint, 'key fingerprint')
      boundedText(input.subscription?.endpoint, 'subscription endpoint')
      const canonicalEndpoint = canonicalPushEndpoint(input.subscription.endpoint)
      const normalizedSubscription = { ...input.subscription, endpoint: canonicalEndpoint }
      if (!normalizedSubscription.keys?.p256dh || !normalizedSubscription.keys.auth) throw new Error('invalid subscription keys')
      if (!this.state.keys || input.keyFingerprint !== this.state.keys.fingerprint) throw new Error('subscription VAPID key fingerprint conflict')
      const key: PushRecipientKey = { ...owner, installationId: input.installationId }
      const current = this.state.registrations.find(reg => idOfKey(reg) === idOfKey(key))
      const sameEndpoint = this.state.registrations.find(reg => canonicalPushEndpoint(reg.subscription.endpoint) === canonicalEndpoint)
      if (sameEndpoint && !sameOwner(sameEndpoint, owner)) throw new Error('subscription endpoint is already owned by another device (conflict)')
      if (sameEndpoint && !current) {
        if (sameEndpoint.keyFingerprint !== input.keyFingerprint || !sameEndpoint.enabled) throw new Error('canonical subscription recovery conflict')
        return { registration: clone(sameEndpoint) }
      }
      const ownerGeneration = this.ownerGeneration(owner)
      if (input.ownerGeneration !== ownerGeneration || input.registrationGeneration !== (current?.generation ?? 0)) throw new Error('stale push mutation generation')
      if (current?.enabled && canonicalPushEndpoint(current.subscription.endpoint) === canonicalEndpoint && current.locale === input.locale && JSON.stringify(current.preferences) === JSON.stringify(input.preferences) && current.keyFingerprint === input.keyFingerprint) return { registration: clone(current) }
      if (!current && this.state.registrations.filter(reg => reg.scopeId === owner.scopeId).length >= MAX_REGISTRATIONS_PER_SCOPE) throw new Error('push registration limit reached for scope')
      if (!current && this.state.registrations.filter(reg => sameOwner(reg, owner)).length >= MAX_REGISTRATIONS_PER_DEVICE) throw new Error('push registration limit reached for device')
      const generation = current ? current.generation + 1 : ownerGeneration + 1
      const registration: PushRegistration = { ...key, subscription: clone(normalizedSubscription), locale: input.locale, preferences: clone(input.preferences), generation, keyFingerprint: input.keyFingerprint, enabled: true, health: 'ready' }
      let next: PushSnapshot = { ...this.state, registrations: [...this.state.registrations.filter(reg => idOfKey(reg) !== idOfKey(key)), registration] }
      next = this.pruneExpired(next)
      if (next.pending.filter(intent => intent.key.scopeId === owner.scopeId).length > MAX_PENDING_PER_SCOPE) throw new Error('pending push limit reached for scope')
      await this.commit(next)
      return { registration: clone(registration), mutationGeneration: generation }
    })
  }
  async preferences(key: PushRecipientKey, value: PushPreferences, guard: PushMutationGuard): Promise<PushRegistration> {
    return this.serialize(async () => {
      this.assertReady(); const reg = this.state.registrations.find(row => idOfKey(row) === idOfKey(key))
      if (!reg || guard.ownerGeneration !== this.ownerGeneration(key) || guard.registrationGeneration !== reg.generation) throw new Error('stale push mutation generation')
      if (!value || !['question', 'plan', 'approval', 'response', 'goal', 'failure'].every(k => typeof value[k as keyof PushPreferences] === 'boolean')) throw new Error('invalid push preferences')
      const updated = { ...reg, preferences: clone(value), generation: reg.generation + 1 }
      await this.commit({ ...this.state, registrations: this.state.registrations.map(row => idOfKey(row) === idOfKey(key) ? updated : row) })
      return clone(updated)
    })
  }
  async disable(key: PushRecipientKey, ifGeneration?: number): Promise<void> {
    await this.serialize(async () => {
      this.assertReady(); const reg = this.state.registrations.find(row => idOfKey(row) === idOfKey(key))
      if (ifGeneration !== undefined && reg?.generation !== ifGeneration) return
      let next = this.state
      if (reg) next = { ...next, registrations: next.registrations.map(row => idOfKey(row) === idOfKey(key) ? { ...row, enabled: false, generation: row.generation + 1 } : row) }
      next = this.putOwnerGeneration(next, key, this.ownerGeneration(key) + 1)
      next = { ...next, pending: next.pending.filter(intent => idOfKey(intent.key) !== idOfKey(key)) }
      await this.commit(next)
    })
  }
  async settleRecipient(key: PushRecipientKey, expectedGeneration: number, result: 'gone' | 'suspended'): Promise<void> {
    await this.serialize(async () => {
      this.assertReady()
      const registration = this.state.registrations.find(row => idOfKey(row) === idOfKey(key))
      if (!registration || registration.generation !== expectedGeneration) return
      if (result === 'gone') {
        const withFloor = this.advanceOwnerGenerationFloor(this.state, [registration.generation])
        const next: PushSnapshot = {
          ...withFloor,
          registrations: this.state.registrations.filter(row => idOfKey(row) !== idOfKey(key)),
          pending: this.state.pending.filter(row => idOfKey(row.key) !== idOfKey(key)),
          receipts: this.state.receipts.filter(row => idOfKey(row.key) !== idOfKey(key)),
          references: this.state.references.filter(row => idOfKey(row.key) !== idOfKey(key)),
        }
        await this.commit(next)
      } else {
        const updated = { ...registration, health: 'suspended' as const, generation: registration.generation + 1 }
        await this.commit({ ...this.state, registrations: this.state.registrations.map(row => idOfKey(row) === idOfKey(key) ? updated : row) })
      }
    })
  }
  async disableOwner(owner: PushOwner): Promise<void> {
    await this.serialize(async () => {
      this.assertReady(); let next = this.state
      next = { ...next, registrations: next.registrations.map(reg => sameOwner(reg, owner) ? { ...reg, enabled: false, generation: reg.generation + 1 } : reg), pending: next.pending.filter(intent => !sameOwner(intent.key, owner)) }
      next = this.putOwnerGeneration(next, owner, this.ownerGeneration(owner) + 1)
      await this.commit(next)
    })
  }
  async purgeDevices(scopeId: string, ids: readonly string[]): Promise<void> {
    await this.serialize(async () => {
      this.assertReady()
      if (ids.length === 0) return
      const selected = new Set(ids)
      const remove = (key: PushOwner) => key.scopeId === scopeId && selected.has(key.deviceId)
      const removedRegistrationGenerations = this.state.registrations.filter(reg => remove(reg)).map(reg => reg.generation)
      const withFloor = this.advanceOwnerGenerationFloor(this.state, removedRegistrationGenerations)
      const next: PushSnapshot = {
        ...withFloor,
        ownerGenerations: withFloor.ownerGenerations.filter(row => !remove(row)),
        registrations: withFloor.registrations.filter(reg => !remove(reg)),
        pending: withFloor.pending.filter(intent => !remove(intent.key)),
        receipts: withFloor.receipts.filter(row => !remove(row.key)),
        references: withFloor.references.filter(row => !remove(row.key)),
      }
      await this.commit(next)
    })
  }
  async resetKeys(): Promise<void> {
    await this.serialize(async () => {
      this.assertReady()
      const withFloor = this.advanceOwnerGenerationFloor(this.state, this.state.registrations.map(reg => reg.generation))
      const keys = this.createKeys()
      const nextKeys = { ...keys, fingerprint: fingerprint(keys) }
      const next: PushSnapshot = { ...withFloor, keys: nextKeys, ownerGenerations: [], registrations: [], pending: [], receipts: [], references: [] }
      await this.commit(next)
    })
  }
  async close(): Promise<void> { await this.queue; this.closed = true }
  private pruneExpired(snapshot: PushSnapshot): PushSnapshot {
    const now = Date.now()
    const pending = snapshot.pending.filter(item => item.source.expiresAt > now)
    return { ...snapshot, pending, receipts: snapshot.receipts.filter(item => item.expiresAt > now), references: snapshot.references.filter(item => item.expiresAt > now) }
  }
}
