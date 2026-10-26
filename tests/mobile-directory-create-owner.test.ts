import { describe, expect, it, vi } from 'vitest'
import { MobileDirectoryBrowser, MobileDirectoryCreator, MobileDirectoryCreateError, isMobileDirectoryName } from '../src/mobile-directory-browser.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

async function flush() { for (let turn = 0; turn < 8; turn++) await Promise.resolve() }

function fixture(deadlineMs = 30_000) {
  const requests: { parent: string; name: string; signal: AbortSignal; result: ReturnType<typeof deferred<string>> }[] = []
  const created = vi.fn()
  const owner = new MobileDirectoryCreator((parent, name, signal) => {
    const result = deferred<string>()
    requests.push({ parent, name, signal, result })
    return result.promise
  }, created, deadlineMs)
  return { owner, requests, created }
}

async function withOwner(run: (value: ReturnType<typeof fixture>) => Promise<void>) {
  const value = fixture()
  try { await run(value) } finally {
    for (const request of value.requests) request.result.resolve(`${request.parent}/${request.name}`)
    await value.owner.dispose()
  }
}

describe('directory creation ownership', () => {
  it('rejects synchronous submission reentry from the pending-state observer', async () => {
    await withOwner(async ({ owner, requests }) => {
      owner.open('/confirmed'); owner.setName('child')
      const reentered: boolean[] = []
      owner.subscribe(() => { if (owner.getSnapshot().pending) reentered.push(owner.submit()) })
      expect(owner.submit()).toBe(true)
      expect(requests).toHaveLength(1)
      expect(reentered).toEqual([false])
    })
  })

  it.each(['close', 'dispose'] as const)('does not start filesystem work after a pending observer synchronously calls %s', async action => {
    const { owner, requests, created } = fixture()
    owner.open('/confirmed'); owner.setName('child')
    const cancel = owner.subscribe(() => {
      if (owner.getSnapshot().open && owner.getSnapshot().pending) {
        if (action === 'close') owner.close()
        else void owner.dispose()
      }
    })
    try {
      expect(owner.submit()).toBe(false)
      expect(requests).toHaveLength(0)
      expect(created).not.toHaveBeenCalled()
      expect(owner.getSnapshot()).toMatchObject({ open: false, pending: false })
    } finally { cancel(); await owner.dispose() }
  })

  it('admits one write with a captured parent and trims the entered name', async () => {
    await withOwner(async ({ owner, requests, created }) => {
      expect(owner.open('/confirmed')).toBe(true)
      owner.setName('  新项目  ')
      expect(owner.submit()).toBe(true)
      expect(owner.submit()).toBe(false)
      owner.setName('other')
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ parent: '/confirmed', name: '新项目' })
      expect(owner.open('/other')).toBe(false)
      requests[0]!.result.resolve('/confirmed/新项目')
      await flush()
      expect(created).toHaveBeenCalledExactlyOnceWith('/confirmed/新项目')
      expect(owner.getSnapshot()).toMatchObject({ open: false, pending: false })
    })
  })

  it('does not write before an explicit confirmed parent and name', async () => {
    await withOwner(async ({ owner, requests }) => {
      owner.setName('child')
      expect(owner.submit()).toBe(false)
      expect(owner.open('relative')).toBe(false)
      expect(owner.open('/confirmed')).toBe(true)
      expect(owner.submit()).toBe(false)
      expect(owner.getSnapshot().error).toBe('invalid-name')
      expect(requests).toHaveLength(0)
    })
  })

  it.each(['', '   ', '.', '..', 'one/two', 'one\\two', 'bad\0name', 'x'.repeat(256)])('rejects invalid names without filesystem work: %j', async name => {
    await withOwner(async ({ owner, requests }) => {
      owner.open('/confirmed'); owner.setName(name)
      expect(owner.submit()).toBe(false)
      expect(requests).toHaveLength(0)
    })
  })

  it('cancels a child editor without publishing a late result or releasing physical admission early', async () => {
    await withOwner(async ({ owner, requests, created }) => {
      owner.open('/old'); owner.setName('child'); owner.submit()
      expect(owner.close()).toBe(true)
      expect(requests[0]!.signal.aborted).toBe(true)
      expect(owner.getSnapshot()).toMatchObject({ open: false, pending: true })
      expect(owner.open('/new')).toBe(false)
      requests[0]!.result.resolve('/old/child')
      await flush()
      expect(created).not.toHaveBeenCalled()
      expect(owner.open('/new')).toBe(true)
      expect(owner.getSnapshot()).toMatchObject({ open: true, parent: '/new', name: '', pending: false })
    })
  })

  it('reports known failures and waits for a new explicit action rather than replaying writes', async () => {
    await withOwner(async ({ owner, requests, created }) => {
      owner.open('/confirmed'); owner.setName('child'); owner.submit()
      requests[0]!.result.reject(new MobileDirectoryCreateError('directory-exists'))
      await flush()
      expect(owner.getSnapshot()).toMatchObject({ open: true, pending: false, error: 'directory-exists' })
      expect(requests).toHaveLength(1)
      expect(created).not.toHaveBeenCalled()
      owner.setName('another'); expect(owner.submit()).toBe(true)
      expect(requests).toHaveLength(2)
    })
  })

  it('rejects a relative returned path rather than navigating to it', async () => {
    await withOwner(async ({ owner, requests, created }) => {
      owner.open('/confirmed'); owner.setName('child'); owner.submit()
      requests[0]!.result.resolve('relative')
      await flush()
      expect(owner.getSnapshot().error).toBe('invalid-response')
      expect(created).not.toHaveBeenCalled()
    })
  })

  it('keeps unknown transport failures explicit and never automatically retries', async () => {
    await withOwner(async ({ owner, requests, created }) => {
      owner.open('/confirmed'); owner.setName('child'); owner.submit()
      requests[0]!.result.reject(new Error('connection reset'))
      await flush()
      expect(owner.getSnapshot().error).toBe('request-failed')
      expect(requests).toHaveLength(1)
      expect(created).not.toHaveBeenCalled()
    })
  })

  it('a deadline cancels the result but retains pending physical work until it actually settles', async () => {
    vi.useFakeTimers()
    const { owner, requests, created } = fixture(50)
    try {
      owner.open('/confirmed'); owner.setName('child'); owner.submit()
      await vi.advanceTimersByTimeAsync(50)
      expect(requests[0]!.signal.aborted).toBe(true)
      expect(owner.getSnapshot()).toMatchObject({ error: 'timeout', pending: true })
      expect(owner.submit()).toBe(false)
      requests[0]!.result.resolve('/confirmed/child'); await flush()
      expect(owner.getSnapshot()).toMatchObject({ error: 'timeout', pending: false })
      expect(created).not.toHaveBeenCalled()
      expect(requests).toHaveLength(1)
    } finally {
      requests[0]?.result.resolve('/confirmed/child')
      await owner.dispose(); vi.useRealTimers()
    }
  })

  it('disposal aborts and drains creation before returning, without late callbacks', async () => {
    const { owner, requests, created } = fixture()
    owner.open('/confirmed'); owner.setName('child'); owner.submit()
    const changed = vi.fn(); owner.subscribe(changed)
    let disposed = false
    const stopping = owner.dispose().then(() => { disposed = true })
    try {
      expect(requests[0]!.signal.aborted).toBe(true)
      await flush(); expect(disposed).toBe(false)
      requests[0]!.result.resolve('/confirmed/child')
      await stopping
      expect(created).not.toHaveBeenCalled()
      expect(changed).not.toHaveBeenCalled()
      expect(owner.open('/other')).toBe(false)
      expect(owner.submit()).toBe(false)
    } finally { requests[0]!.result.resolve('/confirmed/child'); await stopping }
  })

  it('keeps directory navigation blocked during creation but allows the whole flow to cancel', async () => {
    const browser = new MobileDirectoryBrowser(async () => ({ path: '/confirmed', entries: [], truncated: false }))
    try {
      browser.start(); await flush()
      expect(browser.canConfirm()).toBe(true)
      browser.setCreating(true)
      expect(browser.canConfirm()).toBe(false)
      expect(browser.navigate('/other')).toBe(false)
      browser.setDraft('/other')
      expect(browser.getSnapshot().draft).toBe('/confirmed')
      expect(browser.cancel()).toBe(true)
      expect(browser.getSnapshot().open).toBe(false)
    } finally { await browser.dispose() }
  })

  it('accepts ordinary Unicode folder names', () => {
    expect(isMobileDirectoryName('项目 2026')).toBe(true)
  })
})
