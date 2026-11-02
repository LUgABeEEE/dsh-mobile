import { describe, expect, it } from 'vitest'
import {
  ContentCache,
  isCacheableAssetResponse,
  matchesContentCachePath,
  normalizeContentCachePaths,
} from '../src/content-cache.js'

/** The default static prefix: plugin bundles are served below it. */
const PLUGIN_PATH = '/plugins'
/** Both prefixes the gateway caches by default; one group, several prefixes. */
const ASSET_PATHS = ['/plugins', '/assets'] as const

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
    options.paths ?? [PLUGIN_PATH],
    options.maxEntryBytes ?? 8 * 1024,
  )
}

function body(text: string): Buffer {
  return Buffer.from(text)
}

describe('static-asset path allowlist', () => {
  it('matches a configured prefix and its subpaths, never a longer sibling', () => {
    expect(matchesContentCachePath([PLUGIN_PATH], '/plugins')).toBe(true)
    expect(matchesContentCachePath([PLUGIN_PATH], '/plugins/feature.js?rev=1')).toBe(true)
    expect(matchesContentCachePath([PLUGIN_PATH], '/plugins/ui/renderer.js')).toBe(true)
    // A sibling route is a different resource, not a subpath.
    expect(matchesContentCachePath([PLUGIN_PATH], '/plugins-archive/feature.js')).toBe(false)
    expect(matchesContentCachePath([PLUGIN_PATH], '/assets/feature.js')).toBe(false)
    expect(matchesContentCachePath([], '/plugins/feature.js')).toBe(false)
  })

  it('serves every configured prefix and nothing outside them', () => {
    const paths = normalizeContentCachePaths(ASSET_PATHS)
    expect(matchesContentCachePath(paths, '/plugins/feature.js')).toBe(true)
    expect(matchesContentCachePath(paths, '/assets/app.css')).toBe(true)
    // Gateway-owned /mobile-access routes are answered by the gateway itself and never
    // reach the proxy that consults this cache, so the prefix has no hit path.
    expect(matchesContentCachePath(paths, '/mobile-access/compat-abc.js')).toBe(false)
    expect(matchesContentCachePath(paths, '/api/sessions')).toBe(false)
    expect(matchesContentCachePath(paths, '/sidebar/html/preview.html')).toBe(false)
  })

  it('normalizes configured prefixes and rejects unusable ones', () => {
    expect(normalizeContentCachePaths([' /plugins/ ', '/plugins'])).toEqual([PLUGIN_PATH])
    expect(normalizeContentCachePaths(['/assets'])).toEqual(['/assets'])
    expect(normalizeContentCachePaths(['/plugins/', '/assets'])).toEqual(['/plugins', '/assets'])
    expect(() => normalizeContentCachePaths(['relative/path'])).toThrow(/absolute/u)
    expect(() => normalizeContentCachePaths(['/'])).toThrow(/absolute/u)
    expect(() => normalizeContentCachePaths(['/plugins/../etc'])).toThrow(/plain paths/u)
    expect(() => normalizeContentCachePaths(['/plugins/feature.js?rev=1'])).toThrow(/plain paths/u)
  })
})

describe('static-asset cache storage', () => {
  it('is inert unless a window is configured', () => {
    const disabled = cache({ ttlMs: 0 })
    expect(disabled.enabled).toBe(false)
    expect(disabled.matches(`${PLUGIN_PATH}/feature.js`)).toBe(false)
    disabled.store('k', {}, body('a'), undefined, 0)
    expect(disabled.lookup('k', 0)).toBeUndefined()
    // Nothing was retained, so even a lenient lookup cannot find it.
    expect(disabled.lookup('k', 500)).toBeUndefined()
  })

  it('replays a stored body with its headers and age', () => {
    const instance = cache({ ttlMs: 5_000 })
    instance.store('k', { 'content-type': 'application/javascript' }, body('export const a = 1'), undefined, 1_000)
    const replay = instance.lookup('k', 4_500)
    expect(replay?.body.toString()).toBe('export const a = 1')
    expect(replay?.headers['content-type']).toBe('application/javascript')
    expect(replay?.ageSeconds).toBe(3)
    // A second read replays the same stored representation.
    expect(instance.lookup('k', 4_600)?.body.toString()).toBe('export const a = 1')
  })

  it('stops replaying past the window and only offers a revalidatable entry', () => {
    const instance = cache({ ttlMs: 100 })
    instance.store('k', {}, body('stale'), undefined, 1_000)
    instance.store('tagged', {}, body('tagged'), '"v1"', 1_000)
    expect(instance.lookup('k', 1_200)).toBeUndefined()
    // Nothing to ask the upstream about, so the entry is simply dropped.
    expect(instance.stale('k', 1_200)).toBeUndefined()
    expect(instance.stale('tagged', 1_200)?.etag).toBe('"v1"')
    // A fresh entry is not "stale" either.
    expect(instance.stale('tagged', 1_050)).toBeUndefined()
  })

  it('refreshes a revalidated entry after a 304 instead of re-downloading it', () => {
    const instance = cache({ ttlMs: 100 })
    instance.store('k', {}, body('v1'), '"v1"', 1_000)
    const replay = instance.refresh('k', 1_100)
    expect(replay?.body.toString()).toBe('v1')
    // The window restarted: the body is live again at the same tick and 90ms later.
    expect(instance.lookup('k', 1_100)?.body.toString()).toBe('v1')
    expect(instance.lookup('k', 1_190)?.body.toString()).toBe('v1')
    expect(instance.stale('k', 1_190)).toBeUndefined()
    // The refreshed copy is the one the next 304 would replay.
    expect(instance.stale('k', 1_201)?.etag).toBe('"v1"')
  })

  it('refuses an entry above the per-entry or total byte budget', () => {
    const instance = cache({ maxEntryBytes: 4, maxBytes: 6 })
    instance.store('big', {}, body('12345'), undefined, 0)
    expect(instance.lookup('big', 0)).toBeUndefined()
    expect(instance.stale('big', 0)).toBeUndefined()
    // A body that fits one entry but not the whole budget is refused as well.
    const small = cache({ maxEntryBytes: 1024, maxBytes: 6 })
    small.store('wide', {}, body('1234567'), undefined, 0)
    expect(small.lookup('wide', 0)).toBeUndefined()
    // A body inside both budgets in the same instance is retained, so the refusals
    // above are about the size and not about a cache that never stores anything.
    small.store('fits', {}, body('123'), undefined, 0)
    expect(small.lookup('fits', 0)?.body.toString()).toBe('123')
  })

  it('retains an empty body without charging the byte budget', () => {
    const instance = cache({ maxBytes: 4 })
    instance.store('empty', {}, body(''), undefined, 0)
    expect(instance.lookup('empty', 1)?.body.byteLength).toBe(0)
    // It costs no bytes, so a later body that fits the budget is retained alongside it.
    instance.store('tiny', {}, body('12'), undefined, 0)
    expect(instance.lookup('empty', 1)?.body.byteLength).toBe(0)
    expect(instance.lookup('tiny', 1)?.body.toString()).toBe('12')
  })

  it('evicts the least-recently-used body once the byte budget is full', () => {
    const instance = cache({ maxEntryBytes: 4, maxBytes: 4 })
    instance.store('a', {}, body('aa'), undefined, 0)
    instance.store('b', {}, body('bb'), undefined, 0)
    // Touch `a`, so the insertion order no longer decides: `b` is the oldest.
    expect(instance.lookup('a', 1)?.body.toString()).toBe('aa')
    instance.store('c', {}, body('cc'), undefined, 2)
    expect(instance.lookup('b', 3)).toBeUndefined()
    expect(instance.lookup('a', 3)?.body.toString()).toBe('aa')
  })

  it('caps the number of retained bodies, so empty bodies cannot pile up', () => {
    // The byte budget is generous: only the count cap can stop these entries.
    const instance = cache({ maxEntries: 2, maxBytes: 64 * 1024 })
    instance.store('empty-1', {}, body(''), undefined, 0)
    instance.store('empty-2', {}, body(''), undefined, 0)
    instance.store('empty-3', {}, body(''), undefined, 0)
    // Only the two newest survive: the oldest key was evicted, not merely hidden.
    expect(instance.lookup('empty-1', 1)).toBeUndefined()
    expect(instance.lookup('empty-2', 1)?.body.byteLength).toBe(0)
    expect(instance.lookup('empty-3', 1)?.body.byteLength).toBe(0)
    instance.store('empty-4', {}, body(''), undefined, 1)
    expect(instance.lookup('empty-2', 2)).toBeUndefined()
    expect(instance.lookup('empty-4', 2)?.body.byteLength).toBe(0)
  })

  it('keeps the newest bodies when the count cap is lower than the byte budget allows', () => {
    const instance = cache({ maxEntries: 1 })
    instance.store('a', {}, body('a'), undefined, 0)
    instance.store('b', {}, body('b'), undefined, 0)
    expect(instance.lookup('a', 1)).toBeUndefined()
    expect(instance.lookup('b', 1)?.body.toString()).toBe('b')
    // A refresh of a live entry keeps the same single slot: the next body still evicts
    // the older key rather than being refused.
    instance.refresh('b', 2)
    instance.store('c', {}, body('c'), undefined, 2)
    expect(instance.lookup('b', 3)).toBeUndefined()
    expect(instance.lookup('c', 3)?.body.toString()).toBe('c')
  })

  it('is disabled by a zero count or byte budget', () => {
    const noEntries = cache({ maxEntries: 0 })
    expect(noEntries.enabled).toBe(false)
    expect(noEntries.matches(`${PLUGIN_PATH}/feature.js`)).toBe(false)
    noEntries.store('a', {}, body('a'), undefined, 0)
    expect(noEntries.lookup('a', 0)).toBeUndefined()

    const noBytes = cache({ maxBytes: 0 })
    expect(noBytes.enabled).toBe(false)
    expect(noBytes.matches(`${PLUGIN_PATH}/feature.js`)).toBe(false)
  })

  it('is disabled while the path allowlist is empty', () => {
    const instance = cache({ paths: [] })
    expect(instance.enabled).toBe(false)
    instance.store('a', {}, body('a'), undefined, 0)
    expect(instance.lookup('a', 0)).toBeUndefined()
  })
})

describe('static-asset response eligibility', () => {
  const script = { 'content-type': 'application/javascript; charset=utf-8' }

  it('accepts complete identity-encoded scripts, styles, JSON and SVG', () => {
    expect(isCacheableAssetResponse(200, script)).toBe(true)
    expect(isCacheableAssetResponse(200, { 'content-type': 'text/css' })).toBe(true)
    expect(isCacheableAssetResponse(200, { 'content-type': 'application/json; charset=utf-8' })).toBe(true)
    expect(isCacheableAssetResponse(200, { 'content-type': 'application/manifest+json' })).toBe(true)
    expect(isCacheableAssetResponse(200, { 'content-type': 'image/svg+xml' })).toBe(true)
    // A public upstream policy is compatible with a gateway-side replay.
    expect(isCacheableAssetResponse(200, { ...script, 'cache-control': 'public, max-age=60' })).toBe(true)
  })

  it('refuses a response that set a cookie', () => {
    expect(isCacheableAssetResponse(200, { ...script, 'set-cookie': ['sid=1; Path=/'] })).toBe(false)
  })

  it('refuses a non-200, an encoded body and a private or no-store policy', () => {
    expect(isCacheableAssetResponse(304, script)).toBe(false)
    expect(isCacheableAssetResponse(206, script)).toBe(false)
    expect(isCacheableAssetResponse(200, { ...script, 'content-encoding': 'gzip' })).toBe(false)
    expect(isCacheableAssetResponse(200, { ...script, 'cache-control': 'no-store' })).toBe(false)
    expect(isCacheableAssetResponse(200, { ...script, 'cache-control': 'private, max-age=60' })).toBe(false)
  })

  it('refuses an event stream, a binary body and a media type it cannot replay', () => {
    expect(isCacheableAssetResponse(200, { 'content-type': 'text/event-stream; charset=utf-8' })).toBe(false)
    expect(isCacheableAssetResponse(200, { 'content-type': 'application/octet-stream' })).toBe(false)
    expect(isCacheableAssetResponse(200, { 'content-type': 'application/wasm' })).toBe(false)
    expect(isCacheableAssetResponse(200, {})).toBe(false)
  })
})
