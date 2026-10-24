import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { spawn } from 'node:child_process'

/** Run an owned fixture build command and retain bounded diagnostics. */
async function run(command, args, cwd, env = process.env) {
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-12_000) })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-12_000) })
  const result = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolveExit({ code, signal }))
  })
  if (result.code !== 0 || result.signal !== null) throw new Error(`Fixture command failed: ${command} ${args.join(' ')}\n${stdout}\n${stderr}`)
  return stdout
}

function hostEntrySource(repository) {
  const hostPath = pathToFileURL(join(repository, 'src/mobile-push/host.ts')).href
  return `
import { createPushHost } from ${JSON.stringify(hostPath)}
import { ATTENTION_TTL_MS, OUTCOME_COALESCE_MS } from ${JSON.stringify(pathToFileURL(join(repository, 'src/mobile-push/contracts.ts')).href)}
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'dsh-mobile-push-contract-fixture'
export const inject = ['agents', 'sessions', 'sessionProjections', 'userQuestions', 'approval', 'goals']
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (predicate, label, timeoutMs = 6000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await pause(20)
  }
  throw new Error('Timed out waiting for ' + label)
}
const sourceSummary = source => ({ sourceId: source.sourceId, sessionId: source.sessionId, targetSessionId: source.targetSessionId, category: source.category, createdAt: source.createdAt, expiresAt: source.expiresAt, lifetime: source.lifetime, ...(source.callId ? { callId: source.callId } : {}), ...(source.goal ? { goal: source.goal } : {}) })
const withinTimeout = async (operation, timeoutMs, label) => {
  let timer
  try {
    return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), timeoutMs) })])
  } finally { clearTimeout(timer) }
}

async function runFixtureJob(ctx, controls) {
  const result = { runtime: 'dsh-cordis-host', checks: [], sources: [], available: false, stage: 'job-started', applyEnteredAt: controls.applyEnteredAt, jobStartedAt: controls.jobStartedAt ?? Date.now(), stageHistory: [{ stage: 'job-started', at: controls.jobStartedAt ?? Date.now() }], approvalAnswererEntries: 0 }
  const home = process.env.DSH_HOME ?? process.cwd()
  const progressPath = join(home, 'push-contract-progress.json')
  const persistProgress = async () => writeFile(progressPath, JSON.stringify(result, null, 2) + '\\n', { mode: 0o600 })
  controls.result = result
  controls.persistProgress = persistProgress
  await mkdir(home, { recursive: true })
  await persistProgress()
  const check = (name, ok, details = {}) => result.checks.push({ name, ok: ok === true, ...details })
  const handles = []
  const trackedController = () => {
    const controller = new AbortController()
    controls.controllers.add(controller)
    return controller
  }
  const stage = async name => {
    if (controls.cancelled) throw new Error('fixture job cancelled')
    result.stage = name
    result.stageHistory.push({ stage: name, at: Date.now() })
    await persistProgress()
  }
  const waitForOwned = (predicate, label, timeoutMs = 6_000) => waitFor(() => {
    if (controls.cancelled) throw new Error('fixture job cancelled')
    return predicate()
  }, label, timeoutMs)
  let rootFixtureAgent
  let rootTurnOpen = false
  let releasePlan
  let releaseApproval
  let removePlanAnswerer
  let removeApprovalAnswerer
  const observerEntries = { question: 0, approval: 0 }
  const instrumentedHostContext = {
    on(event, listener, options) {
      const wrapped = function (...args) {
        if (event === 'user-questions/request') observerEntries.question++
        if (event === 'approval/request') observerEntries.approval++
        return Reflect.apply(listener, this, args)
      }
      return ctx.on(event, wrapped, options)
    },
    userQuestions: ctx.userQuestions,
    approval: ctx.approval,
    sessionProjections: ctx.sessionProjections,
    agents: ctx.agents,
  }
  const host = createPushHost(instrumentedHostContext)
  const seen = []
  host.subscribe(source => seen.push(source), () => {})
  result.available = host.available
  try {
    check('required public DSH services available', host.available)
    const planCallId = 'push-contract-plan-' + randomUUID()
    const planBarrier = new Promise(resolve => { releasePlan = resolve })
    controls.releasePlan = releasePlan
    removePlanAnswerer = ctx.on('user-questions/request', function (request, next) {
      if (request.questions?.some(item => item.intent?.kind === 'plan-review')) return planBarrier
      return next()
    }, { global: true, prepend: true })
    const approvalBarrier = new Promise(resolve => { releaseApproval = resolve })
    controls.releaseApproval = releaseApproval
    removeApprovalAnswerer = ctx.on('approval/request', function (_request, _next) {
      result.approvalAnswererEntries++
      result.approvalAnswererEnteredAt ??= Date.now()
      return approvalBarrier
    }, { global: true, prepend: true })
    const rootId = 'push-contract-root-' + randomUUID()
    let setupAgent
    let setupAgentRoot
    let setupSawUnpublishedAgent = false
    const rootHandle = await ctx.agents.create({
      sessionId: rootId,
      agentOptions: { provider: 'push-contract-no-provider', model: 'no-network-fixture' },
      setup(agentCtx, agent) {
        setupAgent = agent
        setupAgentRoot = agentCtx.root
        setupSawUnpublishedAgent = ctx.agents.get(agent.id) === undefined
      },
    })
    await stage('root-agent-created')
    handles.push(rootHandle)
    const root = rootHandle.agent
    rootFixtureAgent = root
    const fixtureCtxRoot = ctx.root
    const agentCtxRoot = root.ctx.root
    result.contextIdentity = {
      fixtureRootExposed: 'root' in ctx,
      fixtureRootIsSelfRoot: fixtureCtxRoot.root === fixtureCtxRoot,
      agentRootIsSelfRoot: agentCtxRoot.root === agentCtxRoot,
      fixtureAndAgentShareRootIdentity: fixtureCtxRoot === agentCtxRoot,
      fixtureAndAgentShareEventBus: ctx.events === root.ctx.events,
      agentSetupRootExposed: setupAgentRoot !== undefined,
      setupRootMatchesPublicAgentCtxRoot: setupAgentRoot === agentCtxRoot,
      setupAgentMatchesFactoryResult: setupAgent === root,
      factoryWasUnpublishedDuringSetup: setupSawUnpublishedAgent,
      exactFactoryAgentLive: ctx.agents.get(root.id) === root,
      exactFactoryAgentIsRuntimeRoot: ctx.agents.roots().includes(root),
      exactFactoryAgentHasNoLiveOwner: !ctx.agents.list().some(owner => ctx.agents.isOwnedBy(root.id, owner)),
    }
    let runtimeSessionEvents = 0
    const removeSessionProbe = ctx.on('session/event', () => { runtimeSessionEvents++ }, { global: true })
    const callId = 'push-contract-question-' + randomUUID()
    const question = { id: 'q1', question: 'Continue the fixture?', header: 'Fixture' }
    await root.session.append('request/header', {
      header: {
        config: { provider: 'push-contract-no-provider', model: 'no-network-fixture' },
        tools: [{ name: 'ask_user_question', description: 'fixture only', parameters: { type: 'object', properties: { timeout: { type: 'integer' } } } }],
      },
      reason: 'initial',
    })
    await root.session.append('turn/start', { turn: 1 })
    rootTurnOpen = true
    await root.session.append('tool/call', { turn: 1, step: 1, callId, name: 'ask_user_question', arguments: JSON.stringify({ questions: [question], timeout: 25 }) })
    check('public Session events dispatch to Host Cordis observers', runtimeSessionEvents > 0, { count: runtimeSessionEvents })
    const openState = ctx.sessionProjections.stateOf(root.session, 'userQuestions')
    check('real tool call projection opens active question', openState?.questions?.active?.some(item => item.callId === callId && item.state === 'open'), { state: openState })
    let unscopedQuestionDispatched = false
    const removeUnscopedProbe = ctx.on('user-questions/request', function (request, next) {
      if (request.questions?.some(item => item.id === 'host-event-probe')) {
        unscopedQuestionDispatched = true
        return { answers: [{ id: 'host-event-probe', selected: ['Observed'] }] }
      }
      return next()
    }, { global: true })
    const unscopedAnswer = await ctx.userQuestions.ask({ questions: [{ id: 'host-event-probe', question: 'Observe public Host dispatch?' }], signal: trackedController().signal })
    if (typeof removeUnscopedProbe === 'function') removeUnscopedProbe()
    check('unscoped public userQuestions request reaches global Host waterfall', unscopedQuestionDispatched && unscopedAnswer?.answers?.[0]?.selected?.[0] === 'Observed')
    const hostQuestionEntriesBeforeScopedAsk = observerEntries.question
    let publicQuestionDispatched = false
    const removeQuestionProbe = ctx.on('user-questions/request', function (_request, next) {
      publicQuestionDispatched = true
      return next()
    }, { global: true, prepend: true })
    const timedResult = await ctx.userQuestions.askTimed({ agent: root, questions: [question], signal: trackedController().signal }, callId, 25)
    if (typeof removeQuestionProbe === 'function') removeQuestionProbe()
    check('actual public timed question request uses a post-creation prepended Host observer', publicQuestionDispatched, { publicQuestionDispatched })
    check('the registered Host question callback enters the scoped waterfall exactly once', observerEntries.question === hostQuestionEntriesBeforeScopedAsk + 1, { before: hostQuestionEntriesBeforeScopedAsk, after: observerEntries.question })
    check('real public timed question returns continued result', timedResult?.pending === true && timedResult.callId === callId)
    await root.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: { id: randomUUID(), role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(timedResult) }] },
    }, { surfaceOp: 'append' })
    const projected = ctx.sessionProjections.stateOf(root.session, 'userQuestions')?.questions?.active?.find(question => question.callId === callId)
    check('real userQuestions projection reports continued', projected?.state === 'continued')
    const eligibilityNow = Date.now()
    const expectedSource = { sourceId: 'request:' + root.id + ':question:' + callId, sessionId: root.id, targetSessionId: root.id, category: 'question', createdAt: eligibilityNow, expiresAt: eligibilityNow + ATTENTION_TTL_MS, lifetime: 'live', callId }
    check('public Host policy considers the continued timed request eligible', await host.eligible(expectedSource), { hostAvailable: host.available, sourceId: expectedSource.sourceId })
    if (typeof removeSessionProbe === 'function') removeSessionProbe()
    const questionSource = await waitForOwned(() => seen.find(source => source.callId === callId), 'real timed question observer')
    result.sources.push(sourceSummary(questionSource))
    await stage('question-source-observed')
    await persistProgress()
    check('timed question remains eligible after continued projection', await host.eligible(questionSource))
    root.inbox.append('next-turn', {
      id: randomUUID(),
      role: 'user',
      source: { kind: 'user-question-reply', callId, outcome: 'answered' },
      content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId, questions: [question], answers: [{ id: 'q1', selected: ['Yes'] }] }) }],
    })
    check('public Agent inbox late reply suppresses attention without waking a model turn', !(await host.eligible(questionSource)))

    const planQuestion = { id: 'plan', question: 'Review this plan?', detail: '# owned fixture plan', options: [{ label: 'Approve' }, { label: 'Decline' }], intent: { kind: 'plan-review', approve: 'Approve', callId: planCallId } }
    const planPromise = ctx.userQuestions.ask({ agent: root, questions: [planQuestion], signal: trackedController().signal })
    const planSource = await waitForOwned(() => seen.find(source => source.callId === planCallId), 'retained legacy plan request')
    result.sources.push(sourceSummary(planSource))
    await stage('plan-source-observed')
    check('legacy plan source uses intent.callId and remains eligible without timed projection', planSource.category === 'plan' && planSource.callId === planCallId && await host.eligible(planSource))
    releasePlan({ answers: [{ id: 'plan', selected: ['Decline'] }] })
    await planPromise
    check('legacy plan stops being eligible when source request settles', !(await host.eligible(planSource)))
    if (typeof removePlanAnswerer === 'function') removePlanAnswerer()

    await root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    rootTurnOpen = false
    await stage('root-turn-closed')
    const childHandle = await ctx.agents.create({ sessionId: 'push-contract-child-' + randomUUID(), parentAgent: root, agentOptions: { provider: 'push-contract-no-provider', model: 'no-network-fixture' } })
    handles.push(childHandle)
    const forkHandle = await ctx.agents.create({ sessionId: 'push-contract-fork-' + randomUUID(), meta: { parentSession: root.session.id }, agentOptions: { provider: 'push-contract-no-provider', model: 'no-network-fixture' } })
    handles.push(forkHandle)
    const nestedHandle = await ctx.agents.create({
      sessionId: 'push-contract-nested-' + randomUUID(),
      parentAgent: childHandle.agent,
      agentOptions: { provider: 'push-contract-no-provider', model: 'no-network-fixture' },
    })
    handles.push(nestedHandle)
    await forkHandle.agent.session.append('turn/start', { turn: 1 })
    await forkHandle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await childHandle.agent.session.append('turn/start', { turn: 1 })
    await childHandle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const forkSource = await waitForOwned(() => seen.find(source => source.sessionId === forkHandle.agent.id && source.category === 'response'), 'ordinary fork outcome')
    result.sources.push(sourceSummary(forkSource))
    await stage('ordinary-fork-outcome-observed')
    check('ordinary fork completes but runtime-owned child completion is silent', forkSource.sessionId === forkHandle.agent.id && !seen.some(source => source.sessionId === childHandle.agent.id))

    await nestedHandle.agent.session.append('turn/start', { turn: 1 })
    const hostApprovalEntriesBeforeRequest = observerEntries.approval
    const approvalController = trackedController()
    const approvalPromise = ctx.approval.request({ agent: nestedHandle.agent, toolName: 'fixture-write', reason: 'push-contract-retained', signal: approvalController.signal })
    const approvalSource = await waitForOwned(() => seen.find(source => source.category === 'approval' && source.sessionId === nestedHandle.agent.id), 'actual nested approval request')
    result.sources.push(sourceSummary(approvalSource))
    await stage('nested-approval-source-observed')
    check('registered Host approval callback enters the nested scoped waterfall exactly once', observerEntries.approval === hostApprovalEntriesBeforeRequest + 1, { before: hostApprovalEntriesBeforeRequest, after: observerEntries.approval })
    await stage('approval-target-resolving')
    const approvalTarget = await host.resolveTarget(approvalSource)
    await stage('approval-target-resolved')
    check('nested public approval targets runtime root', approvalTarget?.sessionId === root.id && approvalTarget.interaction === 'current')
    controls.approvalBarrierReleasedAt = Date.now()
    result.approvalBarrierReleasedAt = controls.approvalBarrierReleasedAt
    releaseApproval('unavailable')
    await stage('approval-answerer-released')
    const approvalObserved = approvalPromise.then(outcome => {
      result.approvalPromiseSettledAt = Date.now()
      result.approvalOutcome = outcome
      void persistProgress()
      return { kind: 'resolved', outcome }
    }, error => {
      result.approvalPromiseSettledAt = Date.now()
      result.approvalErrorCode = error?.code
      result.approvalErrorName = error?.name
      void persistProgress()
      return { kind: 'rejected', code: error?.code, name: error?.name }
    })
    await stage('awaiting-approval-decision')
    const approvalResolutionBeforeAbort = await Promise.race([approvalObserved, pause(2_000).then(() => ({ kind: 'timeout-before-abort' }))])
    result.approvalResolutionBeforeAbort = approvalResolutionBeforeAbort
    result.approvalControllerAbortedBeforeFallback = approvalController.signal.aborted
    let approvalResolution = approvalResolutionBeforeAbort
    if (approvalResolutionBeforeAbort.kind === 'timeout-before-abort') {
      result.approvalTimedOutBeforeAbortAt = Date.now()
      approvalController.abort(new Error('fixture approval decision did not settle after answerer release'))
      approvalResolution = await Promise.race([approvalObserved, pause(2_000).then(() => ({ kind: 'timeout-after-abort' }))])
    }
    result.approvalResolution = approvalResolution
    const approvalPassed = approvalResolutionBeforeAbort.kind === 'resolved'
      && approvalResolutionBeforeAbort.outcome === 'unavailable'
      && result.approvalAnswererEntries === 1
      && approvalController.signal.aborted === false
    check('public nested approval settles as unavailable from its setup-installed answerer before fallback abort', approvalPassed, { answererEntries: result.approvalAnswererEntries, resolutionBeforeAbort: approvalResolutionBeforeAbort, signalAborted: approvalController.signal.aborted, barrierReleasedAt: result.approvalBarrierReleasedAt, settledAt: result.approvalPromiseSettledAt })
    await stage('approval-resolution-observed')
    await nestedHandle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await stage('nested-approval-settled')

    await stage('goal-agent-create-started')
    const goalHandle = await ctx.agents.create({ sessionId: 'push-contract-goal-' + randomUUID(), agentOptions: { provider: 'push-contract-no-provider', model: 'no-network-fixture' } })
    handles.push(goalHandle)
    await stage('goal-agent-created')
    const goal = ctx.goals.create(goalHandle.agent, { objective: 'Complete a fixture goal', maxGoalRounds: 2 })
    await stage('goal-created')
    await goalHandle.agent.session.append('turn/start', { turn: 1 })
    await stage('goal-first-turn-started')
    await goalHandle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await stage('goal-first-turn-ended')
    await pause(OUTCOME_COALESCE_MS + 50)
    await stage('goal-first-round-coalesced')
    check('active goal round does not produce ordinary response source', !seen.some(source => source.sessionId === goalHandle.agent.id && (source.category === 'response' || source.category === 'goal')))
    await stage('completing-goal')
    const completed = ctx.goals.complete(goalHandle.agent, { id: goal.id, revision: goal.revision })
    await stage('goal-completed')
    await goalHandle.agent.session.append('turn/start', { turn: 2 })
    await stage('final-goal-turn-started')
    await goalHandle.agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await stage('final-goal-turn-ended')
    await stage('waiting-for-final-goal-source')
    const goalSource = await waitForOwned(() => seen.find(source => source.sessionId === goalHandle.agent.id && source.category === 'goal' && source.goal?.revision === completed.revision), 'committed final goal outcome')
    result.sources.push(sourceSummary(goalSource))
    await stage('final-goal-source-observed')
    check('goal completion waits for final turn and coalesces to one goal outcome', seen.filter(source => source.sessionId === goalHandle.agent.id && source.category === 'goal').length === 1 && !seen.some(source => source.sessionId === goalHandle.agent.id && source.category === 'response'))

    await stage('blocked-goal-agent-create-started')
    const blockedHandle = await ctx.agents.create({ sessionId: 'push-contract-blocked-' + randomUUID(), agentOptions: { provider: 'push-contract-no-provider', model: 'no-network-fixture' } })
    handles.push(blockedHandle)
    await stage('blocked-goal-agent-created')
    const blockedGoal = ctx.goals.create(blockedHandle.agent, { objective: 'Blocked fixture goal', maxGoalRounds: 1 })
    await stage('blocked-goal-created')
    const blocked = ctx.goals.block(blockedHandle.agent, { id: blockedGoal.id, revision: blockedGoal.revision }, { code: 'fixture-blocked', message: 'do not expose this detail' })
    await stage('blocked-goal-committed')
    const blockSource = await waitForOwned(() => seen.find(source => source.sessionId === blockedHandle.agent.id && source.category === 'goal' && source.goal?.revision === blocked.revision), 'committed blocked goal')
    result.sources.push(sourceSummary(blockSource))
    await stage('blocked-goal-source-observed')
    check('blocked goal source is generic and has no raw blocked reason', !JSON.stringify(blockSource).includes('do not expose this detail'))

    await stage('failure-agent-create-started')
    const failedHandle = await ctx.agents.create({ sessionId: 'push-contract-failed-' + randomUUID(), agentOptions: { provider: 'push-contract-no-provider', model: 'no-network-fixture' } })
    handles.push(failedHandle)
    await stage('failure-agent-created')
    await failedHandle.agent.session.append('turn/start', { turn: 1 })
    await stage('failure-turn-started')
    await failedHandle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'FIXTURE_ERROR', message: 'fixture diagnostic secret' } } })
    await stage('failure-turn-ended')
    const failureSource = await waitForOwned(() => seen.find(source => source.sessionId === failedHandle.agent.id && source.category === 'failure'), 'committed terminal failure')
    result.sources.push(sourceSummary(failureSource))
    await stage('terminal-failure-source-observed')
    check('terminal failure outcome excludes diagnostic detail', !JSON.stringify(failureSource).includes('fixture diagnostic secret'))

    check('all candidate source identities are unique', new Set(result.sources.map(source => source.sourceId)).size === result.sources.length)
    result.observerEntries = { ...observerEntries }
    result.ok = result.checks.every(check => check.ok)
  } catch (error) {
    result.ok = false
    result.stageAtFailure = result.stage
    result.cancelReason = controls.cancelReason
    result.error = String(error?.stack ?? error?.message ?? error).slice(0, 4000)
    result.observerEntries = { ...observerEntries }
    result.sourcesAtFailure = seen.map(sourceSummary)
  } finally {
    try { releasePlan?.({ answers: [{ id: 'plan', selected: ['Decline'] }] }) } catch {}
    try { releaseApproval?.('unavailable') } catch {}
    try { removePlanAnswerer?.() } catch {}
    try { removeApprovalAnswerer?.() } catch {}
    result.stage = 'teardown-aborting-requests'
    await persistProgress()
    for (const controller of controls.controllers) controller.abort(new Error('fixture job cleanup'))
    if (rootTurnOpen && rootFixtureAgent) {
      try {
        await withinTimeout(rootFixtureAgent.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: 'fixture cleanup' } }), 5_000, 'closing fixture root turn')
        rootTurnOpen = false
      } catch (error) { result.cleanupError = String(error?.message ?? error).slice(0, 500) }
    }
    try { await withinTimeout(host.close(), 5_000, 'closing Host listeners') } catch (error) { result.cleanupError = String(error?.message ?? error).slice(0, 500) }
    for (const [index, owned] of handles.reverse().entries()) {
      result.stage = 'disposing-fixture-agent-' + index
      await persistProgress()
      try { await withinTimeout(owned.dispose(), 5_000, 'disposing fixture Agent ' + index) } catch (error) { result.cleanupError = String(error?.message ?? error).slice(0, 500) }
    }
    if (result.cleanupError) {
      result.ok = false
      result.stage = 'teardown-failed'
    }
    const home = process.env.DSH_HOME ?? process.cwd()
    const destination = join(home, 'push-contract-result.json')
    await mkdir(home, { recursive: true })
    await writeFile(destination, JSON.stringify(result, null, 2) + '\\n', { mode: 0o600 })
    if (!result.ok) throw new Error('public push host contract fixture failed; see owned push-contract-result.json')
  }
}

const FIXTURE_JOB_TIMEOUT_MS = 60_000
const FIXTURE_TEARDOWN_TIMEOUT_MS = 20_000

export async function apply(ctx) {
  const controls = { controllers: new Set(), cancelled: false, applyEnteredAt: Date.now() }
  let startTimer
  let deadlineTimer
  let job
  const cancelOwnedWork = reason => {
    controls.cancelReason ??= reason
    controls.cancelAt ??= Date.now()
    controls.cancelled = true
    if (controls.result) {
      controls.result.cancelReason = controls.cancelReason
      controls.result.cancelledAt = controls.cancelAt
      controls.result.stageBeforeCancellation ??= controls.result.stage
      void controls.persistProgress?.()
    }
    try { controls.releasePlan?.({ answers: [{ id: 'plan', selected: ['Decline'] }] }) } catch {}
    try { controls.releaseApproval?.('unavailable') } catch {}
    for (const controller of controls.controllers) controller.abort(new Error('fixture job cancelled'))
  }
  ctx.effect(() => {
    startTimer = setTimeout(() => {
      startTimer = undefined
      if (controls.cancelled) return
      controls.jobStartedAt = Date.now()
      controls.jobDeadlineAt = controls.jobStartedAt + FIXTURE_JOB_TIMEOUT_MS
      job = runFixtureJob(ctx, controls)
      deadlineTimer = setTimeout(() => {
        if (controls.result) {
          controls.result.stageBeforeDeadlineCancellation = controls.result.stage
          controls.result.stage = 'job-deadline-cancelling'
          controls.result.ok = false
          controls.result.error = 'bounded public Host fixture job deadline exceeded'
          void controls.persistProgress?.()
        }
        cancelOwnedWork('job-deadline')
      }, FIXTURE_JOB_TIMEOUT_MS)
      void job.catch(() => {}).finally(() => clearTimeout(deadlineTimer))
    }, 0)
    return async () => {
      if (startTimer !== undefined) clearTimeout(startTimer)
      startTimer = undefined
      cancelOwnedWork('root-effect-disposed')
      if (!job) return
      try {
        await withinTimeout(job.then(() => undefined, () => undefined), FIXTURE_TEARDOWN_TIMEOUT_MS, 'public Host fixture teardown')
      } catch (error) {
        if (controls.result) {
          controls.result.ok = false
          controls.result.stage = 'teardown-timeout'
          controls.result.cleanupError = String(error?.message ?? error).slice(0, 500)
          await controls.persistProgress?.()
        }
        throw error
      }
    }
  }, 'dsh-mobile public Host contract fixture')
}
`
}

/** Create a self-contained test-only DSH Host bundle containing the current adapter. */
export async function createPushContractFixture({ root, repository, tsdown }) {
  const packageRoot = resolve(root, 'push-contract-fixture-package')
  const sourceRoot = join(packageRoot, 'src')
  const outputRoot = join(packageRoot, 'lib')
  await mkdir(sourceRoot, { recursive: true })
  await mkdir(outputRoot, { recursive: true })
  await writeFile(join(sourceRoot, 'index.ts'), hostEntrySource(resolve(repository)))
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: 'dsh-mobile-push-contract-fixture',
    version: '1.0.0',
    private: true,
    type: 'module',
    main: './lib/index.js',
    exports: { '.': './lib/index.js', './package.json': './package.json' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n')
  await writeFile(join(packageRoot, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: dsh-mobile-push-contract-fixture',
    '      name: dsh-mobile-push-contract-fixture',
    '      inject: [agents, sessions, sessionProjections, userQuestions, approval, goals]',
    '',
  ].join('\n'))
  await run(tsdown, [join(sourceRoot, 'index.ts'), '--no-config', '--format', 'esm', '--platform', 'node', '--target', 'node22', '--out-dir', outputRoot, '--clean'], packageRoot)
  const outputs = await readdir(outputRoot)
  const entryFile = outputs.find(file => file === 'index.js' || file === 'index.mjs')
  if (!entryFile) throw new Error(`No bundled Host fixture entry in ${outputRoot}; outputs=${outputs.join(',')}`)
  const manifestPath = join(packageRoot, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.main = `./lib/${entryFile}`
  manifest.exports['.'] = `./lib/${entryFile}`
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return { packageRoot, entry: join(outputRoot, entryFile), packageName: 'dsh-mobile-push-contract-fixture' }
}
