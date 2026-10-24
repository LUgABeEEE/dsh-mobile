import { z } from 'zod'
import type { ContextLike, PublicAgentLike, PublicProjectionDefinition, PublicSessionObservation, PushSource } from './contracts.js'

export type PushReconcileResult = 'eligible' | 'stale' | 'unverifiable'

const TURN_REASONS = ['completed', 'error', 'blocked', 'aborted', 'max-tokens', 'interrupted', 'forked', 'other'] as const
const GOAL_OPERATIONS = ['create', 'edit', 'pause', 'resume', 'complete', 'block', 'clear'] as const
const GOAL_PHASES = ['active', 'paused', 'blocked', 'complete', 'cleared'] as const

const turnEndSchema = z.object({
  turn: z.number().int().nonnegative(),
  reason: z.enum(TURN_REASONS),
}).strict()
const goalChangeSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  phase: z.enum(GOAL_PHASES),
  operation: z.enum(GOAL_OPERATIONS),
  turn: z.number().int().nonnegative(),
  openTurn: z.boolean(),
}).strict()
export const mobilePushLifecycleSchema = z.object({
  latestTurn: z.number().int().nonnegative(),
  openTurn: z.number().int().nonnegative().nullable(),
  lastTurnEnd: turnEndSchema.nullable(),
  latestGoalChange: goalChangeSchema.nullable(),
}).strict()

export interface MobilePushLifecycleState {
  readonly latestTurn: number
  readonly openTurn: number | null
  readonly lastTurnEnd: { readonly turn: number; readonly reason: typeof TURN_REASONS[number] } | null
  readonly latestGoalChange: {
    readonly id: string
    readonly revision: number
    readonly phase: typeof GOAL_PHASES[number]
    readonly operation: typeof GOAL_OPERATIONS[number]
    readonly turn: number
    readonly openTurn: boolean
  } | null
}

export const MOBILE_PUSH_LIFECYCLE_KEY = 'mobilePushLifecycle' as const

const INITIAL_STATE: MobilePushLifecycleState = {
  latestTurn: 0,
  openTurn: null,
  lastTurnEnd: null,
  latestGoalChange: null,
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const safeNumber = (value: unknown): number | undefined => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined

/** Wire-visible verification metadata only; it stores no message text or diagnostics. */
export const mobilePushLifecycleProjectionDefinition = {
  key: MOBILE_PUSH_LIFECYCLE_KEY,
  stateSchema: mobilePushLifecycleSchema,
  init: (_header: unknown, _inheritedEventCount: unknown): MobilePushLifecycleState => INITIAL_STATE,
  apply(state: MobilePushLifecycleState, event: unknown): MobilePushLifecycleState {
    if (!isRecord(event)) return state
    const data = isRecord(event.data) ? event.data : undefined
    if (!data) return state
    if (event.type === 'turn/start') {
      const turn = safeNumber(data.turn)
      if (turn === undefined) return state
      return { ...state, latestTurn: turn, openTurn: turn, lastTurnEnd: null }
    }
    if (event.type === 'turn/end') {
      const turn = safeNumber(data.turn)
      const reasonData = isRecord(data.reason) ? data.reason : undefined
      const rawReason = reasonData?.kind
      if (turn === undefined || typeof rawReason !== 'string') return state
      const reason = (TURN_REASONS as readonly string[]).includes(rawReason) ? rawReason as typeof TURN_REASONS[number] : 'other'
      return { ...state, latestTurn: turn, openTurn: null, lastTurnEnd: { turn, reason } }
    }
    if (event.type !== 'goal/change') return state
    const rawOperation = data.operation
    if (typeof rawOperation !== 'string' || !(GOAL_OPERATIONS as readonly string[]).includes(rawOperation)) return state
    const operation = rawOperation as typeof GOAL_OPERATIONS[number]
    const goal = isRecord(data.goal) ? data.goal : undefined
    const cleared = isRecord(data.cleared) ? data.cleared : undefined
    const goalId = goal?.id
    const clearedId = cleared?.id
    const id = typeof goalId === 'string' ? goalId : typeof clearedId === 'string' ? clearedId : undefined
    const revision = safeNumber(goal?.revision ?? cleared?.revision)
    const phaseValue = operation === 'clear' ? 'cleared' : goal?.phase
    if (!id || revision === undefined || typeof phaseValue !== 'string' || !(GOAL_PHASES as readonly string[]).includes(phaseValue)) return state
    const phase = phaseValue as typeof GOAL_PHASES[number]
    return {
      ...state,
      latestGoalChange: {
        id,
        revision,
        phase,
        operation,
        turn: state.latestTurn,
        openTurn: state.openTurn !== null,
      },
    }
  },
  wire: {
    viewSchema: mobilePushLifecycleSchema,
    view: (state: MobilePushLifecycleState): MobilePushLifecycleState => state,
  },
  stateVersion: 1,
} satisfies PublicProjectionDefinition<MobilePushLifecycleState, MobilePushLifecycleState>

function projectionValues(ctx: ContextLike, agent: PublicAgentLike): Record<string, unknown> | undefined {
  try {
    return ctx.sessionProjections?.snapshot?.(agent.session ?? agent)?.values
  } catch {
    return undefined
  }
}

function queueArrays(values: Record<string, unknown>, agent?: PublicAgentLike): readonly unknown[][] | undefined {
  const queues: unknown[][] = []
  const inbox = isRecord(values.inbox) ? values.inbox : undefined
  const projected = [inbox?.['next-turn'], inbox?.['next-step']]
  if (projected.every(Array.isArray)) queues.push(...projected as unknown[][])
  const live = [agent?.inbox?.nextTurn, agent?.inbox?.nextStep]
  if (live.every(Array.isArray)) queues.push(...live as unknown[][])
  return queues.length > 0 ? queues : undefined
}

function inboxContains(values: Record<string, unknown>, predicate: (message: unknown) => boolean, agent?: PublicAgentLike): boolean | undefined {
  const queues = queueArrays(values, agent)
  if (!queues) return undefined
  return queues.some(queue => queue.some(predicate))
}

function lifecycle(values: Record<string, unknown>): MobilePushLifecycleState | undefined {
  const parsed = mobilePushLifecycleSchema.safeParse(values[MOBILE_PUSH_LIFECYCLE_KEY])
  return parsed.success ? parsed.data : undefined
}

function verifyQuestion(source: PushSource, values: Record<string, unknown>, agent?: PublicAgentLike): PushReconcileResult {
  const callId = source.callId
  if (typeof callId !== 'string' || !callId) return 'unverifiable'
  const replyQueued = inboxContains(values, message => {
    const source = isRecord(message) && isRecord(message.source) ? message.source : undefined
    return source?.kind === 'user-question-reply' && source.callId === callId && source.outcome === 'answered'
  }, agent)
  if (replyQueued === undefined) return 'unverifiable'
  if (replyQueued) return 'stale'
  const view = isRecord(values.userQuestions) ? values.userQuestions : undefined
  const activeItems = Array.isArray(view?.active) ? view.active as unknown[] : undefined
  const settledItems = Array.isArray(view?.settled) ? view.settled as unknown[] : undefined
  if (!activeItems || !settledItems) return 'unverifiable'
  const active = activeItems.find((item): item is Record<string, unknown> => isRecord(item) && item.callId === callId)
  if (active) {
    if (active.state !== 'open' && active.state !== 'continued') return 'stale'
    const state = lifecycle(values)
    const turn = safeNumber(source.turn)
    if (turn === undefined || !state) return 'unverifiable'
    if (state.latestTurn > turn) return 'stale'
    if (state.latestTurn < turn) return 'unverifiable'
    return 'eligible'
  }
  return settledItems.some(item => isRecord(item) && item.callId === callId) ? 'stale' : 'unverifiable'
}

function verifyOutcome(source: PushSource, values: Record<string, unknown>, agent?: PublicAgentLike): PushReconcileResult {
  const turn = safeNumber(source.turn)
  if (turn === undefined) return 'unverifiable'
  const queuedInput = inboxContains(values, message => message !== undefined && message !== null, agent)
  if (queuedInput === undefined) return 'unverifiable'
  if (queuedInput) return 'stale'
  const state = lifecycle(values)
  if (!state) return 'unverifiable'
  if (state.latestTurn > turn) return 'stale'
  if (state.latestTurn < turn) return 'unverifiable'
  const ended = state.lastTurnEnd
  if (!ended || ended.turn !== turn) return 'unverifiable'
  const cause = state.latestGoalChange
  const goalEnvelope = isRecord(values.goal) ? values.goal : undefined
  const currentGoal = isRecord(goalEnvelope?.goal) ? goalEnvelope.goal : undefined
  if (source.category === 'response') {
    if (ended.reason !== 'completed') return 'stale'
    if (cause?.turn === turn && (cause.operation === 'complete' || cause.operation === 'block')) return 'stale'
    if (currentGoal?.phase === 'active' && cause?.turn === turn) return 'stale'
    return 'eligible'
  }
  if (source.category === 'failure') {
    if (ended.reason !== 'error' && ended.reason !== 'blocked') return 'stale'
    if (cause?.turn === turn && cause.operation === 'block') return 'stale'
    return 'eligible'
  }
  return 'unverifiable'
}

function verifyGoal(source: PushSource, values: Record<string, unknown>): PushReconcileResult {
  const identity = source.goal
  if (!identity) return 'unverifiable'
  const goalEnvelope = isRecord(values.goal) ? values.goal : undefined
  const goalView = isRecord(goalEnvelope?.goal) ? goalEnvelope.goal : undefined
  if (!goalView) return values.goal === null ? 'stale' : 'unverifiable'
  if (goalView.id !== identity.id || goalView.revision !== identity.revision) return 'stale'
  const phase = goalView.phase
  if (phase !== 'complete' && phase !== 'blocked') return 'stale'
  const state = lifecycle(values)
  if (!state) return 'unverifiable'
  const cause = state.latestGoalChange
  if (!cause) return 'unverifiable'
  if (cause.id !== identity.id || cause.revision !== identity.revision || cause.phase !== phase) return 'stale'
  const sourceTurn = safeNumber(source.turn)
  if (sourceTurn === undefined) {
    if (cause.operation !== 'block') return 'unverifiable'
    if (state.latestTurn !== cause.turn || state.openTurn !== null) return 'stale'
    return 'eligible'
  }
  if (state.latestTurn > sourceTurn) return 'stale'
  if (state.latestTurn < sourceTurn || cause.turn > sourceTurn) return 'unverifiable'
  if (phase === 'blocked') {
    if (cause.operation !== 'block' || cause.turn !== sourceTurn) return 'stale'
    if (state.openTurn === sourceTurn) return 'eligible'
    const ended = state.lastTurnEnd
    return ended?.turn === sourceTurn && (ended.reason === 'completed' || ended.reason === 'blocked' || ended.reason === 'error') ? 'eligible' : 'unverifiable'
  }
  if (cause.operation !== 'complete') return 'stale'
  const ended = state.lastTurnEnd
  return ended?.turn === sourceTurn && ended.reason === 'completed' ? 'eligible' : 'unverifiable'
}

export class PushReconciler {
  readonly #ctx: ContextLike

  constructor(ctx: ContextLike) { this.#ctx = ctx }

  registerProjection(): () => void {
    const dispose = this.#ctx.sessionProjections?.register?.(mobilePushLifecycleProjectionDefinition)
    if (typeof dispose !== 'function') throw new Error('public session projection registration unavailable')
    return dispose
  }

  async reconcile(source: PushSource, liveProof: PushReconcileResult): Promise<PushReconcileResult> {
    if (source.expiresAt <= Date.now()) return 'stale'
    if (liveProof !== 'unverifiable') return liveProof
    if (source.category === 'plan' || source.category === 'approval') return 'unverifiable'
    if (source.category === 'question' && !source.callId) return 'unverifiable'
    const agent = this.#ctx.agents?.get?.(source.sessionId)
    if (agent) {
      const values = projectionValues(this.#ctx, agent)
      return values ? this.#verify(source, values, agent) : 'unverifiable'
    }
    let observation: PublicSessionObservation | undefined
    let result: PushReconcileResult = 'unverifiable'
    try {
      observation = await this.#ctx.sessionQuery?.observeSession?.(source.sessionId, { projectionMode: 'all' })
      const values = observation?.projections?.values
      if (values) result = this.#verify(source, values, undefined)
    } catch (error: unknown) {
      result = isRecord(error) && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND' ? 'stale' : 'unverifiable'
    } finally {
      try { observation?.[Symbol.dispose]() } catch { result = 'unverifiable' }
    }
    return source.expiresAt <= Date.now() ? 'stale' : result
  }

  #verify(source: PushSource, values: Record<string, unknown>, agent?: PublicAgentLike): PushReconcileResult {
    if (source.expiresAt <= Date.now()) return 'stale'
    if (source.category === 'question') return verifyQuestion(source, values, agent)
    if (source.category === 'goal') return verifyGoal(source, values)
    return verifyOutcome(source, values, agent)
  }
}
