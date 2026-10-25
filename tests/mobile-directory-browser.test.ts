import { describe, expect, it, vi } from 'vitest'
import { isMobileDirectoryPath, MobileDirectoryBrowser, MobileDirectoryReadError,
  parseMobileDirectoryListing, type MobileDirectoryListing } from '../src/mobile-directory-browser.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function listing(path = '/home/qa'): MobileDirectoryListing {
  return { path, ...(path === '/' ? {} : { parent: '/' }), entries: [{ name: 'projects', path: `${path === '/' ? '' : path}/projects` }], truncated: false }
}

async function flush() { for (let turn = 0; turn < 8; turn++) await Promise.resolve() }

async function withBrowser(run: (state: ReturnType<typeof fixture>) => Promise<void>) {
  const value = fixture()
  try { await run(value) } finally {
    for (const request of value.requests) request.result.resolve(listing(request.path ?? undefined))
    await value.browser.dispose()
  }
}

function fixture() {
  const requests: { path: string | null; signal: AbortSignal; result: ReturnType<typeof deferred<unknown>> }[] = []
  const read = vi.fn((path: string | null, signal: AbortSignal) => {
    const result = deferred<unknown>(); requests.push({ path, signal, result }); return result.promise
  })
  const browser = new MobileDirectoryBrowser(read)
  return { browser, read, requests }
}

describe('mobile directory paths and wire listings', () => {
  it.each(['/home/qa/projects', '/', 'C:\\projects', 'D:/work/repo', '\\\\server\\share\\repo', '/folder with spaces '])('accepts absolute host spelling %s', path => {
    expect(isMobileDirectoryPath(path)).toBe(true)
  })

  it.each(['', 'projects', '../projects', '~', 'C:projects', '\\server', '/bad\0path', '/' + 'x'.repeat(8192)])('rejects an invalid editable path %s', path => {
    expect(isMobileDirectoryPath(path)).toBe(false)
  })

  it('validates and freezes a bounded listing without changing the Host spelling', () => {
    const value = { path: 'D:\\workspace ', parent: 'D:\\', entries: [{ name: '<folder>', path: 'D:\\workspace \\<folder>' }], truncated: true }
    const parsed = parseMobileDirectoryListing(value)
    expect(parsed).toEqual(value)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.entries)).toBe(true)
    expect(Object.isFrozen(parsed.entries[0])).toBe(true)
    expect(parseMobileDirectoryListing({ path: '/', entries: [], truncated: false })).not.toHaveProperty('parent')
  })

  it.each([
    null, {}, { ...listing(), path: 'relative' }, { ...listing(), parent: 'relative' },
    { ...listing(), entries: null }, { ...listing(), entries: [{ name: '', path: '/a' }] },
    { ...listing(), entries: [{ name: 'a', path: 'relative' }] },
    { ...listing(), entries: [{ name: 'a', path: '/a' }, { name: 'again', path: '/a' }] },
    { ...listing(), entries: Array.from({ length: 501 }, (_, index) => ({ name: String(index), path: `/${index}` })) },
    { ...listing(), truncated: 'false' },
  ])('rejects malformed directory response %#', value => {
    expect(() => parseMobileDirectoryListing(value)).toThrowError(expect.objectContaining({ code: 'invalid-response' }))
  })
})

describe('mobile directory browser request ownership', () => {
  it('starts with one home read and exposes cancellation while it is pending', async () => {
    await withBrowser(async ({ browser, requests, read }) => {
      expect(browser.start()).toBe(true)
      expect(browser.start()).toBe(false)
      expect(read).toHaveBeenCalledTimes(1)
      expect(requests[0]!.path).toBeNull()
      expect(browser.getSnapshot().phase).toBe('loading')
      expect(browser.cancel()).toBe(true)
      expect(requests[0]!.signal.aborted).toBe(true)
      expect(browser.getSnapshot().open).toBe(false)
      requests[0]!.result.resolve(listing('/old-home'))
      await flush()
      expect(browser.getSnapshot().listing).toBeNull()
    })
  })

  it('allows cancellation after a failure and from any directory depth', async () => {
    await withBrowser(async ({ browser, requests }) => {
      browser.start(); requests[0]!.result.reject(new MobileDirectoryReadError('unavailable')); await flush()
      expect(browser.getSnapshot()).toMatchObject({ phase: 'error', error: 'unavailable' })
      expect(browser.cancel()).toBe(true)
      browser.start(); requests[1]!.result.resolve(listing('/a/b/c/d')); await flush()
      expect(browser.getSnapshot().listing?.parent).toBe('/')
      expect(browser.cancel()).toBe(true)
    })
  })

  it('only the latest navigation may publish success', async () => {
    await withBrowser(async ({ browser, requests }) => {
      browser.start(); browser.navigate('/older'); browser.navigate('/newer')
      expect(requests.slice(0, 2).every(request => request.signal.aborted)).toBe(true)
      requests[2]!.result.resolve(listing('/newer')); await flush()
      requests[1]!.result.resolve(listing('/older')); requests[0]!.result.resolve(listing('/home')); await flush()
      expect(browser.getSnapshot()).toMatchObject({ phase: 'idle', draft: '/newer', listing: { path: '/newer' }, error: null })
    })
  })

  it('an older rejection cannot replace the new directory with an error', async () => {
    await withBrowser(async ({ browser, requests }) => {
      browser.start(); browser.navigate('/newer')
      requests[1]!.result.resolve(listing('/newer')); await flush()
      requests[0]!.result.reject(new Error('old connection failed')); await flush()
      expect(browser.getSnapshot()).toMatchObject({ draft: '/newer', error: null, phase: 'idle' })
    })
  })

  it('closing and reopening withdraws old results even when the reader ignores abort', async () => {
    await withBrowser(async ({ browser, requests }) => {
      browser.start(); browser.cancel(); browser.start()
      requests[1]!.result.resolve(listing('/new-home')); await flush()
      requests[0]!.result.resolve(listing('/old-home')); await flush()
      expect(browser.getSnapshot()).toMatchObject({ open: true, draft: '/new-home' })
    })
  })

  it('editing while a scan is pending aborts it and never adopts its old listing', async () => {
    await withBrowser(async ({ browser, requests }) => {
      browser.start(); requests[0]!.result.resolve(listing('/listed')); await flush()
      expect(browser.canConfirm()).toBe(true)
      browser.navigate('/pending'); browser.setDraft('/typed')
      expect(requests[1]!.signal.aborted).toBe(true)
      expect(browser.getSnapshot().phase).toBe('idle')
      expect(browser.canConfirm()).toBe(false)
      expect(browser.confirm()).toBeUndefined()
      requests[1]!.result.resolve(listing('/pending')); await flush()
      expect(browser.getSnapshot()).toMatchObject({ draft: '/typed', listing: { path: '/listed' } })
    })
  })

  it('invalid paths remain visibly rejected without starting filesystem work', async () => {
    await withBrowser(async ({ browser, requests, read }) => {
      browser.start(); requests[0]!.result.resolve(listing()); await flush()
      browser.setDraft('relative')
      expect(browser.getSnapshot().error).toBe('bad-path')
      expect(browser.navigate('relative')).toBe(false)
      expect(browser.getSnapshot()).toMatchObject({ phase: 'error', error: 'bad-path' })
      expect(read).toHaveBeenCalledTimes(1)
      expect(browser.confirm()).toBeUndefined()
    })
  })

  it('unknown read failures are visible and retry only the explicitly failed target', async () => {
    await withBrowser(async ({ browser, requests, read }) => {
      browser.start(); requests[0]!.result.resolve(listing('/home')); await flush()
      browser.navigate('/failed'); requests[1]!.result.reject(new Error('unexpected transport failure')); await flush()
      expect(browser.getSnapshot()).toMatchObject({ phase: 'error', error: 'request-failed', listing: { path: '/home' } })
      expect(browser.confirm()).toBeUndefined()
      expect(browser.retry()).toBe(true)
      expect(read).toHaveBeenLastCalledWith('/failed', expect.any(AbortSignal))
      requests[2]!.result.resolve(listing('/failed')); await flush()
      expect(browser.getSnapshot()).toMatchObject({ phase: 'idle', draft: '/failed', error: null })
    })
  })

  it('a malformed response remains an error instead of publishing an adoptable path', async () => {
    await withBrowser(async ({ browser, requests }) => {
      browser.start(); requests[0]!.result.resolve({ path: '/host', entries: 'not a list', truncated: false }); await flush()
      expect(browser.getSnapshot()).toMatchObject({ phase: 'error', error: 'invalid-response', listing: null })
      expect(browser.confirm()).toBeUndefined()
    })
  })

  it('claims one commit synchronously and does not call it cancellation while Host adoption runs', async () => {
    await withBrowser(async ({ browser, requests, read }) => {
      browser.start(); requests[0]!.result.resolve(listing('/picked')); await flush()
      browser.setHostBusy(true)
      expect(browser.confirm()).toBeUndefined()
      expect(browser.cancel()).toBe(false)
      browser.setHostBusy(false)
      expect(browser.confirm()).toBe('/picked')
      expect(browser.confirm()).toBeUndefined()
      expect(browser.cancel()).toBe(false)
      expect(browser.navigate('/other')).toBe(false)
      browser.setDraft('/other'); browser.setHostBusy(true); browser.setHostBusy(false)
      expect(browser.getSnapshot()).toMatchObject({ committed: true, draft: '/picked', hostBusy: false })
      expect(browser.confirm()).toBeUndefined()
      expect(browser.cancel()).toBe(false)
      expect(read).toHaveBeenCalledTimes(1)
    })
  })

  it('disposal aborts admitted reads and waits for their physical settlement without late notifications', async () => {
    const { browser, requests } = fixture()
    const changed = vi.fn(); browser.subscribe(changed)
    browser.start(); browser.navigate('/second')
    const count = changed.mock.calls.length
    let settled = false
    const disposed = browser.dispose().then(() => { settled = true })
    expect(requests.every(request => request.signal.aborted)).toBe(true)
    await flush(); expect(settled).toBe(false)
    requests[0]!.result.resolve(listing('/old')); await flush(); expect(settled).toBe(false)
    requests[1]!.result.reject(new Error('late aborted error')); await disposed
    expect(changed).toHaveBeenCalledTimes(count)
    expect(browser.start()).toBe(false)
    await browser.dispose()
  })

  it('a read deadline aborts transport and becomes an explicit retryable error', async () => {
    vi.useFakeTimers()
    const browser = new MobileDirectoryBrowser(async (_path, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    }), 50)
    try {
      browser.start(); await vi.advanceTimersByTimeAsync(50)
      expect(browser.getSnapshot()).toMatchObject({ phase: 'error', error: 'timeout' })
      expect(browser.cancel()).toBe(true)
    } finally { await browser.dispose(); vi.useRealTimers() }
  })
})
