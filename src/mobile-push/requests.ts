import { ATTENTION_TTL_MS, REQUEST_SETTLE_MS } from './contracts.js'
import type { ContextLike, PublicAgentLike, PushCategory, PushSource } from './contracts.js'

type RequestRecord = { source: PushSource; settled: boolean; queuedReply: boolean; timed: boolean; timer?: ReturnType<typeof setTimeout> | undefined; live: boolean }
type Emit = (source: PushSource) => void

export class RequestLifetimes {
  readonly #records = new Map<string, RequestRecord>()
  readonly #byCall = new Map<string, RequestRecord>()
  readonly #clock: () => number
  readonly #emit: Emit
  readonly #ctx: ContextLike
  #closed = false

  constructor(ctx: ContextLike, emit: Emit, clock = Date.now) {
    this.#ctx = ctx
    this.#emit = emit
    this.#clock = clock
  }

  observeQuestion(agent: PublicAgentLike, request: any, next: () => Promise<unknown>): Promise<unknown> {
    const question = Array.isArray(request?.questions) ? request.questions[0] : undefined
    if (!question || !request?.signal?.aborted) {
      const intent = question?.intent
      const category: PushCategory = intent?.kind === 'plan-review' ? 'plan' : 'question'
      const callId = intent?.kind === 'plan-review' && typeof intent.callId === 'string'
        ? intent.callId
        : typeof request?.wait?.callId === 'string' ? request.wait.callId : undefined
      const sessionId = String(agent?.id ?? request?.agent?.id ?? '')
      const rec = sessionId ? this.#record(agent, sessionId, category, callId, request?.signal, ATTENTION_TTL_MS, request?.wait?.timed === true) : undefined
      if (rec) this.#arm(rec)
      // Cordis waterfall observers delegate once and preserve the exact result/error.
      return Promise.resolve().then(next).then(result => {
        if (rec && !(rec.timed && result && typeof result === 'object' && (result as any).pending === true)) {
          rec.settled = true
          rec.live = false
        }
        return result
      }, error => {
        if (rec && !(rec.timed && ['NO_PROVIDER', 'ASK_TIMED_OUT'].includes((error as any)?.code))) {
          rec.settled = true
          rec.live = false
        }
        throw error
      })
    }
    return Promise.resolve().then(next)
  }

  observeApproval(agent: PublicAgentLike, request: any, next: () => Promise<unknown>): Promise<unknown> {
    const sessionId = String(agent?.id ?? request?.agent?.id ?? '')
    const rec = !request?.signal?.aborted && sessionId
      ? this.#record(agent, sessionId, 'approval', request?.callId, request?.signal, ATTENTION_TTL_MS) : undefined
    if (rec) this.#arm(rec)
    return Promise.resolve().then(next).finally(() => { if (rec) { rec.settled = true; rec.live = false } })
  }

  queuedReply(sessionId: string, callId: string): void {
    const rec = this.#byCall.get(`${sessionId}\u0000${callId}`)
    if (rec) rec.queuedReply = true
  }

  eligible(source: PushSource): boolean {
    if (this.#closed) return false
    const rec = this.#records.get(source.sourceId)
    if (!rec || rec.settled || rec.queuedReply || source.expiresAt <= this.#clock()) return false
    const timed = this.#callForSource(source)
    if (!timed) return true // legacy blocking requests are absent from timed projections
    const state = this.#projection(source.sessionId)
    const view = state?.questions ?? state
    const active = Array.isArray(view?.active) ? view.active : []
    if (active.some((item: any) => item.callId === timed && (item.state === 'open' || item.state === 'continued'))) return true
    if (rec.timed) return false
    const settled = Array.isArray(view?.settled) ? view.settled : []
    if (settled.some((item: any) => item.callId === timed)) return false
    // Legacy blocking waits are not reconstructed by the timed projection.
    return rec.live
  }

  close(): void {
    this.#closed = true
    for (const rec of this.#records.values()) if (rec.timer) clearTimeout(rec.timer)
    this.#records.clear()
    this.#byCall.clear()
  }

  #projection(sessionId: string): any {
    const session = this.#ctx.agents?.get?.(sessionId)?.session ?? { id: sessionId }
    return this.#ctx.sessionProjections?.stateOf?.(session, 'userQuestions')
  }
  #callForSource(source: PushSource): string | undefined { return source.callId }
  #record(agent: PublicAgentLike, sessionId: string, category: PushCategory, callId: unknown, signal: AbortSignal | undefined, ttl: number, timed = false): RequestRecord {
    const createdAt = this.#clock()
    const opaque = typeof callId === 'string' && callId ? callId : `dispatch-${crypto.randomUUID()}`
    const sourceId = `request:${sessionId}:${category}:${opaque}`
    const source: PushSource = {
      sourceId, sessionId, targetSessionId: this.#root(agent).id, category: category as Exclude<PushCategory, 'test'>,
      createdAt, expiresAt: createdAt + ttl, lifetime: 'live', ...(typeof callId === 'string' ? { callId } : {}),
    }
    const rec: RequestRecord = { source, settled: false, queuedReply: false, timed, live: true }
    this.#records.set(sourceId, rec)
    if (typeof callId === 'string') this.#byCall.set(`${sessionId}\u0000${callId}`, rec)
    signal?.addEventListener('abort', () => {
      if (rec.timed && (signal.reason as any)?.code === 'ASK_TIMED_OUT') return
      rec.settled = true
      rec.live = false
    }, { once: true })
    return rec
  }
  #root(agent: PublicAgentLike): PublicAgentLike {
    const registry = this.#ctx.agents
    if (!registry?.isOwnedBy || !registry.get || !registry.list) return agent
    let current = agent
    for (let count = 0; count < 64; count++) {
      const parent = registry.list().find(candidate => registry.isOwnedBy?.(current.id, candidate))
      if (!parent) break
      current = parent
    }
    return current
  }
  #arm(rec: RequestRecord): void {
    rec.timer = setTimeout(() => {
      rec.timer = undefined
      if (this.#closed || rec.settled || rec.queuedReply) return
      this.#emit(rec.source)
    }, REQUEST_SETTLE_MS)
  }
}
