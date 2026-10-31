import { describe, expect, it } from 'vitest'
import {
  ContentCache,
  matchesContentCachePath,
  normalizeContentCachePaths,
} from '../src/content-cache.js'

const PATH = '/api/sessions'

function cache(options: {
  ttlMs?: number
  maxBytes?: number
  maxEntries?: number
  paths?: readonly string[]
  maxEntryBytes?: number
} = {}): ContentCache {
  return new ContentCache(
    options.ttlMs ?? 1_000,
    options.maxBytes ?? 64 * 1024,
    options.maxEntries ?? 1_024,
    options.paths ?? [PATH],
    options.maxEntryBytes ?? 8 * 1024,
  )
}

function body(text: string): Buffer {
  return Buffer.from(text)
}

describe('content cache path allowlist', () => {
  it('matches the configured path and its subpaths, never a longer sibling', () => {
    expect(matchesContentCachePath([PATH], '/api/sessions')).toBe(true)
    expect(matchesContentCachePath([PATH], '/api/sessions?limit=20')).toBe(true)
    expect(matchesContentCachePath([PATH], '/api/sessions/abc')).toBe(true)
    // `/api/sessions-cookie` is a different route, not a subpath.
    expect(matchesContentCachePath([PATH], '/api/sessions-cookie')).toBe(false)
    expect(matchesContentCachePath([PATH], '/api/session')).toBe(false)
    expect(matchesContentCachePath([PATH], '/assets/sessions')).toBe(false)
    expect(matchesContentCachePath([], '/api/sessions')).toBe(false)
  })

  it('normalizes configured prefixes and rejects unusable ones', () => {
    expect(normalizeContentCachePaths([' /api/sessions/ ', '/api/sessions'])).toEqual([PATH])
    expect(normalizeContentCachePaths(['/api/workspaces'])).toEqual(['/api/workspaces'])
    // The same validator serves the static group, whose prefixes are not /api.
    expect(normalizeContentCachePaths(['/plugins/', '/assets'])).toEqual(['/plugins', '/assets'])
    expect(() => normalizeContentCachePaths(['relative/path'])).toThrow(/absolute/u)
    expect(() => normalizeContentCachePaths(['/'])).toThrow(/absolute/u)
    expect(() => normalizeContentCachePaths(['/api/../etc'])).toThrow(/plain paths/u)
    expect(() => normalizeContentCachePaths(['/api/sessions?q=1'])).toThrow(/plain paths/u)
  })
})

describe('content cache storage', () => {
  it('is inert unless a TTL is configured', () => {
    const disabled = cache({ ttlMs: 0 })
    expect(disabled.enabled).toBe(false)
    expect(disabled.matches(PATH)).toBe(false)
    disabled.store('k', {}, body('a'), undefined, 0)
    expect(disabled.lookup('k', 0)).toBeUndefined()
    expect(disabled.describe()).toMatchObject({ enabled: false, entries: 0, stores: 0 })
  })

  it('replays a stored body with its headers and age', () => {
    const instance = cache({ ttlMs: 5_000 })
    instance.store('k', { 'content-type': 'application/json' }, body('{"a":1}'), undefined, 1_000)
    const replay = instance.lookup('k', 4_500)
    expect(replay?.body.toString()).toBe('{"a":1}')
    expect(replay?.headers['content-type']).toBe('application/json')
    expect(replay?.ageSeconds).toBe(3)
    expect(instance.describe()).toMatchObject({ hits: 1, stores: 1, entries: 1 })
  })

  it('stops replaying past the window and only offers a revalidatable entry', () => {
    const instance = cache({ ttlMs: 100 })
    instance.store('k', {}, body('stale'), undefined, 1_000)
    instance.store('tagged', {}, body('tagged'), '"v1"', 1_000)
    expect(instance.lookup('k', 1_200)).toBeUndefined()
    expect(instance.stale('k', 1_200)).toBeUndefined()
    expect(instance.stale('tagged', 1_200)?.etag).toBe('"v1"')
    // A fresh entry is not "stale" either.
    expect(instance.stale('tagged', 1_050)).toBeUndefined()
  })

  it('refreshes a revalidated entry without re-downloading it', () => {
    const instance = cache({ ttlMs: 100 })
    instance.store('k', {}, body('v1'), '"v1"', 1_000)
    const replay = instance.refresh('k', 1_100)
    expect(replay?.body.toString()).toBe('v1')
    expect(instance.lookup('k', 1_150)?.body.toString()).toBe('v1')
    expect(instance.describe()).toMatchObject({ revalidations: 1 })
  })

  it('clears every device on a write', () => {
    const instance = cache()
    instance.store('phone-a', {}, body('a'), undefined, 1_000)
    instance.store('phone-b', {}, body('b'), undefined, 1_000)
    instance.clear()
    expect(instance.describe()).toMatchObject({ entries: 0, bytes: 0 })
    expect(instance.lookup('phone-a', 1_000)).toBeUndefined()
  })

  it('refuses a body whose fetch started before a write cleared the cache', () => {
    const instance = cache()
    const generation = instance.generation
    expect(instance.current(generation)).toBe(true)
    instance.clear()
    expect(instance.current(generation)).toBe(false)
    expect(instance.current(instance.generation)).toBe(true)
  })

  it('refuses an entry above the per-entry limit and evicts least-recently-used bodies', () => {
    const instance = cache({ maxEntryBytes: 4, maxBytes: 4 })
    instance.store('big', {}, body('12345'), undefined, 0)
    expect(instance.describe().entries).toBe(0)

    instance.store('a', {}, body('aa'), undefined, 0)
    instance.store('b', {}, body('bb'), undefined, 0)
    // Touch `a`, so the insertion order no longer decides: `b` is the oldest.
    expect(instance.lookup('a', 1)?.body.toString()).toBe('aa')
    instance.store('c', {}, body('cc'), undefined, 2)
    expect(instance.lookup('b', 3)).toBeUndefined()
    expect(instance.lookup('a', 3)?.body.toString()).toBe('aa')
    expect(instance.describe().evictions).toBeGreaterThanOrEqual(1)
  })

  it('caps the number of retained bodies, so empty reads cannot pile up', () => {
    // The byte budget is generous: only the count cap can stop these entries.
    const instance = cache({ maxEntries: 2, maxBytes: 64 * 1024 })
    instance.store('empty-1', {}, body('[]'), undefined, 0)
    instance.store('empty-2', {}, body('[]'), undefined, 0)
    instance.store('empty-3', {}, body('[]'), undefined, 0)
    expect(instance.describe()).toMatchObject({ entries: 2, bytes: 4, maxEntries: 2 })
    expect(instance.lookup('empty-1', 1)).toBeUndefined()
    expect(instance.lookup('empty-2', 1)?.body.toString()).toBe('[]')
    expect(instance.lookup('empty-3', 1)?.body.toString()).toBe('[]')
    expect(instance.describe().evictions).toBeGreaterThanOrEqual(1)
  })

  it('keeps the newest bodies when the count cap is lower than the byte budget allows', () => {
    const instance = cache({ maxEntries: 1 })
    instance.store('a', {}, body('a'), undefined, 0)
    instance.store('b', {}, body('b'), undefined, 0)
    expect(instance.describe().entries).toBe(1)
    expect(instance.lookup('a', 1)).toBeUndefined()
    expect(instance.lookup('b', 1)?.body.toString()).toBe('b')
    // A refresh of a live entry never grows the count.
    instance.refresh('b', 2)
    expect(instance.describe().entries).toBe(1)
  })

  it('is disabled when the count cap is zero', () => {
    const instance = cache({ maxEntries: 0 })
    expect(instance.enabled).toBe(false)
    expect(instance.matches('/api/sessions')).toBe(false)
    instance.store('a', {}, body('a'), undefined, 0)
    expect(instance.describe().entries).toBe(0)
  })
})
