/** Real owned DSH restart with browser feedback and a simulated native Cookie installer. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { dump, load } from 'js-yaml'
import { CLIENT_TIMEOUT_MS, createMobileProfile, dismissOnboarding, launchDsh, openPairing, pairMobilePage, removeTemporaryRoot } from './mobile-boot-fixture.mjs'

const dshBin = process.env.DSH_BOOT_SMOKE_BIN
const tarball = process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL
assert(dshBin && tarball, 'Set the exact DSH runtime and packed Mobile tarball')
const prefix = 'dsh-mobile-session-restart-'
const root = await mkdtemp(join(tmpdir(), prefix))
const evidence = resolve('local/session-restart-smoke', root.slice(root.lastIndexOf(prefix)))
const failures = []
const record = { scope: 'real local DSH restart and native-renew HTTP; simulated bridge/Cookie installer, not physical Android or public route', prompts: 0, renewals: 0, completed: false }
let host
let browser
try {
  const home = await createMobileProfile(root, { dshBin, tarball })
  record.stage = 'profile-installed'
  await writeFile(join(home, 'mobile-access/mobile.css'), ':root{--restart-qa:1}\n')
  host = launchDsh(root, home, dshBin)
  console.log(JSON.stringify({ stage: 'first-start', root }))
  browser = await chromium.launch()
  const admin = await browser.newPage({ locale: 'en-US' })
  const launchUrl = await host.ready()
  record.stage = 'first-ready'
  const pairUrl = await openPairing(admin, launchUrl, host.logs)
  const origin = new URL(pairUrl).origin
  const token = new URLSearchParams(new URL(pairUrl).hash.slice(1)).get('token')
  assert(token, 'Owned pairing URL has no token')
  const nativeRequest = async (path, body) => {
    const response = await fetch(new URL(path, origin), { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
    const value = await response.json()
    return { status: response.status, value }
  }
  const paired = await nativeRequest('/mobile-access/auth/native-pair', { token, label: 'Owned restart QA' })
  assert.equal(paired.status, 201)
  const credential = paired.value
  assert.equal(typeof credential.deviceToken, 'string')
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US', isMobile: true, hasTouch: true })
  const installCookies = async value => context.addCookies([
    { name: 'dsh_ma_session', value: value.sessionToken, url: origin, httpOnly: true, sameSite: 'Strict' },
    { name: 'dsh_ma_csrf', value: value.csrfToken, url: origin, sameSite: 'Strict' },
  ])
  await installCookies(credential)
  const phone = await context.newPage()
  await phone.exposeFunction('__restartQaRenew', async () => {
    record.renewals++
    let renewed
    try { renewed = await nativeRequest('/mobile-access/auth/native-renew', { deviceToken: credential.deviceToken }) }
    catch (error) { record.firstNativeFailure = error.name; throw error }
    record.nativeRenewStatus = renewed.status
    record.nativeRenewError = renewed.value.error
    assert.equal(renewed.status, 200, 'The real native-renew route refused the persisted credential')
    await installCookies(renewed.value)
    record.cookiesInstalled = true
    return { renewed: true }
  })
  await phone.addInitScript(() => {
    window.__DSH_MOBILE_NATIVE__ = {
      capabilities: () => ['auth.renew'],
      invoke: async (action, _input, options) => {
        options?.signal?.throwIfAborted()
        if (action !== 'auth.renew') throw new Error('Unexpected native action')
        const result = await window.__restartQaRenew()
        window.__restartQaRenewed = (window.__restartQaRenewed ?? 0) + 1
        return result
      },
    }
  })
  await phone.route('**/api/session/prompt', async route => { record.prompts++; await route.abort('blockedbyclient') })
  await phone.goto(origin, { waitUntil: 'domcontentloaded' })
  await phone.locator('.dshm-shell').waitFor({ timeout: CLIENT_TIMEOUT_MS })
  await dismissOnboarding(phone)
  await phone.evaluate(() => { window.__restartQaDocument = {} })
  const original = await phone.evaluateHandle(() => window.__restartQaDocument)
  await phone.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--restart-qa').trim() === '1')

  // An ordinary browser keeps a separate short Session and cannot use the bridge.
  const browserPage = await browser.newPage({ viewport: { width: 375, height: 700 }, locale: 'en-US' })
  const browserPairUrl = await openPairing(admin, launchUrl, host.logs)
  await pairMobilePage(browserPage, browserPairUrl, host.logs)
  await dismissOnboarding(browserPage)
  await browserPage.route('**/api/session/prompt', async route => { record.prompts++; await route.abort('blockedbyclient') })

  // Reuse the port actually acquired by the first Gateway so the document Origin
  // stays fixed; the upstream DSH CLI can acquire a new port normally.
  for (const path of [join(home, 'profiles/web/cordis.patch.yml'), join(home, 'mobile-access/setup.json')]) {
    const yaml = path.endsWith('.yml')
    const source = await readFile(path, 'utf8')
    const value = yaml ? load(source) : JSON.parse(source)
    if (Array.isArray(value)) {
      const row = value.find(entry => entry.id === 'mobile-access')
      assert(row, 'Owned profile has no Mobile entry')
      row.config.listenPort = Number(new URL(origin).port)
    } else value.listenPort = Number(new URL(origin).port)
    await writeFile(path, yaml ? dump(value, { noRefs: true }) : JSON.stringify(value) + '\n')
  }
  const exit = await host.close()
  assert(!exit.forced && (exit.code === 0 || exit.signal === 'SIGTERM'), 'Owned initial DSH did not stop normally')
  host = launchDsh(root, home, dshBin)
  await host.ready()
  await browserPage.locator('[data-dsh-mobile-customization-notice]').waitFor({ state: 'visible', timeout: 90_000 })
  if (await phone.evaluate(() => window.__restartQaRenewed !== 1)) {
    await phone.locator('[data-dsh-mobile-customization-notice]').waitFor({ state: 'visible' })
    await phone.locator('.dshm-notice-action').click()
  }
  await phone.waitForFunction(() => window.__restartQaRenewed === 1, undefined, { timeout: 45_000 })
  assert.equal(await phone.evaluate(async () => (await fetch('/mobile-access/custom.css')).status), 200)
  assert(record.renewals <= 2, 'Restart should not create a renewal storm')
  assert.equal(await phone.evaluate(original => window.__restartQaDocument === original, original), true, 'Recovery replaced the document')
  assert.equal((await browserPage.request.get(new URL('/mobile-access/custom.css', origin).href)).status(), 401)
  const retry = browserPage.locator('.dshm-notice-action')
  await retry.click()
  assert.equal(await browserPage.locator('[data-dsh-mobile-customization-notice]').isVisible(), true, 'Browser retry must not hide an unresolved authentication warning')
  const target = await retry.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }))
  assert(target.width >= 44 && target.height >= 44)
  await phone.waitForFunction(() => {
    const notice = document.querySelector('[data-dsh-mobile-customization-notice]')
    return notice === null || notice.hidden
  })
  assert.equal(record.prompts, 0)
  record.completed = true
} catch (error) {
  failures.push(error)
  record.hostLogs = host?.logs()
  record.failure = 'Session-restart behavior check failed; see the thrown assertion'
} finally {
  const beforeCleanup = failures.length
  let hostStopped = true
  if (browser) await browser.close().catch(error => { failures.push(error) })
  if (host) {
    try {
      const exit = await host.close()
      assert(!exit.forced && (exit.code === 0 || exit.signal === 'SIGTERM'), 'Owned final DSH did not stop normally')
    } catch (error) { hostStopped = false; failures.push(error) }
  }
  if (hostStopped) await removeTemporaryRoot(root, prefix).catch(error => { failures.push(error) })
  record.cleanup = failures.length === beforeCleanup ? 'completed' : 'failed'
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'evidence.json'), JSON.stringify(record, null, 2) + '\n')
}
console.log(JSON.stringify({ ...record, evidence }))
if (failures.length) throw new AggregateError(failures, 'Session-restart smoke failed')
