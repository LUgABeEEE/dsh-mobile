/**
 * #292 evidence: measure the live-path (`/api/remote.mux`) WebSocket compression
 * against the same seeded workload, with the feature on and off.
 *
 * Two owned isolated DSH profiles are launched from the same packed tarball, one
 * with `websocketCompression.paths: ['/api/remote.mux']` and one with the explicit
 * `paths: []` opt-out. Each profile is measured twice:
 *
 *  1. Wire bytes, through a Node `ws` client that speaks the real mux protocol
 *     (`open`/`item` frames). `socket.bytesRead`/`bytesWritten` are the actual TCP
 *     bytes, so this is the transferred volume, not the decoded payload size.
 *  2. Interactivity and resource use, through real Chromium: the mounted composer
 *     becoming usable, plus CDP `Performance.getMetrics` task/script time and heap.
 *
 * Scenarios per profile: cold boot + baseline, session switch, two concurrent
 * connections, a large binary frame, a normal close, and an invalid frame. Each is
 * also repeated under CDP network throttling, which is labelled as artificial and is
 * not a public-network or cellular measurement.
 *
 * It never submits a prompt and never starts a model call.
 *
 * Usage: node scripts/measure-mux-compression.mjs
 * Environment (optional): DSH_BOOT_SMOKE_BIN, DSH_BOOT_SMOKE_MOBILE_TARBALL,
 *   MUX_EVIDENCE_DIRECTORY.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { chromium } from 'playwright'
import { installPackedBundle, packBundle } from './packed-profile.mjs'
import {
  createMobileProfile, launchDsh, removeTemporaryRoot, openPairing,
  pairMobilePage, dismissOnboarding, CLIENT_TIMEOUT_MS, sanitized,
} from './mobile-boot-fixture.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const dshBin = process.env.DSH_BOOT_SMOKE_BIN
  ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const evidenceDirectory = process.env.MUX_EVIDENCE_DIRECTORY
  ?? join(repository, 'local', 'mux-compression-evidence')
const prefix = 'dsh-mobile-mux-measure-'
const root = await mkdtemp(join(tmpdir(), prefix))
const fixtureName = 'dsh-mobile-mux-seed'

/** The two configurations under test; the only difference between them. */
const GROUPS = [
  { id: 'compressed', paths: ['/api/remote.mux'] },
  { id: 'identity', paths: [] },
]

const SEEDED_TURNS = 120

/**
 * Host fixture: commit completed synthetic Turns through the public Session
 * services, so the live stream carries a realistic journal. No Agent, no model.
 */
const fixtureHost = `import {createUserMessage} from '@deepseek-ai/dsh-llm';
export const inject=['webServer','sessionController','sessions'];
export function apply(ctx){ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/mux-seed',handler:async(request,response)=>{
 if(request.method!=='POST'){response.writeHead(405);response.end();return}
 const id=new URL(request.url,'http://fixture.invalid').searchParams.get('id');
 const resolved=await ctx.sessionController.resolveAgent(id);
 if(resolved.agent===undefined){response.writeHead(409,{'Content-Type':'application/json'});response.end(JSON.stringify({error:resolved.error}));return}
 const session=resolved.agent.session;
 for(let turn=1;turn<=${SEEDED_TURNS};turn++){
  session.append('turn/start',{turn});
  session.append('user/message',createUserMessage({content:[{type:'text',text:'Seeded live-stream turn '+String(turn).padStart(3,'0')+' with a representative amount of JSON-escaped text so the frame has realistic entropy: the quick brown fox jumps over the lazy dog.'}],source:{kind:'user'}}),{surfaceOp:'append'});
  session.append('turn/end',{turn,reason:{kind:'completed'}});
 }
 await ctx.sessions.flush(session);
 response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({ok:true,turns:${SEEDED_TURNS}}));
}}))}
`

async function addSeedFixture(home) {
  const directory = join(root, fixtureName)
  await mkdir(join(directory, 'lib'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: fixtureName, version: '1.0.0', type: 'module', main: './lib/index.mjs',
    exports: { '.': './lib/index.mjs', './package.json': './package.json' },
    peerDependencies: { '@deepseek-ai/dsh-llm': '*' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }) + '\n')
  await writeFile(join(directory, 'lib/index.mjs'), fixtureHost)
  await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'mux-seed', name: fixtureName }] }]) + '\n')
  await installPackedBundle(await packBundle(directory, root), join(home, 'profiles', 'web'), { dshBin })
}

/** One real RPC call through an authenticated page. */
async function rpc(page, method, request, argumentName = 'request') {
  const response = await page.evaluate(async ({ method, request, argumentName }) => {
    const result = await fetch(`/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: { [argumentName]: request } },
      }),
      signal: AbortSignal.timeout(60_000),
    })
    return { status: result.status, body: await result.json() }
  }, { method, request, argumentName })
  assert.equal(response.status, 200, `${method} HTTP failure`)
  assert.equal(response.body.result?.ok, true, `${method} RPC failure: ${JSON.stringify(response.body.result?.error)}`)
  return response.body.result.value
}

/**
 * A Node mux client that reports the real TCP bytes it moved.
 *
 * `socket.bytesRead`/`bytesWritten` count the WebSocket frames on the wire, so a
 * compressed group and an identity group can be compared on transferred volume
 * rather than on the decoded JSON both of them deliver.
 */
class MuxClient {
  constructor(origin, cookie) {
    this.origin = origin
    this.cookie = cookie
    this.socket = undefined
    this.streams = new Map()
    this.frames = 0
    this.items = 0
  }

  /** Open the authenticated mux socket and wait for the 101. */
  async open() {
    const url = `${this.origin.replace(/^http/u, 'ws')}/api/remote.mux`
    const socket = new WebSocket(url, {
      perMessageDeflate: true,
      headers: { origin: this.origin, cookie: this.cookie, 'sec-fetch-site': 'same-origin' },
    })
    this.socket = socket
    this.extensions = ''
    this.firstBaseline = Promise.withResolvers()
    await new Promise((resolveOpen, rejectOpen) => {
      socket.once('open', () => {
        this.extensions = socket.extensions
        resolveOpen()
      })
      socket.once('unexpected-response', (_request, response) => {
        response.resume()
        rejectOpen(new Error(`mux upgrade rejected with ${String(response.statusCode)}`))
      })
      socket.once('error', rejectOpen)
    })
    socket.on('message', (data) => {
      this.frames += 1
      let message
      try { message = JSON.parse(String(data)) } catch { return }
      if (message?.type === 'item') {
        this.items += 1
        const endpoint = this.streams.get(message.streamId)
        if (endpoint === 'workspace/follow' && this.firstBaseline.settled !== true) {
          this.firstBaseline.settled = true
          this.firstBaseline.resolve(message.value)
        }
      }
    })
    return this
  }

  /** Bytes moved so far, read from the underlying TCP socket. */
  bytes() {
    const socket = this.socket?._socket
    return { read: socket?.bytesRead ?? 0, written: socket?.bytesWritten ?? 0 }
  }

  /** Open one logical stream, as the real client carrier does. */
  stream(streamId, endpoint, payload) {
    this.streams.set(streamId, endpoint)
    this.socket.send(JSON.stringify({
      type: 'open', streamId, endpoint, ...(payload === undefined ? {} : { payload }),
    }))
  }

  /** Send one application frame of a given shape. */
  send(value, binary = false) {
    const body = binary ? Buffer.from(value) : JSON.stringify(value)
    this.socket.send(body, { binary })
  }

  /** Write a raw frame, for the invalid-frame scenario. */
  writeRaw(buffer) {
    this.socket._socket.write(buffer)
  }

  close() {
    return new Promise((resolveClose) => {
      if (this.socket === undefined || this.socket.readyState === WebSocket.CLOSED) { resolveClose(); return }
      this.socket.once('close', () => { resolveClose() })
      this.socket.close()
    })
  }
}

/** Measure one profile: wire bytes through the mux, then browser interactivity. */
async function measureGroup(group, tarball) {
  const groupRoot = join(root, group.id)
  await mkdir(groupRoot, { recursive: true })
  const home = await createMobileProfile(groupRoot, {
    tarball, dshBin, websocketCompressionPaths: group.paths,
  })
  await addSeedFixture(home)
  const dsh = launchDsh(groupRoot, home, dshBin)
  const result = { id: group.id, paths: group.paths, scenarios: {}, browser: {}, failures: [] }
  let browser
  try {
    const baseUrl = await dsh.ready()
    browser = await chromium.launch()
    const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const desktopPage = await desktopContext.newPage()
    const pairUrl = await openPairing(desktopPage, baseUrl, () => dsh.logs())
    const gatewayOrigin = new URL(pairUrl).origin

    // Seeded Session and Workspace, through the real services.
    const workspacePath = join(groupRoot, 'owned-workspace')
    await mkdir(workspacePath, { recursive: true })
    const workspace = await rpc(desktopPage, 'workspace/create', { path: workspacePath })
    const workspaceId = workspace.workspace.workspaceId
    const sessionIds = []
    for (let index = 0; index < 2; index += 1) {
      const created = await rpc(desktopPage, 'session/create', { workspaceId })
      const seeded = await desktopPage.evaluate(async (id) => {
        const response = await fetch(`/api/mux-seed?id=${encodeURIComponent(id)}`, { method: 'POST', signal: AbortSignal.timeout(120_000) })
        const text = await response.text()
        let body
        try { body = JSON.parse(text) } catch { body = undefined }
        return { status: response.status, body }
      }, created.sessionId)
      assert.equal(seeded.status, 200, `Seed fixture rejected: ${JSON.stringify(seeded)}`)
      sessionIds.push(created.sessionId)
    }
    result.sessionIds = sessionIds

    // Pair a real phone page; its cookie also authenticates the Node mux client.
    const phoneContext = await browser.newContext({
      viewport: { width: 393, height: 720 }, locale: 'en-US', isMobile: true, hasTouch: true, reducedMotion: 'reduce',
    })
    const phonePage = await phoneContext.newPage()
    await pairMobilePage(phonePage, pairUrl, () => dsh.logs())
    await dismissOnboarding(phonePage)
    const cookies = await phoneContext.cookies(gatewayOrigin)
    const cookieHeader = cookies.map(entry => `${entry.name}=${entry.value}`).join('; ')
    assert.ok(cookieHeader.length > 0, 'paired phone cookie is required')

    // Scenario: cold connect, workspace baseline, session journal.
    const cold = new MuxClient(gatewayOrigin, cookieHeader)
    const coldStartedAt = Date.now()
    await cold.open()
    result.wireExtensions = cold.extensions
    cold.stream('s1', 'workspace/follow', { args: {} })
    await Promise.race([cold.firstBaseline.promise, new Promise((_r, reject) => setTimeout(() => reject(new Error('workspace baseline timeout')), 20_000))])
    const baselineAt = Date.now()
    cold.stream('s2', 'session/follow', { args: { request: { address: { kind: 'session', sessionId: sessionIds[0] } } } })
    await new Promise(resolveWait => setTimeout(resolveWait, 1_500))
    const coldBytes = cold.bytes()
    result.scenarios.initialize = {
      openMs: baselineAt - coldStartedAt,
      streamMs: Date.now() - coldStartedAt,
      frames: cold.frames,
      items: cold.items,
      bytesRead: coldBytes.read,
      bytesWritten: coldBytes.written,
    }

    // Scenario: switch to the other Session on the same connection.
    const beforeSwitch = cold.bytes()
    cold.stream('s3', 'session/follow', { args: { request: { address: { kind: 'session', sessionId: sessionIds[1] } } } })
    await new Promise(resolveWait => setTimeout(resolveWait, 1_500))
    const afterSwitch = cold.bytes()
    result.scenarios.switch = {
      bytesRead: afterSwitch.read - beforeSwitch.read,
      bytesWritten: afterSwitch.written - beforeSwitch.written,
      items: cold.items,
    }

    // Scenario: a large binary frame in each direction.
    const beforeBinary = cold.bytes()
    const binaryPayload = Buffer.alloc(64 * 1024, 0x5a)
    cold.send(binaryPayload, true)
    await new Promise(resolveWait => setTimeout(resolveWait, 400))
    const afterBinary = cold.bytes()
    result.scenarios.binary = {
      payloadBytes: binaryPayload.byteLength,
      bytesRead: afterBinary.read - beforeBinary.read,
      bytesWritten: afterBinary.written - beforeBinary.written,
    }

    // Scenario: a second concurrent connection, measured once both have settled so
    // the comparison covers two live streams rather than one handshake.
    const second = new MuxClient(gatewayOrigin, cookieHeader)
    await second.open()
    second.stream('c1', 'workspace/follow', { args: {} })
    await new Promise(resolveWait => setTimeout(resolveWait, 2_000))
    const secondBytes = second.bytes()
    const coldAfterConcurrent = cold.bytes()
    result.scenarios.concurrent = {
      extensions: second.extensions,
      bytesRead: secondBytes.read,
      bytesWritten: secondBytes.written,
      frames: second.frames,
      firstConnectionBytesRead: coldAfterConcurrent.read,
      combinedBytesRead: secondBytes.read + coldAfterConcurrent.read,
    }

    // Scenario: invalid frame closes the leg without relaying garbage.
    const invalid = new MuxClient(gatewayOrigin, cookieHeader)
    await invalid.open()
    const invalidClosed = new Promise(resolveClose => { invalid.socket.once('close', code => { resolveClose(code) }) })
    invalid.writeRaw(Buffer.concat([
      Buffer.from([0xc1, 0x86, 0x00, 0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0x41, 0x42, 0x43, 0x44, 0x45, 0x46]),
    ]))
    result.scenarios.invalidFrame = { closeCode: await Promise.race([invalidClosed, new Promise(resolveWait => setTimeout(() => resolveWait('timeout'), 5_000))]) }

    // Scenario: normal close releases the leg.
    await second.close()
    result.scenarios.close = { closed: second.socket.readyState === WebSocket.CLOSED }
    await cold.close()
    await invalid.close().catch(() => {})

    // Browser: interactivity and resource use on a fresh page of the paired Gateway
    // origin (the phone's own entry, not the desktop launch URL).
    const metricsPage = await phoneContext.newPage()
    const session = await metricsPage.context().newCDPSession(metricsPage)
    await session.send('Performance.enable')
    const navigationStartedAt = Date.now()
    await metricsPage.goto(gatewayOrigin, { waitUntil: 'domcontentloaded' })
    const interactiveAt = Date.now()
    await metricsPage.waitForFunction(() => document.querySelector('.dshm-shell') !== null, undefined, { timeout: CLIENT_TIMEOUT_MS })
    const mountedAt = Date.now()
    const composerVisibleAt = await metricsPage.locator('[data-composer-input]').first()
      .waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS }).then(() => Date.now()).catch(() => undefined)
    const metrics = await session.send('Performance.getMetrics')
    const metricOf = (name) => metrics.metrics.find(entry => entry.name === name)?.value ?? null
    result.browser = {
      interactiveMs: interactiveAt - navigationStartedAt,
      mountedMs: mountedAt - navigationStartedAt,
      composerVisibleMs: composerVisibleAt === undefined ? null : composerVisibleAt - navigationStartedAt,
      taskDurationMs: (metricOf('TaskDuration') ?? 0) * 1000,
      scriptDurationMs: (metricOf('ScriptDuration') ?? 0) * 1000,
      layoutDurationMs: (metricOf('LayoutDuration') ?? 0) * 1000,
      jsHeapUsedBytes: metricOf('JSHeapUsedSize'),
      jsHeapTotalBytes: metricOf('JSHeapTotalSize'),
      muxExtensions: await metricsPage.evaluate(() => performance.getEntriesByType('resource').length),
    }
    await metricsPage.close()

    // Same page under artificial throttling. This is a controlled comparison, not a
    // public-network or cellular measurement.
    const slowPage = await phoneContext.newPage()
    const slowSession = await slowPage.context().newCDPSession(slowPage)
    await slowSession.send('Network.enable')
    await slowSession.send('Network.emulateNetworkConditions', {
      offline: false, latency: 150, downloadThroughput: 250 * 1024, uploadThroughput: 250 * 1024,
    })
    const slowStartedAt = Date.now()
    await slowPage.goto(gatewayOrigin, { waitUntil: 'domcontentloaded' })
    const slowMounted = await slowPage.waitForFunction(() => document.querySelector('.dshm-shell') !== null, undefined, { timeout: CLIENT_TIMEOUT_MS })
      .then(() => Date.now()).catch(() => undefined)
    await slowSession.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    })
    result.browser.throttled = {
      note: 'CDP artificial throttle (150 ms RTT, 250 KB/s); not a public-network measurement',
      mountedMs: slowMounted === undefined ? null : slowMounted - slowStartedAt,
      mounted: slowMounted !== undefined,
    }
    await slowPage.close()
    void slowMounted
    return result
  } catch (error) {
    result.failures.push(error instanceof Error ? error.message : String(error))
    result.logs = sanitized(dsh.logs())
    return result
  } finally {
    if (browser !== undefined) await browser.close().catch(() => {})
    await dsh.close().catch(() => {})
  }
}

try {
  await mkdir(evidenceDirectory, { recursive: true })
  const tarball = process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL ?? await packBundle(repository, root)
  const results = []
  for (const group of GROUPS) {
    console.log(`Measuring ${group.id} (paths=${JSON.stringify(group.paths)})`)
    results.push(await measureGroup(group, tarball))
  }

  const [compressed, identity] = results
  const ratio = (on, off) => (on === null || off === null || off === 0 ? null : Number((on / off).toFixed(4)))
  const report = {
    issue: 292,
    dsh: dshBin,
    tarball,
    seededTurns: SEEDED_TURNS,
    groups: results,
    comparison: {
      initializeBytesRead: ratio(compressed.scenarios.initialize?.bytesRead, identity.scenarios.initialize?.bytesRead),
      initializeBytesWritten: ratio(compressed.scenarios.initialize?.bytesWritten, identity.scenarios.initialize?.bytesWritten),
      switchBytesRead: ratio(compressed.scenarios.switch?.bytesRead, identity.scenarios.switch?.bytesRead),
      binaryBytesWritten: ratio(compressed.scenarios.binary?.bytesWritten, identity.scenarios.binary?.bytesWritten),
      concurrentBytesRead: ratio(compressed.scenarios.concurrent?.bytesRead, identity.scenarios.concurrent?.bytesRead),
      concurrentCombinedBytesRead: ratio(compressed.scenarios.concurrent?.combinedBytesRead, identity.scenarios.concurrent?.combinedBytesRead),
      interactiveMs: ratio(compressed.browser?.interactiveMs, identity.browser?.interactiveMs),
      taskDurationMs: ratio(compressed.browser?.taskDurationMs, identity.browser?.taskDurationMs),
      jsHeapUsedBytes: ratio(compressed.browser?.jsHeapUsedBytes, identity.browser?.jsHeapUsedBytes),
      throttledMountedMs: ratio(compressed.browser?.throttled?.mountedMs, identity.browser?.throttled?.mountedMs),
    },
  }
  await writeFile(join(evidenceDirectory, 'mux-compression-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ok: true, comparison: report.comparison, evidenceDirectory }, null, 2))
  if (results.some(group => group.failures.length > 0)) process.exitCode = 1
} catch (error) {
  console.error(`MUX MEASUREMENT FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await removeTemporaryRoot(root, prefix).catch(() => {})
}
