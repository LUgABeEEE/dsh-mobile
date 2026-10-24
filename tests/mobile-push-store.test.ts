import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonPushStore, MemoryPushStore } from '../src/mobile-push/store.js'
import type { PushSnapshot } from '../src/mobile-push/contracts.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function root() { const path = await mkdtemp(join(tmpdir(), 'dsh-mobile-push-store-')); roots.push(path); return path }
const empty: PushSnapshot = { version: 1, ownerGenerations: [], registrations: [], pending: [], receipts: [], references: [] }

describe('private push snapshot stores', () => {
  it('round-trips versioned snapshots and returns defensive memory copies', async () => {
    const store = new MemoryPushStore()
    const input = structuredClone(empty)
    await store.save(input)
    const loaded = await store.load()
    expect(loaded).toEqual(empty)
    expect(loaded).not.toBe(input)
  })

  it('round-trips a safe owner-generation floor and accepts legacy snapshots without one', async () => {
    const legacy = new MemoryPushStore(empty)
    expect(legacy.inspect()).toEqual(empty)
    const withFloor: PushSnapshot = { ...empty, ownerGenerationFloor: 9 }
    const store = new MemoryPushStore(withFloor)
    await store.save(withFloor)
    expect(await store.load()).toEqual(withFloor)
    expect(store.inspect().ownerGenerationFloor).toBe(9)
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid owner-generation floor (%s)', floor => {
    const invalid = { ...empty, ownerGenerationFloor: floor }
    expect(() => new MemoryPushStore(invalid)).toThrow(/owner generation floor/u)
  })

  it('persists the owner-generation floor across a JSON store restart', async () => {
    const file = join(await root(), 'notifications', 'state-v1.json')
    const first = new JsonPushStore(file)
    const withFloor: PushSnapshot = { ...empty, ownerGenerationFloor: 9 }
    await first.save(withFloor)
    expect(await new JsonPushStore(file).load()).toEqual(withFloor)
  })

  it('persists key material atomically with owner-only file permissions', async () => {
    const file = join(await root(), 'notifications', 'state-v1.json')
    const first = new JsonPushStore(file)
    const withKeys: PushSnapshot = { ...empty, keys: { publicKey: 'public-A', privateKey: 'private-A', fingerprint: 'fingerprint-A' } }
    await first.save(withKeys)
    const mode = (await import('node:fs/promises')).stat(file).then(s => s.mode & 0o777)
    expect(await mode).toBe(0o600)
    const raw = await readFile(file, 'utf8')
    expect(JSON.parse(raw)).toEqual(withKeys)
    expect(await new JsonPushStore(file).load()).toEqual(withKeys)
    expect(raw).not.toContain('question text')
  })

  it('rejects symlinks, non-files, oversized snapshots, and corrupt JSON', async () => {
    const dir = await root()
    const target = join(dir, 'target.json')
    const link = join(dir, 'link.json')
    await writeFile(target, JSON.stringify(empty))
    await symlink(target, link)
    await expect(new JsonPushStore(link).load()).rejects.toThrow(/regular file/u)
    await expect(new JsonPushStore(dir).load()).rejects.toThrow(/regular file/u)
    const huge = join(dir, 'huge.json')
    await writeFile(huge, ' '.repeat(4 * 1024 * 1024 + 1))
    await expect(new JsonPushStore(huge).load()).rejects.toThrow(/4 MiB/u)
    const corrupt = join(dir, 'corrupt.json')
    await writeFile(corrupt, '{')
    await expect(new JsonPushStore(corrupt).load()).rejects.toThrow(/valid JSON/u)
  })

  it('refuses a symlinked parent and rejects text-bearing intent records', async () => {
    const dir = await root()
    const real = join(dir, 'real')
    const alias = join(dir, 'alias')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(real)
    await symlink(real, alias)
    await expect(new JsonPushStore(join(alias, 'state.json')).save(empty)).rejects.toThrow(/symlink/u)
    if (process.platform !== 'win32') {
      const insecure = join(dir, 'insecure')
      await mkdir(insecure)
      const { chmod } = await import('node:fs/promises')
      await chmod(insecure, 0o755)
      await expect(new JsonPushStore(join(insecure, 'state.json')).save(empty)).rejects.toThrow(/owner-only/u)
    }
    const leaking = { ...empty, pending: [{ id: 'x', key: { scopeId: 's', deviceId: 'd', origin: 'https://x', installationId: 'i' }, source: { sourceId: 'x', sessionId: 's', targetSessionId: 's', category: 'question', createdAt: 1, expiresAt: 2, lifetime: 'live', question: 'private question text' }, ownerGeneration: 0, recipientGeneration: 0, attempts: 0, nextAttemptAt: 1 }] }
    await expect(new MemoryPushStore().save(leaking as unknown as PushSnapshot)).rejects.toThrow(/invalid records/u)
  })

  it('rejects case and default-port aliases of an already-owned Apple endpoint', () => {
    const registrations = [
      { scopeId: 'scope-a', deviceId: 'device-a', origin: 'https://mobile.example.test', installationId: 'install-a', subscription: { endpoint: 'https://web.push.apple.com/topic/token-a', keys: { p256dh: 'p', auth: 'a' } }, locale: 'en' as const, preferences: { question: true, plan: true, approval: true, response: true, goal: true, failure: true }, generation: 1, keyFingerprint: 'fp', enabled: true, health: 'ready' as const },
      { scopeId: 'scope-a', deviceId: 'device-b', origin: 'https://mobile.example.test', installationId: 'install-b', subscription: { endpoint: 'https://WEB.PUSH.APPLE.COM:443/topic/token-a', keys: { p256dh: 'q', auth: 'b' } }, locale: 'en' as const, preferences: { question: true, plan: true, approval: true, response: true, goal: true, failure: true }, generation: 1, keyFingerprint: 'fp', enabled: true, health: 'ready' as const },
    ]
    expect(() => new MemoryPushStore({ version: 1, keys: { publicKey: 'public', privateKey: 'private', fingerprint: 'fp' }, ownerGenerations: [], registrations, pending: [], receipts: [], references: [] })).toThrow(/duplicate ownership/u)
  })

  it('leaves the last valid state intact when a replacement is rejected', async () => {
    const file = join(await root(), 'state.json')
    const store = new JsonPushStore(file)
    await store.save(empty)
    await expect(store.save({ ...empty, version: 9 } as unknown as PushSnapshot)).rejects.toThrow()
    expect(await store.load()).toEqual(empty)
  })
})
