/**
 * Bounded, opt-in short cache for complete API GET bodies.
 *
 * It exists for one measured case: on a slow link, reopening the same view
 * re-transferred `GET /api/sessions` and spent 15 s before the list appeared.
 * Freshness stays the priority:
 *
 *  - off unless an operator sets `contentCacheTtlMs`; with it off nothing in this
 *    file is consulted and responses are byte-for-byte what they were before;
 *  - only paths on an explicit allowlist are eligible, never every `/api/` route;
 *  - any non-GET/HEAD request through the gateway clears the whole cache, so a
 *    write is visible to the next read even inside the TTL window;
 *  - an entry past its TTL is never replayed as live. When the upstream sent an
 *    entity tag it is revalidated with `If-None-Match` and a `304` refreshes the
 *    stored copy; otherwise the entry is dropped.
 *
 * Responses keep the gateway's `no-store` browser policy: this is a gateway-side
 * replay, not a change to what any browser may cache.
 */

/** One stored representation; headers are the identity-encoded response headers. */
export interface ContentCacheEntry {
  readonly body: Buffer
  readonly headers: Readonly<Record<string, string | string[]>>
  readonly etag: string | undefined
  readonly storedAt: number
  readonly expiresAt: number
}

/** Counters for tests and operator diagnostics. */
export interface ContentCacheStats {
  readonly enabled: boolean
  readonly entries: number
  readonly bytes: number
  readonly hits: number
  readonly revalidations: number
  readonly stores: number
  readonly evictions: number
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
 * (`/api/session` does not match `/api/sessions`).
 * @param paths - Normalized allowlist entries, each beginning with `/api/`.
 * @param url - The raw request target; its query string is ignored.
 */
export function matchesContentCachePath(paths: readonly string[], url: string | undefined): boolean {
  if (paths.length === 0) return false
  const pathname = url?.split('?', 1)[0] ?? ''
  if (pathname.startsWith('/api/') !== true) return false
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
    if (candidate.startsWith('/api/') !== true || candidate.length <= '/api/'.length) {
      throw new Error(`contentCachePaths entries must begin with /api/: ${JSON.stringify(raw)}`)
    }
    if (/[?#\s]/u.test(candidate) || candidate.includes('..')) {
      throw new Error(`contentCachePaths entries must be plain paths: ${JSON.stringify(raw)}`)
    }
    if (!normalized.includes(candidate)) normalized.push(candidate)
  }
  return Object.freeze(normalized)
}

export class ContentCache {
  /** Insertion order doubles as recency order: the first key is the eviction candidate. */
  private readonly entries = new Map<string, ContentCacheEntry>()
  /**
   * Bumped by `clear()`. A fetch captures it before asking the upstream, so a body
   * that was already being downloaded when a write landed is not stored afterwards —
   * otherwise a pre-write representation could survive the write that invalidated it.
   */
  private cachedGeneration = 0
  private bytes = 0
  private hits = 0
  private revalidations = 0
  private stores = 0
  private evictions = 0

  /**
   * @param ttlMs - Freshness window; `0` disables the cache entirely.
   * @param maxBytes - Total retained body bytes across every device.
   * @param paths - Normalized allowlist from `normalizeContentCachePaths`.
   * @param maxEntryBytes - Largest single body worth retaining.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly maxBytes: number,
    private readonly paths: readonly string[],
    private readonly maxEntryBytes: number,
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0 && this.paths.length > 0 && this.maxBytes > 0
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
    this.hits += 1
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
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    const refreshed: ContentCacheEntry = { ...entry, storedAt: now, expiresAt: now + this.ttlMs }
    this.entries.delete(key)
    this.entries.set(key, refreshed)
    this.revalidations += 1
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
    this.stores += 1
    this.sweep(now)
  }

  /** Drop every device's entries: a write must never leave a stale read behind. */
  clear(): void {
    this.cachedGeneration += 1
    if (this.entries.size === 0) return
    this.entries.clear()
    this.bytes = 0
  }

  /** Read before a fetch; pass it back to `store` so a racing write wins. */
  get generation(): number {
    return this.cachedGeneration
  }

  /** Whether a fetch started at `generation` may still store its body. */
  current(generation: number): boolean {
    return this.cachedGeneration === generation
  }

  describe(): ContentCacheStats {
    return {
      enabled: this.enabled,
      entries: this.entries.size,
      bytes: this.bytes,
      hits: this.hits,
      revalidations: this.revalidations,
      stores: this.stores,
      evictions: this.evictions,
    }
  }

  private drop(key: string): void {
    const existing = this.entries.get(key)
    if (existing === undefined) return
    this.entries.delete(key)
    this.bytes = Math.max(0, this.bytes - existing.body.byteLength)
  }

  /** Evict expired entries first, then least-recently-used, until the byte cap holds. */
  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) continue
      this.entries.delete(key)
      this.bytes = Math.max(0, this.bytes - entry.body.byteLength)
    }
    while (this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.drop(oldest)
      this.evictions += 1
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
