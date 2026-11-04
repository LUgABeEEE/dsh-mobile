/**
 * Bounded, opt-in cache for complete static resources the gateway serves itself.
 *
 * It exists for one repeated cost: on a slow link a phone reopening the app
 * re-downloads the same plugin bundles the gateway has already served. Assets
 * change only when their bytes change, so they can be cached on their own terms:
 *
 *  - off unless an operator sets `contentCacheAssetTtlMs`; with it off nothing in
 *    this file is consulted and responses are byte-for-byte what they were before;
 *  - only paths on an explicit allowlist are eligible (`contentCacheAssetPaths`),
 *    never every GET the gateway proxies;
 *  - an entry past its TTL is never replayed as live. When the upstream sent an
 *    entity tag it is revalidated with `If-None-Match` and a `304` refreshes the
 *    stored copy; otherwise the entry is dropped;
 *  - assets are files, not Session state: nothing here is derived from a write,
 *    so no write can invalidate the group.
 *
 * Responses keep the gateway's `no-store` browser policy: this is a gateway-side
 * replay, not a change to what any browser may cache.
 */

import type { IncomingHttpHeaders } from 'node:http'

/** One stored representation; headers are the identity-encoded response headers. */
export interface ContentCacheEntry {
  readonly body: Buffer
  readonly headers: Readonly<Record<string, string | string[]>>
  readonly etag: string | undefined
  readonly storedAt: number
  readonly expiresAt: number
}

/** The stored value a caller may replay, with the age a client should be told. */
export interface ContentCacheReplay {
  readonly body: Buffer
  readonly headers: Record<string, string | string[]>
  readonly ageSeconds: number
  readonly storedAt: number
}

/**
 * Whether `url` falls under one of the allowlisted path prefixes.
 * A prefix matches itself and its subpaths, and never matches a longer sibling
 * (`/plugins` does not match `/plugins-archive`).
 * @param paths - Normalized allowlist entries, each an absolute path.
 * @param url - The raw request target; its query string is ignored.
 */
export function matchesContentCachePath(paths: readonly string[], url: string | undefined): boolean {
  if (paths.length === 0) return false
  const pathname = url?.split('?', 1)[0] ?? ''
  if (pathname.startsWith('/') !== true) return false
  for (const prefix of paths) {
    if (pathname === prefix) return true
    if (pathname.startsWith(`${prefix}/`)) return true
  }
  return false
}

/** Validate and normalize the configured allowlist; throws on unusable entries. */
export function normalizeContentCachePaths(paths: readonly string[]): readonly string[] {
  const normalized: string[] = []
  for (const raw of paths) {
    const candidate = raw.trim().replace(/\/+$/u, '')
    if (candidate.startsWith('/') !== true || candidate.length <= 1) {
      throw new Error(`cache path prefixes must be absolute: ${JSON.stringify(raw)}`)
    }
    if (/[?#\s]/u.test(candidate) || candidate.includes('..')) {
      throw new Error(`content cache path entries must be plain paths: ${JSON.stringify(raw)}`)
    }
    if (!normalized.includes(candidate)) normalized.push(candidate)
  }
  return Object.freeze(normalized)
}

/**
 * Whether a proxied upstream response may be retained for replay.
 *
 * Assets are scripts, styles and owned files, so only text-like media types are kept;
 * an event stream or a binary body is never a replay candidate.
 * @param statusCode - Upstream status; only a complete `200` is eligible.
 * @param headers - Upstream response headers.
 * @returns Whether a complete, identity-encoded body may be stored.
 */
export function isCacheableAssetResponse(statusCode: number, headers: IncomingHttpHeaders): boolean {
  if (statusCode !== 200) return false
  if (headers['set-cookie'] !== undefined) return false
  // The stored copy must be the identity representation: a replayed body is
  // re-compressed for whichever client asks for it next.
  if (headers['content-encoding'] !== undefined) return false
  const cacheControl = headers['cache-control']
  const upstreamCache = (Array.isArray(cacheControl) ? '' : cacheControl ?? '').toLowerCase()
  if (upstreamCache.includes('no-store') || upstreamCache.includes('private')) return false
  const contentType = headers['content-type']
  const raw = Array.isArray(contentType) ? contentType[0] : contentType
  const mediaType = raw?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (mediaType === 'text/event-stream' || mediaType === 'application/octet-stream') return false
  return mediaType.startsWith('text/') || mediaType === 'application/javascript'
    || mediaType === 'application/json' || mediaType.endsWith('+json') || mediaType === 'image/svg+xml'
}

export class ContentCache {
  /** Insertion order doubles as recency order: the first key is the eviction candidate. */
  private readonly entries = new Map<string, ContentCacheEntry>()
  private bytes = 0

  /**
   * @param ttlMs - Freshness window; `0` disables the cache entirely.
   * @param maxBytes - Total retained body bytes across every device.
   * @param maxEntries - Retained bodies across every device; empty or small bodies
   *   cost almost nothing per byte, so the byte budget alone lets them pile up.
   * @param paths - Normalized allowlist from `normalizeContentCachePaths`.
   * @param maxEntryBytes - Largest single body worth retaining.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly maxBytes: number,
    private readonly maxEntries: number,
    private readonly paths: readonly string[],
    private readonly maxEntryBytes: number,
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0 && this.paths.length > 0 && this.maxBytes > 0 && this.maxEntries > 0
  }

  /** Whether this request target is eligible for the cache at all. */
  matches(url: string | undefined): boolean {
    return this.enabled && matchesContentCachePath(this.paths, url)
  }

  /** Largest body this cache will retain; a bigger response streams through uncached. */
  get entryLimit(): number {
    return this.maxEntryBytes
  }

  /**
   * A live entry, refreshed to most-recently-used.
   * @returns The replay, or `undefined` when absent, expired or disabled.
   */
  lookup(key: string, now: number): ContentCacheReplay | undefined {
    if (!this.enabled) return undefined
    const entry = this.entries.get(key)
    if (entry === undefined || entry.expiresAt <= now) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return replayOf(entry, now)
  }

  /**
   * An entry that may be revalidated: expired, but only when it carries an entity
   * tag to ask the upstream about. Without one there is nothing to revalidate and
   * the caller performs an ordinary fetch.
   */
  stale(key: string, now: number): ContentCacheEntry | undefined {
    if (!this.enabled) return undefined
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt > now) return undefined
    return entry.etag === undefined ? undefined : entry
  }

  /** After a `304`, the stored copy is current: restart its window and replay it. */
  refresh(key: string, now: number): ContentCacheReplay | undefined {
    // A cache created disabled may still be asked to refresh a revalidated entry; it never
    // stored one, so this is a no-op rather than a lookup that could only ever miss.
    if (!this.enabled) return undefined
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    const refreshed: ContentCacheEntry = { ...entry, storedAt: now, expiresAt: now + this.ttlMs }
    this.entries.delete(key)
    this.entries.set(key, refreshed)
    return replayOf(refreshed, now)
  }

  /** Record one complete identity-encoded body; oversized bodies are refused. */
  store(key: string, headers: Readonly<Record<string, string | string[]>>, body: Buffer, etag: string | undefined, now: number): void {
    if (!this.enabled) return
    if (body.byteLength > this.maxEntryBytes || body.byteLength > this.maxBytes) return
    this.drop(key)
    const entry: ContentCacheEntry = {
      body,
      headers,
      etag,
      storedAt: now,
      expiresAt: now + this.ttlMs,
    }
    this.entries.set(key, entry)
    this.bytes += body.byteLength
    this.sweep(now)
  }

  private drop(key: string): void {
    const existing = this.entries.get(key)
    if (existing === undefined) return
    this.entries.delete(key)
    this.bytes = Math.max(0, this.bytes - existing.body.byteLength)
  }

  /** Evict expired entries, then least-recently-used entries until both caps hold. */
  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) continue
      this.entries.delete(key)
      this.bytes = Math.max(0, this.bytes - entry.body.byteLength)
    }
    // The count cap comes first: a flood of tiny bodies must not survive merely because
    // it is cheap in bytes, so those entries are removed before the byte cap runs.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.drop(oldest)
    }
    while (this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.drop(oldest)
    }
  }
}

function replayOf(entry: ContentCacheEntry, now: number): ContentCacheReplay {
  return {
    body: entry.body,
    headers: { ...entry.headers },
    ageSeconds: Math.max(0, Math.floor((now - entry.storedAt) / 1000)),
    storedAt: entry.storedAt,
  }
}
