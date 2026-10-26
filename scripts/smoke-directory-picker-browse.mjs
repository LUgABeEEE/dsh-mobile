/**
 * Prove that a browse-capable DSH keeps its own directory-picker on the Mobile page.
 *
 * DSH composes `directory-picker` as `dsh-host-directory-picker-auto`, which mounts
 * the browse implementation whenever the host is reachable from a remote authority.
 * Its client face then fills the same directory-flow slots the plugin would use, so
 * the plugin must stand aside: the upstream web implementation carries the official
 * styling and its own folder creation.
 *
 * A non-loopback `--trusted-host` forces that branch on a local machine, so this
 * fixture can observe the real upstream surface without a second host.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createMobileProfile, launchDsh, removeTemporaryRoot, openPairing, pairMobilePage,
  dismissOnboarding, CLIENT_TIMEOUT_MS, sanitized } from './mobile-boot-fixture.mjs'
import { packBundle } from './packed-profile.mjs'
import { completeSmoke, recordSmokeFailure } from './negative-control.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined ? repository : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const dshBin = process.env.DSH_BOOT_SMOKE_BIN ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const prefix = 'dsh-mobile-browse-picker-smoke-'
const root = await mkdtemp(join(tmpdir(), prefix))
const hostRoot = join(root, 'browse-root')
const createdFolder = join(hostRoot, 'smoke-browse-created')
// A non-loopback trusted authority makes DSH resolve the browse interaction on a
// local host, which is exactly the composition a remote browser reaches.
const trusted = ['--trusted-host', '198.18.0.1']
const upstreamNewFolder = /new folder|新建文件夹|neuer ordner|nouvelle/i
const upstreamCreate = /^(create|创建|erstellen|créer)$/iu
const failures = []
const pageErrors = []
const prompts = []
let browser, desktop, phone, dsh, checks = 0

function pass(name) {
  checks++
  console.log(`PASS ${name}`)
}

try {
  await mkdir(hostRoot, { recursive: true })
  const tarball = process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL === undefined ? await packBundle(mobileRoot, root)
    : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL)
  console.log(JSON.stringify({ artifactSha256: createHash('sha256').update(await readFile(tarball)).digest('hex'), copiedProfileFiles: true }))
  const home = await createMobileProfile(root, { tarball, dshBin })
  // The upstream browse picker starts at the host user's home directory. Point the
  // launched process at an owned directory so a created folder never lands in the
  // real user profile.
  const previousHome = process.env.HOME
  const previousProfile = process.env.USERPROFILE
  process.env.HOME = hostRoot
  process.env.USERPROFILE = hostRoot
  try {
    dsh = launchDsh(root, home, dshBin, trusted)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousProfile
  }
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en-US', reducedMotion: 'reduce' })
  await context.route('**/api/session/prompt', async route => { prompts.push('session/prompt'); await route.abort('blockedbyclient') })
  desktop = await context.newPage()
  await desktop.goto(await dsh.ready(), { waitUntil: 'domcontentloaded' })
  const desktopGraph = await desktop.evaluate(() => {
    const entries = globalThis.__DSH_BOOT__?.entries ?? []
    return entries.map(entry => entry.id).filter(id => typeof id === 'string' && id.includes('directory-picker'))
  })
  assert.deepEqual(desktopGraph, ['@deepseek-ai/dsh-client-ui-directory-picker-browse'],
    `A trusted remote authority must resolve DSH's browse picker, saw ${JSON.stringify(desktopGraph)}`)
  pass('a reachable remote authority resolves DSH\'s own browse directory-picker')

  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    locale: 'en-US', reducedMotion: 'reduce' })
  await phoneContext.route('**/api/session/prompt', async route => { prompts.push('session/prompt'); await route.abort('blockedbyclient') })
  phone = await phoneContext.newPage()
  phone.setDefaultTimeout(CLIENT_TIMEOUT_MS)
  phone.on('pageerror', error => pageErrors.push(error.message))
  await pairMobilePage(phone, await openPairing(desktop, undefined, dsh.logs), dsh.logs)
  await dismissOnboarding(phone)

  const phoneGraph = await phone.evaluate(() => {
    const entries = globalThis.__DSH_BOOT__?.entries ?? []
    return entries.map(entry => entry.id).filter(id => typeof id === 'string' && id.includes('directory-picker'))
  })
  assert.deepEqual(phoneGraph, ['@deepseek-ai/dsh-client-ui-directory-picker-browse'],
    `The dedicated page must keep the upstream browse picker, saw ${JSON.stringify(phoneGraph)}`)

  const drawer = phone.locator('[data-dsh-mobile-sidebar]')
  if (await drawer.getAttribute('data-open') !== 'true') await drawer.locator('[data-dsh-mobile-toggle]').click()
  await drawer.getByRole('button', { name: 'Add workspace', exact: true }).click()

  const upstreamDialog = phone.locator('[role="dialog"], dialog').filter({ hasText: /workspace directory|工作区目录/i }).first()
  await upstreamDialog.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  const owned = await phone.evaluate(() => ({
    pluginDialog: document.querySelectorAll('.dshm-picker').length,
    pluginStyle: document.querySelectorAll('style[data-plugin="dsh-mobile-directory-picker"]').length,
  }))
  assert.equal(owned.pluginDialog, 0, 'The plugin\'s own picker still occupies the browse flow')
  assert.equal(owned.pluginStyle, 0, 'The plugin\'s own picker styles still load in a browse composition')
  pass('the plugin stands aside and DSH\'s own browse picker owns the Mobile directory flow')

  const newFolder = phone.getByRole('button', { name: upstreamNewFolder }).first()
  await newFolder.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  await newFolder.click()
  // The upstream create panel is its own popover, mounted outside the picker dialog.
  // Its text input carries the upstream placeholder and enables the Create button.
  const createInput = phone.getByPlaceholder(/untitled folder|未命名/i).first()
  await createInput.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  await createInput.fill('smoke-browse-created')
  const createButton = phone.getByRole('button', { name: upstreamCreate }).last()
  await createButton.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  await createButton.click()
  await phone.waitForFunction(name => {
    for (const node of document.querySelectorAll('[class*="_row_"], [class*="row"]')) {
      if ((node.textContent ?? '').trim() === name) return true
    }
    return false
  }, 'smoke-browse-created', { timeout: CLIENT_TIMEOUT_MS })
  assert(existsSync(createdFolder), 'the upstream picker did not create the folder on the host')
  pass('the upstream browse picker creates a real host folder on the remote entry')

  assert.deepEqual(pageErrors, [], `Page errors: ${sanitized(pageErrors.join(' | '))}`)
  assert.deepEqual(prompts, [], 'The smoke attempted a model request')
  pass('the browse composition completes without page errors or model requests')
} catch (error) {
  recordSmokeFailure(failures, error)
  if (phone !== undefined && !phone.isClosed()) {
    try {
      console.error(sanitized(JSON.stringify({ pageErrors, visibleUi: (await phone.locator('body').innerText()).slice(0, 9000) })))
    } catch (diagnosticError) { recordSmokeFailure(failures, diagnosticError) }
  }
  if (dsh !== undefined) console.error(dsh.logs())
} finally {
  let browserStopped = browser === undefined
  let dshStopped = dsh === undefined
  try { await browser?.close(); browserStopped = true } catch (error) { recordSmokeFailure(failures, error) }
  try {
    const stopped = await dsh?.close()
    dshStopped = true
    if (stopped?.forced === true) recordSmokeFailure(failures, new Error('Owned DSH needed a forced shutdown'))
  } catch (error) { recordSmokeFailure(failures, error) }
  if (browserStopped && dshStopped) {
    try { await removeTemporaryRoot(root, prefix) } catch (error) { recordSmokeFailure(failures, error) }
  } else recordSmokeFailure(failures, new Error(`Retained owned fixture because process shutdown was not confirmed: ${root}`))
  if (prompts.length > 0) recordSmokeFailure(failures, new Error('A model request was attempted during acceptance or cleanup'))
}

completeSmoke(failures)
console.log(`browse directory picker smoke passed: ${checks} behavior checks`)
