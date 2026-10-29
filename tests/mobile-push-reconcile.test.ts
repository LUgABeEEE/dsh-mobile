import { describe, expect, it } from 'vitest'
import type { ContextLike, PushSource } from '../src/mobile-push/contracts.js'
import {
  MOBILE_PUSH_LIFECYCLE_KEY,
  PushReconciler,
  mobilePushLifecycleProjectionDefinition,
} from '../src/mobile-push/reconcile.js'

function lifecycleState(latestTurn = 1) {
  let state = mobilePushLifecycleProjectionDefinition.init({}, 0)
  for (let turn = 1; turn <= latestTurn; turn++) {
    state = mobilePushLifecycleProjectionDefinition.apply(state, { type: 'turn/start', data: { turn } })
    state = mobilePushLifecycleProjectionDefinition.apply(state, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return state
}

describe('public push reconciliation', () => {
  it('treats a matching reply in the live inbox as stale even when its projection snapshot is empty', async () => {
    const callId = 'call-1'
    const sessionId = 'session-1'
    const queuedReply = {
      id: 'reply-1',
      role: 'user',
      source: { kind: 'user-question-reply', callId, outcome: 'answered' },
      content: [{ type: 'text', text: 'answer' }],
    }
    const agent = {
      id: sessionId,
      session: { id: sessionId },
      inbox: { nextTurn: [queuedReply], nextStep: [] },
    }
    const ctx: ContextLike = {
      on: () => undefined,
      agents: { get: id => id === sessionId ? agent : undefined },
      sessionProjections: {
        snapshot: () => ({ asOfSeq: 0, values: {
          userQuestions: { active: [{ callId, state: 'continued' }], settled: [] },
          inbox: { 'next-turn': [], 'next-step': [] },
          [MOBILE_PUSH_LIFECYCLE_KEY]: lifecycleState(),
        } }),
      },
    }
    const source: PushSource = {
      sourceId: `request:${sessionId}:question:${callId}`,
      sessionId,
      targetSessionId: sessionId,
      category: 'question',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      lifetime: 'live',
      turn: 1,
      callId,
    }

    await expect(new PushReconciler(ctx).reconcile(source, 'unverifiable')).resolves.toBe('stale')
  })

  it('keeps a current continued question eligible after later turns but rejects a future source turn', async () => {
    const callId = 'call-continued'
    const sessionId = 'session-cold'
    let disposals = 0
    const observation = {
      source: 'prepared' as const,
      projections: { asOfSeq: 8, values: {
        userQuestions: { active: [{ callId, state: 'continued' }], settled: [] },
        inbox: { 'next-turn': [], 'next-step': [] },
        [MOBILE_PUSH_LIFECYCLE_KEY]: lifecycleState(2),
      } },
      [Symbol.dispose]: () => { disposals++ },
    }
    const ctx: ContextLike = {
      on: () => undefined,
      agents: { get: () => undefined },
      sessionQuery: { observeSession: async () => observation },
    }
    const source: PushSource = {
      sourceId: `request:${sessionId}:question:${callId}`,
      sessionId,
      targetSessionId: sessionId,
      category: 'question',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      lifetime: 'live',
      turn: 1,
      callId,
    }
    const reconciler = new PushReconciler(ctx)

    await expect(reconciler.reconcile(source, 'unverifiable')).resolves.toBe('eligible')
    await expect(reconciler.reconcile({ ...source, turn: 3 }, 'unverifiable')).resolves.toBe('unverifiable')
    expect(disposals).toBe(2)
  })
})
