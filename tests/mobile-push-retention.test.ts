import { afterEach, describe, expect, it, vi } from 'vitest'
import { RequestLifetimes } from '../src/mobile-push/requests.js'
import { OutcomeLifetimes } from '../src/mobile-push/outcomes.js'
import { pruneOrphanedDeferrals } from '../src/mobile-push/retention.js'
import { ATTENTION_TTL_MS, OUTCOME_COALESCE_MS, OUTCOME_TTL_MS, REQUEST_SETTLE_MS } from '../src/mobile-push/contracts.js'
import type { ContextLike, PushSource } from '../src/mobile-push/contracts.js'

const opened: Array<() => void> = []
afterEach(() => {
  for (const close of opened.splice(0)) close()
  vi.useRealTimers()
})

const agent = (id: string) => ({ id, session: { id } })

function pushContext(overrides: Partial<ContextLike> = {}): ContextLike {
  const ctx: ContextLike = {
    on: () => () => undefined,
    userQuestions: { pending: () => [] },
    approval: {},
    agents: { get: () => undefined, list: () => [], roots: () => [], isOwnedBy: () => false },
    sessionProjections: { stateOf: () => undefined, snapshot: () => ({ asOfSeq: 0, values: {} }), register: () => () => undefined },
    sessionQuery: { observeSession: async () => ({ source: 'prepared', projections: { asOfSeq: 0, values: {} }, [Symbol.dispose]: () => undefined }) },
    ...overrides,
  }
  return ctx
}

const questionRequest = (sessionId: string, callId: string, timed = false) => ({
  questions: [{ id: 'q1', question: 'Continue?' }],
  agent: agent(sessionId),
  signal: new AbortController().signal,
  wait: { callId, timed },
})

describe('request lifetime retention', () => {
  it('sweep() removes no record before the original TTL and every expired record at expiry', async () => {
    vi.useFakeTimers()
    let now = 1_000_000
    const emitted: PushSource[] = []
    const lifetimes = new RequestLifetimes(pushContext(), source => emitted.push(source), () => now)
    opened.push(() => lifetimes.close())
    const settled = await lifetimes.observeQuestion(agent('s1'), questionRequest('s1', 'c1'), async () => 'done')
    expect(settled).toBe('done')
    await lifetimes.observeQuestion(agent('s2'), questionRequest('s2', 'c2'), async () => 'done')
    // A timed wait that is still pending keeps a live record without settling it.
    void lifetimes.observeQuestion(agent('s3'), questionRequest('s3', 'c3', true), async () => ({ pending: true }))
    now += ATTENTION_TTL_MS - 1
    expect(lifetimes.sweep()).toBe(0)
    now += 1
    expect(lifetimes.sweep()).toBe(3)
    expect(lifetimes.sweep()).toBe(0)
  })

  it('keeps exactly one record per duplicated call with the original expiry', async () => {
    vi.useFakeTimers()
    let now = 5_000_000
    const emitted: PushSource[] = []
    const lifetimes = new RequestLifetimes(pushContext(), source => emitted.push(source), () => now)
    opened.push(() => lifetimes.close())
    await lifetimes.observeQuestion(agent('s1'), questionRequest('s1', 'shared'), async () => 'first')
    now += 60_000
    await lifetimes.observeQuestion(agent('s1'), questionRequest('s1', 'shared'), async () => 'second')
    expect(emitted).toHaveLength(0)
    now += ATTENTION_TTL_MS - 60_000 - 1
    expect(lifetimes.sweep()).toBe(0)
    now += 1
    expect(lifetimes.sweep()).toBe(1)
  })

  it('preserves the newer by-call index when an expired same-call record is swept', async () => {
    vi.useFakeTimers()
    let now = 9_000_000
    const lifetimes = new RequestLifetimes(pushContext(), () => undefined, () => now)
    opened.push(() => lifetimes.close())
    await lifetimes.observeQuestion(agent('s1'), questionRequest('s1', 'shared'), async () => 'done')
    now += 200_000
    const approvalCreatedAt = now
    let releaseApproval!: (value: unknown) => void
    const held = new Promise<unknown>(resolve => { releaseApproval = resolve })
    void lifetimes.observeApproval(agent('s1'), { agent: agent('s1'), callId: 'shared', signal: new AbortController().signal }, () => held)
    now += ATTENTION_TTL_MS - 200_000
    expect(lifetimes.sweep()).toBe(1)
    const approvalSource: PushSource = {
      sourceId: 'request:s1:approval:shared', sessionId: 's1', targetSessionId: 's1', category: 'approval',
      createdAt: approvalCreatedAt, expiresAt: approvalCreatedAt + ATTENTION_TTL_MS, lifetime: 'live', callId: 'shared',
    }
    expect(lifetimes.reconcileLive(approvalSource)).toBe('eligible')
    lifetimes.queuedReply('s1', 'shared')
    expect(lifetimes.reconcileLive(approvalSource)).toBe('stale')
    releaseApproval('approved')
    await held
  })

  it('retires the replaced expired same-source record, disposing its abort listener', async () => {
    vi.useFakeTimers()
    let now = 20_000_000
    const lifetimes = new RequestLifetimes(pushContext(), () => undefined, () => now)
    opened.push(() => lifetimes.close())
    const firstSignal = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    await lifetimes.observeQuestion(agent('s1'), { ...questionRequest('s1', 'shared'), signal: firstSignal }, async () => 'first')
    expect(firstSignal.addEventListener).toHaveBeenCalledTimes(1)
    // Past the original TTL but before any sweep: a re-observation replaces the expired record.
    now += ATTENTION_TTL_MS + 1
    const secondSignal = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    await lifetimes.observeQuestion(agent('s1'), { ...questionRequest('s1', 'shared'), signal: secondSignal }, async () => 'second')
    // Asserted before close() — close() disposes everything and would mask the leak.
    expect(firstSignal.removeEventListener).toHaveBeenCalledTimes(1)
    expect(secondSignal.removeEventListener).toHaveBeenCalledTimes(0)
  })

  it('preserves the exact delegated result and error identity through observation', async () => {
    const lifetimes = new RequestLifetimes(pushContext(), () => undefined, () => 0)
    opened.push(() => lifetimes.close())
    const value = { answers: [] }
    await expect(lifetimes.observeQuestion(agent('s1'), questionRequest('s1', 'c1'), async () => value)).resolves.toBe(value)
    const failure = new Error('source failure')
    await expect(lifetimes.observeQuestion(agent('s2'), questionRequest('s2', 'c2'), async () => { throw failure })).rejects.toBe(failure)
  })

  it('close() clears owned timers and later sweeps remove nothing', async () => {
    vi.useFakeTimers()
    let now = 1
    const lifetimes = new RequestLifetimes(pushContext(), () => undefined, () => now)
    void lifetimes.observeQuestion(agent('s1'), questionRequest('s1', 'c1'), () => new Promise(() => {}))
    expect(vi.getTimerCount()).toBe(1)
    lifetimes.close()
    expect(vi.getTimerCount()).toBe(0)
    now += ATTENTION_TTL_MS + REQUEST_SETTLE_MS
    expect(lifetimes.sweep()).toBe(0)
  })
})

describe('outcome lifetime retention', () => {
  const endTurn = (lifetimes: OutcomeLifetimes, sessionId: string, turn: number, reason: string) =>
    lifetimes.onSessionEvent(agent(sessionId), { type: 'turn/end', data: { turn, reason: { kind: reason } } })

  it('sweep() removes no outcome before the outcome TTL and all expired tracking at expiry', async () => {
    vi.useFakeTimers()
    const emitted: PushSource[] = []
    const lifetimes = new OutcomeLifetimes(pushContext(), source => emitted.push(source))
    opened.push(() => lifetimes.close())
    endTurn(lifetimes, 's1', 1, 'completed')
    endTurn(lifetimes, 's2', 2, 'error')
    await vi.advanceTimersByTimeAsync(OUTCOME_COALESCE_MS)
    expect(emitted).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(OUTCOME_TTL_MS - 1 - OUTCOME_COALESCE_MS)
    expect(lifetimes.sweep()).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(lifetimes.sweep()).toBe(4)
    expect(lifetimes.sweep()).toBe(0)
  })

  it('re-notifies an identical outcome only after its sent record expires and is swept', async () => {
    vi.useFakeTimers()
    const emitted: PushSource[] = []
    const lifetimes = new OutcomeLifetimes(pushContext(), source => emitted.push(source))
    opened.push(() => lifetimes.close())
    endTurn(lifetimes, 's1', 7, 'completed')
    await vi.advanceTimersByTimeAsync(OUTCOME_COALESCE_MS)
    expect(emitted).toHaveLength(1)
    endTurn(lifetimes, 's1', 7, 'completed')
    await vi.advanceTimersByTimeAsync(OUTCOME_COALESCE_MS)
    expect(emitted).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(OUTCOME_TTL_MS)
    expect(lifetimes.sweep()).toBeGreaterThan(0)
    endTurn(lifetimes, 's1', 7, 'completed')
    await vi.advanceTimersByTimeAsync(OUTCOME_COALESCE_MS)
    expect(emitted).toHaveLength(2)
  })

  it('close() clears pending coalesce timers and nothing fires afterwards', async () => {
    vi.useFakeTimers()
    const emitted: PushSource[] = []
    const lifetimes = new OutcomeLifetimes(pushContext(), source => emitted.push(source))
    endTurn(lifetimes, 's1', 3, 'blocked')
    expect(vi.getTimerCount()).toBe(1)
    lifetimes.close()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(OUTCOME_TTL_MS + OUTCOME_COALESCE_MS + 5_000)
    expect(emitted).toHaveLength(0)
    expect(lifetimes.sweep()).toBe(0)
  })
})

describe('pruneOrphanedDeferrals', () => {
  it('removes only defer entries whose pending intent is gone', () => {
    const deferred = new Map([['gone', 1], ['live', 2]])
    expect(pruneOrphanedDeferrals(deferred, [{ id: 'live' }])).toBe(1)
    expect([...deferred.entries()]).toEqual([['live', 2]])
  })

  it('clears everything when nothing is pending and nothing when empty', () => {
    const deferred = new Map([['a', 1], ['b', 2]])
    expect(pruneOrphanedDeferrals(deferred, [])).toBe(2)
    expect(deferred.size).toBe(0)
    expect(pruneOrphanedDeferrals(deferred, [{ id: 'x' }])).toBe(0)
  })
})
