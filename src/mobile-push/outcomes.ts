import { OUTCOME_COALESCE_MS, OUTCOME_TTL_MS } from './contracts.js'
import type { ContextLike, PublicAgentLike, PushSource } from './contracts.js'

type Candidate = { source: PushSource; timer?: ReturnType<typeof setTimeout> | undefined; active: boolean }
type Emit = (source: PushSource) => void
const isCompletedGoalPhase = (phase: string | undefined): boolean => phase === 'complete'

export class OutcomeLifetimes {
  readonly #ctx: ContextLike
  readonly #emit: Emit
  readonly #pending = new Map<string, Candidate>()
  readonly #goals = new Map<string, { id: string; revision: number; phase: string }>()
  readonly #sent = new Set<string>()
  #closed = false

  constructor(ctx: ContextLike, emit: Emit) { this.#ctx = ctx; this.#emit = emit }

  onGoal(payload: any): void {
    const agent: PublicAgentLike | undefined = payload?.agent
    const change = payload?.change
    const goal = change?.goal
    const op = change?.operation
    if (!agent?.id || !change) return
    this.#cancel(agent.id)
    if (op === 'clear' || !goal) {
      this.#goals.delete(agent.id)
      return
    }
    const id = String(goal.id ?? change?.ref?.id ?? '')
    const revision = Number(goal.revision ?? change?.ref?.revision)
    if (!id || !Number.isFinite(revision)) return
    const record = { id, revision, phase: String(goal.phase ?? op ?? '') }
    this.#goals.set(agent.id, record)
    // `goal/changed` follows its durable goal/change append. Active continuation
    // rounds suppress ordinary responses; completed goals wait for turn/end.
    if (record.phase === 'blocked' || op === 'block') this.#schedule(agent, 'goal', undefined, { id, revision })
  }

  onSessionEvent(session: PublicAgentLike, event: any): void {
    const type = event?.type
    const data = event?.data ?? event
    if (!session?.id || !data) return
    const id = session.id
    if (type === 'agent/inbox/inserted' || type === 'agent/inbox/spliced' || type === 'turn/start') {
      this.#cancel(id)
      if (type === 'turn/start') {
        const goal = this.#goals.get(id) ?? this.#projectedGoal(session)
        if (goal && isCompletedGoalPhase(goal.phase)) this.#goals.delete(id)
      }
      return
    }
    if (type !== 'turn/end') return
    const reason = data.reason?.kind
    if (reason === 'completed') {
      const goal = this.#goals.get(id) ?? this.#projectedGoal(session)
      if (goal && isCompletedGoalPhase(goal.phase)) {
        this.#schedule(session, 'goal', data.turn, { id: goal.id, revision: goal.revision })
        this.#goals.delete(id)
      } else if (goal?.phase !== 'active') this.#schedule(session, 'response', data.turn)
    } else if (reason === 'blocked') {
      if (this.#goals.get(id)?.phase !== 'blocked') this.#schedule(session, 'failure', data.turn)
    } else if (reason === 'error') {
      this.#schedule(session, 'failure', data.turn)
    }
    // aborted/user, max-tokens, interrupted, forked are intentionally silent.
  }

  #projectedGoal(session: PublicAgentLike): { id: string; revision: number; phase: string } | undefined {
    const state = this.#ctx.sessionProjections?.stateOf?.(session.session ?? session, 'goal') as any
    const goal = state?.current?.goal
    if (!goal || typeof goal.id !== 'string' || !Number.isSafeInteger(goal.revision) || typeof goal.phase !== 'string') return undefined
    return { id: goal.id, revision: goal.revision, phase: goal.phase }
  }

  onAgentError(_payload: unknown): void {
    // Agent errors are diagnostics. Only a live committed turn/end error is actionable.
  }

  eligible(source: PushSource): boolean {
    if (this.#closed || source.expiresAt <= Date.now()) return false
    const candidate = this.#pending.get(source.sourceId)
    return candidate?.active ?? false
  }

  close(): void {
    this.#closed = true
    for (const item of this.#pending.values()) if (item.timer) clearTimeout(item.timer)
    this.#pending.clear()
  }

  #schedule(agent: PublicAgentLike, category: PushSource['category'], turn?: number, goal?: { id: string; revision: number }): void {
    if (this.#closed || this.#isRuntimeChild(agent)) return
    const createdAt = Date.now()
    const goalKey = goal ? `${goal.id}:${goal.revision}` : ''
    const sourceId = `${category}:${agent.id}:${turn ?? 'goal'}:${goalKey}`
    if (this.#sent.has(sourceId) || this.#pending.has(sourceId)) return
    const source: PushSource = {
      sourceId, sessionId: agent.id, targetSessionId: this.#root(agent).id, category,
      createdAt, expiresAt: createdAt + OUTCOME_TTL_MS, lifetime: 'committed',
      ...(turn === undefined ? {} : { turn }), ...(goal === undefined ? {} : { goal }),
    }
    const candidate: Candidate = { source, active: true }
    candidate.timer = setTimeout(() => {
      candidate.timer = undefined
      if (this.#closed || !candidate.active) return
      this.#sent.add(sourceId)
      this.#emit(source)
      candidate.timer = setTimeout(() => { this.#pending.delete(sourceId) }, Math.max(0, source.expiresAt - Date.now()))
    }, OUTCOME_COALESCE_MS)
    this.#pending.set(sourceId, candidate)
  }

  #cancel(sessionId: string): void {
    for (const [id, candidate] of this.#pending) {
      if (candidate.source.sessionId !== sessionId) continue
      clearTimeout(candidate.timer)
      candidate.active = false
      this.#pending.delete(id)
    }
  }
  #isRuntimeChild(agent: PublicAgentLike): boolean {
    const registry = this.#ctx.agents
    if (!registry?.isOwnedBy || !registry.list) return false
    return registry.list().some(owner => registry.isOwnedBy?.(agent.id, owner))
  }
  #root(agent: PublicAgentLike): PublicAgentLike {
    const registry = this.#ctx.agents
    if (!registry?.isOwnedBy || !registry.list) return agent
    let current = agent
    for (let count = 0; count < 64; count++) {
      const owner = registry.list().find(candidate => registry.isOwnedBy?.(current.id, candidate))
      if (!owner) return current
      current = owner
    }
    return current
  }
}
