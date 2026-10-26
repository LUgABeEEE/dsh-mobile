/** Cancellable, latest-request-owned navigation for the authenticated workspace picker. */
export interface MobileDirectoryEntry {
  readonly name: string
  readonly path: string
}

/** One bounded directory level supplied by the Mobile Gateway. */
export interface MobileDirectoryListing {
  readonly path: string
  readonly parent?: string
  readonly entries: readonly MobileDirectoryEntry[]
  readonly truncated: boolean
}

/** User-visible failures; raw server messages and filesystem paths are not reflected. */
export type MobileDirectoryFailure = 'bad-path' | 'unavailable' | 'unauthorized' | 'invalid-response' | 'request-failed' | 'timeout'

/** Expected Gateway or response-validation failure for one read-only listing. */
export class MobileDirectoryReadError extends Error {
  constructor(readonly code: MobileDirectoryFailure, options?: ErrorOptions) {
    super(`Mobile directory listing failed: ${code}`, options)
    this.name = 'MobileDirectoryReadError'
  }
}

/** Display state owned by one directory-flow occurrence, never shared between slots. */
export interface MobileDirectorySnapshot {
  readonly open: boolean
  readonly phase: 'idle' | 'loading' | 'error'
  readonly listing: MobileDirectoryListing | null
  readonly draft: string
  readonly error: MobileDirectoryFailure | null
  readonly hostBusy: boolean
  readonly committed: boolean
  readonly creating: boolean
}

/** Accept portable absolute spellings; the Host remains authoritative for its platform. */
export function isMobileDirectoryPath(path: string): boolean {
  return path.length > 0 && path.length <= 8192 && !path.includes('\0')
    && (path.startsWith('/') || /^[a-z]:[\\/]/iu.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(path))
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Validate a wire response before publishing names or adopting a Host path. */
export function parseMobileDirectoryListing(value: unknown): MobileDirectoryListing {
  const record = object(value)
  const fail = (): never => { throw new MobileDirectoryReadError('invalid-response') }
  if (record === undefined || typeof record.path !== 'string' || !isMobileDirectoryPath(record.path)
    || typeof record.truncated !== 'boolean' || !Array.isArray(record.entries) || record.entries.length > 500) return fail()
  const parent = record.parent
  if (parent !== undefined && (typeof parent !== 'string' || !isMobileDirectoryPath(parent))) return fail()
  const paths = new Set<string>()
  const entries: MobileDirectoryEntry[] = []
  for (const candidate of record.entries) {
    const entry = object(candidate)
    if (entry === undefined || typeof entry.name !== 'string' || entry.name.length === 0 || entry.name.includes('\0')
      || typeof entry.path !== 'string' || !isMobileDirectoryPath(entry.path) || paths.has(entry.path)) return fail()
    paths.add(entry.path)
    entries.push(Object.freeze({ name: entry.name, path: entry.path }))
  }
  return Object.freeze({ path: record.path, ...(parent === undefined ? {} : { parent }), entries: Object.freeze(entries), truncated: record.truncated })
}

const CLOSED: MobileDirectorySnapshot = Object.freeze({
  open: false, phase: 'idle', listing: null, draft: '', error: null, hostBusy: false, committed: false, creating: false,
})

/** Read navigation stops on close; committing is final until the owner withdraws this flow. */
export class MobileDirectoryBrowser {
  private snapshot = CLOSED
  private readonly listeners = new Set<() => void>()
  private readonly tasks = new Set<Promise<void>>()
  private readonly taskFailures: unknown[] = []
  private activeRead: AbortController | undefined
  private generation = 0
  private disposed = false
  private lastTarget: string | null = null

  constructor(
    private readonly read: (path: string | null, signal: AbortSignal) => Promise<unknown>,
    private readonly deadlineMs = 30_000,
  ) {}

  getSnapshot = (): MobileDirectorySnapshot => this.snapshot

  /** Subscribe to this occurrence; the returned disposer removes the observer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Start a new open edge at the Host home; returns false after permanent disposal. */
  start(): boolean {
    if (this.disposed || this.snapshot.open) return false
    this.publish({ ...CLOSED, open: true })
    return this.navigate(null)
  }

  /** Editing invalidates any pending scan and cannot commit the previously listed path. */
  setDraft(draft: string): void {
    if (!this.canNavigate() || draft === this.snapshot.draft) return
    this.withdrawRead()
    this.publish({ ...this.snapshot, draft, phase: 'idle', error: isMobileDirectoryPath(draft) ? null : 'bad-path' })
  }

  /** Project the owner's adoption state without undoing this flow's synchronous commit claim. */
  setHostBusy(hostBusy: boolean): void {
    if (this.disposed || this.snapshot.hostBusy === hostBusy) return
    this.publish({ ...this.snapshot, hostBusy })
  }

  /** Block navigation/adoption while this flow's child-folder editor owns interaction. */
  setCreating(creating: boolean): void {
    if (this.disposed || this.snapshot.creating === creating) return
    this.publish({ ...this.snapshot, creating })
  }

  /** Read a folder or the initial home; superseded results cannot publish into the new request. */
  navigate(path: string | null): boolean {
    if (!this.canNavigate()) return false
    this.withdrawRead()
    if (path !== null && !isMobileDirectoryPath(path)) {
      this.publish({ ...this.snapshot, draft: path, phase: 'error', error: 'bad-path' })
      return false
    }
    this.lastTarget = path
    const controller = new AbortController()
    this.activeRead = controller
    const generation = this.generation
    this.publish({ ...this.snapshot, phase: 'loading', error: null, ...(path === null ? {} : { draft: path }) })
    const task = (async (): Promise<void> => {
      const timeout = setTimeout(() => { controller.abort(new MobileDirectoryReadError('timeout')) }, this.deadlineMs)
      try {
        const value = await this.read(path, controller.signal)
        controller.signal.throwIfAborted()
        const listing = parseMobileDirectoryListing(value)
        if (!this.current(generation)) return
        this.publish({ ...this.snapshot, phase: 'idle', listing, draft: listing.path, error: null })
      } catch (error) {
        if (!this.current(generation)) return
        const reason: unknown = controller.signal.aborted ? controller.signal.reason : error
        // Unknown transport/JSON failures remain visible and require an explicit retry.
        this.publish({ ...this.snapshot, phase: 'error', error: reason instanceof MobileDirectoryReadError ? reason.code : 'request-failed' })
      } finally {
        clearTimeout(timeout)
        if (this.activeRead === controller) this.activeRead = undefined
      }
    })()
    this.tasks.add(task)
    void task.then(() => { this.tasks.delete(task) }, error => { this.tasks.delete(task); this.taskFailures.push(error) })
    return true
  }

  /** Retry only the explicitly failed read, without adopting or replaying a write. */
  retry(): boolean { return this.navigate(this.lastTarget) }

  /** Whether the confirmed listing still matches the editable path and can be adopted. */
  canConfirm(): boolean {
    const value = this.snapshot
    return this.canNavigate() && value.phase === 'idle' && value.error === null && value.listing !== null && value.draft === value.listing.path
  }

  /** Claim one adoption synchronously; returns no path for stale input, busy state or duplicate taps. */
  confirm(): string | undefined {
    if (!this.canConfirm()) return undefined
    const path = this.snapshot.listing!.path
    this.publish({ ...this.snapshot, committed: true })
    return path
  }

  /** Cancel reading immediately; a committed/Host-busy adoption cannot be reported as cancelled. */
  cancel(): boolean {
    if (!this.canClose()) return false
    this.withdrawRead()
    this.publish(CLOSED)
    return true
  }

  /** Withdraw callbacks immediately and await every admitted read before disposal completes. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.withdrawRead()
    this.snapshot = CLOSED
    this.listeners.clear()
    await Promise.allSettled([...this.tasks])
    if (this.taskFailures.length > 0) throw new AggregateError(this.taskFailures, 'Mobile directory observers failed during a listing')
  }

  private canClose(): boolean { return !this.disposed && this.snapshot.open && !this.snapshot.hostBusy && !this.snapshot.committed }
  private canNavigate(): boolean { return this.canClose() && !this.snapshot.creating }
  private current(generation: number): boolean { return !this.disposed && this.snapshot.open && generation === this.generation }
  private withdrawRead(): void { this.generation++; this.activeRead?.abort(); this.activeRead = undefined }
  private publish(snapshot: MobileDirectorySnapshot): void {
    this.snapshot = Object.freeze(snapshot)
    for (const listener of this.listeners) listener()
  }
}

/** Fixed categories for a single explicit folder-creation request. */
export type MobileDirectoryCreateFailure = 'invalid-name' | 'directory-exists' | 'directory-create-failed' | 'unauthorized' | 'invalid-response' | 'request-failed' | 'timeout'

/** A creation failure without raw response bodies or filesystem details. */
export class MobileDirectoryCreateError extends Error {
  constructor(readonly code: MobileDirectoryCreateFailure) {
    super(`Mobile directory creation failed: ${code}`)
    this.name = 'MobileDirectoryCreateError'
  }
}

/** Portable single-segment validation; the Host additionally enforces its filesystem rules. */
export function isMobileDirectoryName(name: string): boolean {
  return name.trim() !== '' && name.length <= 255 && name !== '.' && name !== '..' && !/[\\/\0]/u.test(name)
}

/** One child-folder editor; pending includes cancelled work whose transport has not settled. */
export interface MobileDirectoryCreateSnapshot {
  readonly open: boolean
  readonly parent: string | null
  readonly name: string
  readonly pending: boolean
  readonly error: MobileDirectoryCreateFailure | null
}

const CREATE_CLOSED: MobileDirectoryCreateSnapshot = Object.freeze({ open: false, parent: null, name: '', pending: false, error: null })

/** Owns one non-replayed write, its deadline, cancellation and physical teardown. */
export class MobileDirectoryCreator {
  private snapshot = CREATE_CLOSED
  private readonly listeners = new Set<() => void>()
  private readonly tasks = new Set<Promise<void>>()
  private readonly failures: unknown[] = []
  private active: AbortController | undefined
  private generation = 0
  private disposed = false

  constructor(
    private readonly create: (parent: string, name: string, signal: AbortSignal) => Promise<string>,
    private readonly onCreated: (path: string) => void,
    private readonly deadlineMs = 30_000,
  ) {}

  getSnapshot = (): MobileDirectoryCreateSnapshot => this.snapshot

  /** Subscribe to this editor; the returned disposer withdraws the observer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Open against one already confirmed parent; cancelled physical work retains admission. */
  open(parent: string): boolean {
    if (this.disposed || this.snapshot.open || this.tasks.size > 0 || !isMobileDirectoryPath(parent)) return false
    this.publish({ ...CREATE_CLOSED, open: true, parent })
    return true
  }

  /** Edit only while no write is in flight; typing never starts a filesystem operation. */
  setName(name: string): void {
    if (this.disposed || !this.snapshot.open || this.snapshot.pending) return
    this.publish({ ...this.snapshot, name, error: null })
  }

  /** Admit one explicit creation. Repeated clicks/Enter cannot replay an admitted request. */
  submit(): boolean {
    if (this.disposed || !this.snapshot.open || this.snapshot.pending || this.tasks.size > 0 || this.snapshot.parent === null) return false
    const name = this.snapshot.name.trim()
    if (!isMobileDirectoryName(name)) {
      this.publish({ ...this.snapshot, error: 'invalid-name' })
      return false
    }
    const parent = this.snapshot.parent
    const generation = this.generation
    const controller = new AbortController()
    this.active = controller
    this.publish({ ...this.snapshot, pending: true, error: null })
    if (!this.current(generation) || controller.signal.aborted) {
      if (this.active === controller) this.active = undefined
      if (!this.disposed) this.publish({ ...this.snapshot, pending: false })
      return false
    }
    const timer = setTimeout(() => {
      controller.abort(new MobileDirectoryCreateError('timeout'))
      if (this.current(generation)) this.publish({ ...this.snapshot, error: 'timeout' })
    }, this.deadlineMs)
    const task = (async (): Promise<void> => {
      let created: string | undefined
      try {
        created = await this.create(parent, name, controller.signal)
        controller.signal.throwIfAborted()
        if (!isMobileDirectoryPath(created)) throw new MobileDirectoryCreateError('invalid-response')
      } catch (error) {
        created = undefined
        if (this.current(generation)) {
          const failure: unknown = controller.signal.aborted ? controller.signal.reason : error
          this.publish({ ...this.snapshot, error: failure instanceof MobileDirectoryCreateError ? failure.code : 'request-failed' })
        }
      } finally {
        clearTimeout(timer)
        if (this.active === controller) this.active = undefined
        if (!this.disposed) this.publish({ ...this.snapshot, pending: false })
      }
      if (created !== undefined && this.current(generation)) {
        this.publish(CREATE_CLOSED)
        this.onCreated(created)
      }
    })()
    this.tasks.add(task)
    void task.then(() => { this.tasks.delete(task) }, error => { this.tasks.delete(task); this.failures.push(error) })
    return true
  }

  /** Withdraw the editor and late results; an already completed mkdir is not rolled back. */
  close(): boolean {
    if (this.disposed || !this.snapshot.open) return false
    this.generation++
    this.active?.abort()
    this.publish({ ...CREATE_CLOSED, pending: this.active !== undefined })
    return true
  }

  /** Stop admission synchronously and await every accepted write before completion. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.generation++
    this.active?.abort()
    this.snapshot = CREATE_CLOSED
    this.listeners.clear()
    await Promise.allSettled([...this.tasks])
    if (this.failures.length > 0) throw new AggregateError(this.failures, 'Mobile directory creation observers failed')
  }

  private current(generation: number): boolean { return !this.disposed && this.snapshot.open && generation === this.generation }
  private publish(snapshot: MobileDirectoryCreateSnapshot): void {
    this.snapshot = Object.freeze(snapshot)
    for (const listener of this.listeners) listener()
  }
}
