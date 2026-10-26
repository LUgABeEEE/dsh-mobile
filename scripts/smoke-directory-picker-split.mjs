/** Exercise the packed desktop/mobile picker split without submitting a model request. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createMobileProfile, launchDsh, removeTemporaryRoot, openPairing, pairMobilePage,
  dismissOnboarding, CLIENT_TIMEOUT_MS, sanitized, within } from './mobile-boot-fixture.mjs'
import { packBundle } from './packed-profile.mjs'
import { completeSmoke, recordSmokeFailure } from './negative-control.mjs'
import { browsePickerOwnsFlow } from './directory-picker-composition.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined ? repository : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const dshBin = process.env.DSH_BOOT_SMOKE_BIN ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const prefix = 'dsh-mobile-directory-picker-smoke-'
const root = await mkdtemp(join(tmpdir(), prefix))
const folders = join(root, 'directories')
const slowFolder = join(folders, 'held-response')
const heroWorkspace = join(root, 'outside-initial-tree', 'hero-workspace')
const sidebarWorkspace = join(root, 'outside-initial-tree', 'sidebar-workspace')
const listingPath = '/mobile-access/workspace-directories'
const selectors = {
  dialog: '.dshm-picker', path: '[data-dshm-picker-path]', load: '[data-dshm-picker-load]',
  cancel: '[data-dshm-picker-cancel]', up: '[data-dshm-picker-up]', confirm: '[data-dshm-picker-confirm]',
}
const previousNpmCache = process.env.npm_config_cache
process.env.npm_config_cache = join(root, 'npm-cache')
const failures = []
const pageErrors = []
const prompts = []
const requests = []
const requestFailures = new Set()
const held = new Set()
const routeTasks = new Set()
let nextListing, browser, desktop, phone, dsh, checks = 0

function deferred() {
  let resolve
  const promise = new Promise(fulfill => { resolve = fulfill })
  return { promise, resolve }
}

function pass(name) {
  checks++
  console.log(`PASS ${name}`)
}

function holdNextListing() {
  assert.equal(nextListing, undefined, 'A previous listing interception is still armed')
  const entry = { kind: 'hold', entered: deferred(), release: deferred(), done: deferred() }
  nextListing = entry
  held.add(entry)
  return entry
}

/** Read a real Gateway response first, then optionally hold only its browser delivery. */
async function interceptListing(route) {
  const entry = nextListing
  nextListing = undefined
  const url = new URL(route.request().url())
  // Default navigation stays inside our owned tree rather than reading the user's home.
  if (!url.searchParams.has('path')) url.searchParams.set('path', folders)
  const record = { path: url.searchParams.get('path'), method: route.request().method(), status: undefined }
  requests.push(record)
  let upstream
  try {
    if (entry?.kind === 'failure') {
      record.status = 503
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_listing_unavailable' }) })
      return
    }
    upstream = await route.fetch({ url: url.href, timeout: CLIENT_TIMEOUT_MS })
    record.status = upstream.status()
    if (entry?.kind === 'lose-create-response') {
      assert.equal(record.method, 'POST', 'The unknown-outcome control intercepted a read')
      assert.equal(record.status, 201, 'The unknown-outcome control never completed the real mkdir')
      await route.abort('connectionreset')
      return
    }
    if (entry?.kind === 'hold') {
      entry.request = route.request()
      entry.entered.resolve({ status: upstream.status(), body: await upstream.json() })
      await entry.release.promise
    }
    await route.fulfill({ response: upstream })
  } catch (error) {
    entry?.entered?.resolve({ failed: true })
    // Cancellation can reject delivery of the deliberately held response.
    // Other route failures remain failures, including resource cleanup errors.
    if (entry?.cancelExpected !== true || !requestFailures.has(route.request())) throw error
  } finally {
    try { await upstream?.dispose() } finally {
      if (entry?.kind === 'hold') {
        held.delete(entry)
        entry.done.resolve()
      }
    }
  }
}

async function directoryReady(expectedPath = folders) {
  const dialog = phone.locator(selectors.dialog)
  await dialog.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  await phone.waitForFunction(({ selectors, expectedPath }) => {
    const picker = document.querySelector(selectors.dialog)
    const input = picker?.querySelector(selectors.path)
    const confirm = picker?.querySelector(selectors.confirm)
    return input instanceof HTMLInputElement && input.value === expectedPath
      && confirm instanceof HTMLButtonElement && !confirm.disabled
  }, { selectors, expectedPath }, { timeout: CLIENT_TIMEOUT_MS })
  return dialog
}

async function openFlow(source, ready = true) {
  await phone.locator(selectors.dialog).waitFor({ state: 'hidden', timeout: CLIENT_TIMEOUT_MS })
  const drawer = phone.locator('[data-dsh-mobile-sidebar]')
  if (source === 'sidebar') {
    if (await drawer.getAttribute('data-open') !== 'true') await drawer.locator('[data-dsh-mobile-toggle]').click()
    await drawer.getByRole('button', { name: 'Add workspace', exact: true }).click()
  } else {
    if (await drawer.getAttribute('data-open') === 'true') await drawer.locator('[data-dsh-mobile-toggle]').click()
    await phone.getByRole('button', { name: 'Choose workspace', exact: true }).click()
    // Existing workspaces turn this chooser into a menu with an Add action.
    const add = phone.getByRole('menuitem', { name: /^Add workspace(?:…|\.\.\.)?$/u })
    await phone.locator(selectors.dialog).or(add).waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    if (await add.isVisible()) await add.click()
  }
  await phone.locator(selectors.dialog).waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  if (ready) await directoryReady()
}

async function cancelFlow() {
  const createCancel = phone.locator(`${selectors.dialog} [data-dshm-picker-create-cancel]`)
  if (await createCancel.isVisible()) await createCancel.click()
  const cancel = phone.locator(`${selectors.dialog} ${selectors.cancel}`)
  assert.equal(await cancel.isEnabled(), true, 'Picker cancellation must remain available')
  await cancel.click()
  await phone.locator(selectors.dialog).waitFor({ state: 'hidden', timeout: CLIENT_TIMEOUT_MS })
}

async function navigateTo(path) {
  await phone.locator(`${selectors.dialog} ${selectors.path}`).fill(path)
  await phone.locator(`${selectors.dialog} ${selectors.load}`).click()
  await directoryReady(path)
}

/** Observe the Portal, viewport coverage and native hit testing before dismissing its mask. */
async function checkOverlayAndDismiss(source) {
  const geometry = await phone.evaluate(selector => {
    const dialog = document.querySelector(selector)
    if (!(dialog instanceof HTMLElement)) throw new Error('Picker dialog missing')
    const bounds = dialog.getBoundingClientRect()
    const points = [[3, 3], [innerWidth - 3, 3], [3, innerHeight / 2], [innerWidth - 3, innerHeight / 2]]
    return {
      bounds: bounds.toJSON(), width: innerWidth, height: innerHeight,
      outsideSidebar: dialog.closest('[data-dsh-mobile-sidebar]') === null,
      covered: points.map(([x, y]) => dialog.contains(document.elementFromPoint(x, y))),
      backgroundClicks: window.__directoryPickerSmoke.backgroundClicks,
    }
  }, selectors.dialog)
  assert(geometry.outsideSidebar, `${source}: dialog did not escape the Sidebar containing block`)
  assert(geometry.bounds.left <= 1 && geometry.bounds.top <= 1
    && geometry.bounds.right >= geometry.width - 1 && geometry.bounds.bottom >= geometry.height - 1,
  `${source}: modal does not cover the viewport: ${JSON.stringify(geometry.bounds)}`)
  assert(geometry.covered.every(Boolean), `${source}: background owns part of the modal's hit area`)
  await phone.mouse.click(geometry.width - 3, 3)
  await phone.locator(selectors.dialog).waitFor({ state: 'hidden', timeout: CLIENT_TIMEOUT_MS })
  assert.equal(await phone.evaluate(() => window.__directoryPickerSmoke.backgroundClicks), geometry.backgroundClicks,
    `${source}: clicking the modal mask reached the background`)
  pass(`${source}: body-level dialog covers the viewport and its mask dismisses without clicking the background`)
}

function observeResponse(predicate) {
  // Observe rejection immediately even if the UI action throws before its caller awaits.
  return phone.waitForResponse(predicate, { timeout: CLIENT_TIMEOUT_MS }).then(
    response => ({ response }), error => ({ error }))
}

async function responseValue(observed) {
  const result = await observed
  if (result.error !== undefined) throw result.error
  return result.response
}

async function adoptWorkspace(source, path) {
  await openFlow(source)
  await navigateTo(path)
  const created = observeResponse(response => new URL(response.url()).pathname === '/api/workspace/create'
    && response.request().postDataJSON()?.payload?.args?.request?.path === path)
  const session = observeResponse(response => new URL(response.url()).pathname === '/api/session/create')
  await phone.locator(`${selectors.dialog} ${selectors.confirm}`).click()
  const createdResponse = await responseValue(created)
  assert.equal(createdResponse.status(), 200, `${source}: workspace adoption HTTP failure`)
  const createdBody = await createdResponse.json()
  assert.equal(createdBody.result?.ok, true, `${source}: workspace adoption rejected`)
  const workspaceId = createdBody.result.value.workspace.workspaceId
  const sessionResponse = await responseValue(session)
  assert.equal(sessionResponse.status(), 200, `${source}: real Session creation HTTP failure`)
  const sessionBody = await sessionResponse.json()
  assert.equal(sessionBody.result?.ok, true, `${source}: real Session creation rejected`)
  await phone.waitForFunction(id => document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') === id,
    sessionBody.result.value.sessionId, { timeout: CLIENT_TIMEOUT_MS })
  await phone.locator(selectors.dialog).waitFor({ state: 'hidden', timeout: CLIENT_TIMEOUT_MS })
  const drawer = phone.locator('[data-dsh-mobile-sidebar]')
  if (await drawer.getAttribute('data-open') !== 'true') await drawer.locator('[data-dsh-mobile-toggle]').click()
  await phone.locator(`[data-row-key="workspace:${workspaceId}"]`).waitFor({ state: 'attached', timeout: CLIENT_TIMEOUT_MS })
  pass(`${source}: absolute-path selection creates a real Workspace and opens its real Session without a prompt`)
}

try {
  await Promise.all([mkdir(slowFolder, { recursive: true }), mkdir(heroWorkspace, { recursive: true }), mkdir(sidebarWorkspace, { recursive: true })])
  const tarball = process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL === undefined ? await packBundle(mobileRoot, root)
    : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL)
  console.log(JSON.stringify({ artifactSha256: createHash('sha256').update(await readFile(tarball)).digest('hex'), copiedProfileFiles: true }))
  const home = await createMobileProfile(root, { tarball, dshBin })
  dsh = launchDsh(root, home, dshBin)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en-US', reducedMotion: 'reduce' })
  await context.route('**/api/session/prompt', async route => { prompts.push('session/prompt'); await route.abort('blockedbyclient') })
  desktop = await context.newPage()
  await desktop.goto(await dsh.ready(), { waitUntil: 'domcontentloaded' })
  const graph = await desktop.evaluate(() => globalThis.__DSH_BOOT__ ?? null)
  assert(graph !== null && Array.isArray(graph.entries), 'Stock DSH boot graph is missing')
  const ids = graph.entries.map(entry => entry.id)
  assert.deepEqual(ids.filter(id => String(id).startsWith('directory-picker-mobile')), [], 'Mobile still contributes a second Host picker row')
  const stockPickers = ids.filter(id => typeof id === 'string' && /^@deepseek-ai\/dsh-client-ui-directory-picker-(native|browse)$/u.test(id))
  assert.equal(stockPickers.length, 1, `Stock DSH must retain exactly one upstream picker surface: ${JSON.stringify(stockPickers)}`)
  assert.equal(await desktop.locator('style[data-plugin="dsh-mobile-directory-picker"]').count(), 0, 'Mobile picker leaked into stock DSH')
  pass('stock DSH retains one upstream picker without a competing Mobile Host or dialog')

  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    locale: 'en-US', reducedMotion: 'reduce' })
  await phoneContext.route('**/api/session/prompt', async route => { prompts.push('session/prompt'); await route.abort('blockedbyclient') })
  phone = await phoneContext.newPage()
  phone.setDefaultTimeout(CLIENT_TIMEOUT_MS)
  phone.on('pageerror', error => pageErrors.push(error.message))
  phone.on('requestfailed', request => { requestFailures.add(request) })
  await phone.route(`**${listingPath}*`, async route => {
    const task = interceptListing(route)
    routeTasks.add(task)
    try { await task } catch (error) { recordSmokeFailure(failures, error) } finally { routeTasks.delete(task) }
  })
  await pairMobilePage(phone, await openPairing(desktop, undefined, dsh.logs), dsh.logs)
  await dismissOnboarding(phone)
  await phone.evaluate(() => {
    const state = { backgroundClicks: 0 }
    const listener = event => {
      if (event.target instanceof Element && event.target.closest('.dshm-picker') === null) state.backgroundClicks++
    }
    document.addEventListener('click', listener, true)
    window.__directoryPickerSmoke = { get backgroundClicks() { return state.backgroundClicks },
      dispose: () => { document.removeEventListener('click', listener, true); delete window.__directoryPickerSmoke } }
  })

  // DSH decides the interaction at boot: a headless or remotely reachable host
  // resolves `browse`, whose own web picker then fills the directory-flow slots
  // and carries the official folder creation. The plugin owns the flow only when
  // DSH resolved the native interaction, which a remote browser cannot open.
  const browseHost = await browsePickerOwnsFlow(phone)
  if (browseHost) {
    assert.equal(await phone.locator('.dshm-picker').count(), 0, 'The plugin kept its own picker on a browse host')
    assert.equal(await phone.locator('style[data-plugin="dsh-mobile-directory-picker"]').count(), 0,
      'The plugin\'s own picker styles loaded on a browse host')
    const drawer = phone.locator('[data-dsh-mobile-sidebar]')
    if (await drawer.getAttribute('data-open') !== 'true') await drawer.locator('[data-dsh-mobile-toggle]').click()
    await drawer.getByRole('button', { name: 'Add workspace', exact: true }).click()
    const upstreamDialog = phone.locator('[role="dialog"], dialog').filter({ hasText: /workspace directory|工作区目录/i }).first()
    await upstreamDialog.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    assert.equal(await phone.locator('.dshm-picker').count(), 0, 'Opening the flow mounted the plugin picker instead')
    await phone.getByRole('button', { name: /new folder|新建文件夹/i }).first().waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    pass('a browse host keeps DSH\'s own picker, which offers the upstream folder creation')
  }

  if (!browseHost) {
    for (const source of ['hero', 'sidebar']) {
      await openFlow(source)
      assert(await phone.locator('.dshm-picker__row').count() > 0, `${source}: real owned folders did not render after readiness`)
      await cancelFlow()
      await openFlow(source)
      await phone.keyboard.press('Escape')
      await phone.locator(selectors.dialog).waitFor({ state: 'hidden', timeout: CLIENT_TIMEOUT_MS })
      await openFlow(source)
      const consumed = await phone.evaluate(() => {
        const event = new Event('dsh-mobile:native-back', { cancelable: true })
        window.dispatchEvent(event)
        return event.defaultPrevented
      })
      assert.equal(consumed, true, `${source}: native Back was not consumed by the dialog`)
      await phone.locator(selectors.dialog).waitFor({ state: 'hidden', timeout: CLIENT_TIMEOUT_MS })
      await openFlow(source)
      await checkOverlayAndDismiss(source)
      pass(`${source}: cancel, Escape and routed native Back close the real flow and allow reopening`)
    }

    for (const mode of [
      { name: 'small-light-en', width: 375, height: 812, scheme: 'light', lang: 'en' },
      { name: 'landscape-dark-zh', width: 844, height: 390, scheme: 'dark', lang: 'zh-CN' },
      { name: 'portrait-light-it', width: 390, height: 844, scheme: 'light', lang: 'it' },
    ]) {
      await phone.setViewportSize({ width: mode.width, height: mode.height })
      await phone.emulateMedia({ colorScheme: mode.scheme })
      await phone.evaluate(lang => { document.documentElement.lang = lang }, mode.lang)
      await openFlow('hero')
      const measured = await phone.locator(selectors.dialog).evaluate(dialog => {
        const controls = [...dialog.querySelectorAll('button,input')].filter(node => node.getClientRects().length > 0)
        return {
          lang: dialog.lang,
          panel: dialog.querySelector('.dshm-picker__panel').getBoundingClientRect().toJSON(),
          controls: controls.map(node => node.getBoundingClientRect().toJSON()),
          background: getComputedStyle(dialog.querySelector('.dshm-picker__panel')).backgroundColor,
          foreground: getComputedStyle(dialog).color,
          horizontalOverflow: dialog.scrollWidth > dialog.clientWidth,
        }
      })
      assert.equal(measured.lang, mode.lang === 'zh-CN' ? 'zh' : mode.lang)
      assert.equal(measured.horizontalOverflow, false, `${mode.name}: page-level horizontal overflow`)
      assert(measured.controls.every(box => box.width >= 44 && box.height >= 44
        && box.left >= 0 && box.top >= 0 && box.right <= mode.width + 1 && box.bottom <= mode.height + 1),
      `${mode.name}: clipped or undersized controls: ${JSON.stringify(measured.controls)}`)
      const evidence = process.env.DSH_DIRECTORY_PICKER_EVIDENCE_DIRECTORY
      if (evidence !== undefined) {
        await mkdir(resolve(evidence), { recursive: true })
        await phone.screenshot({ path: join(resolve(evidence), `${mode.name}.png`) })
      }
      await phone.locator(`${selectors.dialog} [data-dshm-picker-create]`).click()
      const hiddenParents = await phone.locator(selectors.dialog).evaluate(dialog => [...dialog.querySelectorAll(
        '.dshm-picker__toolbar,.dshm-picker__navigation,.dshm-picker__list,.dshm-picker__footer',
      )].map(node => ({ hidden: node.hidden, display: getComputedStyle(node).display })))
      assert.equal(hiddenParents.length, 4, 'Creation overlay is missing its parent surfaces')
      assert(hiddenParents.every(node => node.hidden && node.display === 'none'),
        `${mode.name}: main picker controls remain visible beneath creation: ${JSON.stringify(hiddenParents)}`)
      const createGeometry = await phone.locator(selectors.dialog).evaluate(dialog => [...dialog.querySelectorAll('button,input')]
        .filter(node => node.getClientRects().length > 0)
        .map(node => {
          const box = node.getBoundingClientRect()
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
          return { ...box.toJSON(), hit: hit === node || node.contains(hit) }
        }))
      assert(createGeometry.every(box => box.width >= 44 && box.height >= 44 && box.hit
        && box.left >= 0 && box.top >= 0 && box.right <= mode.width + 1 && box.bottom <= mode.height + 1),
      `${mode.name}: creation controls are clipped, covered or undersized: ${JSON.stringify(createGeometry)}`)
      await phone.keyboard.press('Escape')
      assert.equal(await phone.locator(selectors.dialog).isVisible(), true, `${mode.name}: Escape closed the parent instead of the creation layer`)
      assert.equal(await phone.locator(`${selectors.dialog} [data-dshm-picker-create-name]`).isVisible(), false)
      await cancelFlow()
      pass(`${mode.name}: localized dialog and touch controls fit the viewport (${measured.background}; ${measured.foreground})`)
    }
    await phone.setViewportSize({ width: 390, height: 844 })
    await phone.emulateMedia({ colorScheme: 'light' })
    await phone.evaluate(() => { document.documentElement.lang = 'en' })

    await openFlow('sidebar')
    await navigateTo(heroWorkspace)
    await phone.locator(`${selectors.dialog} ${selectors.up}`).click()
    await directoryReady(join(root, 'outside-initial-tree'))
    pass('absolute path navigation reaches outside the initial tree and Up follows its real parent')
    await phone.locator(`${selectors.dialog} ${selectors.path}`).fill('relative-workspace')
    const load = phone.locator(`${selectors.dialog} ${selectors.load}`)
    if (await load.isEnabled()) await load.click()
    await phone.waitForFunction(selectors => {
      const picker = document.querySelector(selectors.dialog)
      const input = picker?.querySelector(selectors.path)
      const confirm = picker?.querySelector(selectors.confirm)
      return confirm instanceof HTMLButtonElement && confirm.disabled
        && (input?.getAttribute('aria-invalid') === 'true' || picker?.querySelector('[role="alert"]') !== null)
    }, selectors, { timeout: CLIENT_TIMEOUT_MS })
    const invalid = await phone.evaluate(async listingPath => {
      const response = await fetch(`${listingPath}?path=relative-workspace`, { credentials: 'same-origin' })
      return { status: response.status, body: await response.json() }
    }, listingPath)
    assert.equal(invalid.status, 400, 'Gateway accepted a relative workspace path')
    assert.equal(invalid.body.error, 'bad_path', 'Gateway rejected the invalid path for an unrelated reason')
    await cancelFlow()
    pass('relative paths are visibly rejected by the UI and rejected by the authenticated Gateway')

    await openFlow('sidebar')
    const delayed = holdNextListing()
    await phone.locator(`${selectors.dialog} ${selectors.path}`).fill(slowFolder)
    await phone.locator(`${selectors.dialog} ${selectors.load}`).click()
    const delayedListing = await within(delayed.entered.promise, CLIENT_TIMEOUT_MS, () => 'Held listing never reached the real Gateway')
    assert.equal(delayedListing.status, 200)
    assert.equal(delayedListing.body.path, slowFolder)
    assert.equal(await phone.locator(`${selectors.dialog} ${selectors.confirm}`).isEnabled(), false, 'Commit stayed enabled while navigation was pending')
    delayed.cancelExpected = true
    const aborted = phone.waitForEvent('requestfailed', { predicate: request => request === delayed.request,
      timeout: CLIENT_TIMEOUT_MS }).then(() => ({ aborted: true }), error => ({ error }))
    await cancelFlow()
    await openFlow('hero')
    delayed.release.resolve()
    await within(delayed.done.promise, CLIENT_TIMEOUT_MS, () => 'Cancelled listing handler did not settle')
    const abortResult = await aborted
    if (abortResult.error !== undefined) throw abortResult.error
    assert.equal(abortResult.aborted, true, 'Cancelling the picker did not abort the browser listing request')
    await directoryReady()
    await cancelFlow()
    pass('loading can be cancelled; its aborted late response cannot replace a reopened flow')

    nextListing = { kind: 'failure' }
    await openFlow('sidebar', false)
    await phone.locator(`${selectors.dialog} [role="alert"]:not([data-dshm-picker-create-error])`).waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    assert.equal(await phone.locator(`${selectors.dialog} ${selectors.confirm}`).isEnabled(), false, 'Failed initial listing allowed a commit')
    await cancelFlow()
    await openFlow('sidebar')
    await cancelFlow()
    pass('a failed initial listing remains cancellable and the next open can load normally')

    // Folder creation on the remote entry: one explicit write, then the new
    // directory is listed on the host and can be opened as a workspace.
    await openFlow('hero')
    await navigateTo(folders)
    const createdFolder = join(folders, 'smoke-created')
    await phone.locator(`${selectors.dialog} [data-dshm-picker-create]`).click()
    const childBack = await phone.evaluate(() => {
      const event = new Event('dsh-mobile:native-back', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    })
    assert.equal(childBack, true, 'Native Back did not consume the child creation layer')
    assert.equal(await phone.locator(selectors.dialog).isVisible(), true, 'Native Back closed the parent directory dialog')
    assert.equal(await phone.locator(`${selectors.dialog} [data-dshm-picker-create-name]`).isVisible(), false)
    await phone.locator(`${selectors.dialog} [data-dshm-picker-create]`).click()
    await phone.locator(`${selectors.dialog} [data-dshm-picker-create-name]`).fill('smoke-created')
    await phone.locator(`${selectors.dialog} [data-dshm-picker-create-name]`).evaluate(input => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
    })
    assert.equal(requests.filter(request => request.method === 'POST').length, 0, 'An IME composition key started folder creation')
    const creating = holdNextListing()
    await phone.locator(`${selectors.dialog} [data-dshm-picker-create-confirm]`).click()
    const admitted = await within(creating.entered.promise, CLIENT_TIMEOUT_MS, () => 'Folder creation never reached the Gateway')
    assert.equal(admitted.status, 201)
    await phone.locator(`${selectors.dialog} [data-dshm-picker-create-name]`).evaluate(input => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.equal(requests.filter(request => request.method === 'POST').length, 1, 'Repeated Enter duplicated an in-flight creation')
    creating.release.resolve()
    await within(creating.done.promise, CLIENT_TIMEOUT_MS, () => 'Creation response delivery did not settle')
    await directoryReady(createdFolder)
    assert(existsSync(createdFolder), 'the created folder is missing on the host')
    assert(requests.some(request => request.method === 'POST'), 'the picker did not issue an explicit create request')
    pass('the remote entry creates a real host directory and lists it')
    // The same name must fail with a readable error instead of a second write.
    await navigateTo(folders)
    await phone.locator(`${selectors.dialog} [data-dshm-picker-create]`).click()
    await phone.locator(`${selectors.dialog} [data-dshm-picker-create-name]`).fill('smoke-created')
    await phone.locator(`${selectors.dialog} [data-dshm-picker-create-confirm]`).click()
    const duplicate = phone.locator(`${selectors.dialog} [data-dshm-picker-create-error]`).first()
    await duplicate.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    pass('a duplicate folder name is reported instead of writing again')
    await phone.locator(`${selectors.dialog} [data-dshm-picker-create-cancel]`).click()
    await phone.locator(`${selectors.dialog} [data-dshm-picker-create]`).click()
    await phone.locator(`${selectors.dialog} [data-dshm-picker-create-name]`).fill('smoke-unknown-created')
    nextListing = { kind: 'lose-create-response' }
    await phone.locator(`${selectors.dialog} [data-dshm-picker-create-confirm]`).click()
    const unknownMessage = 'The creation result is unknown'
    await phone.locator(`${selectors.dialog} [data-dshm-picker-create-error]`).filter({ hasText: unknownMessage })
      .waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    assert(existsSync(join(folders, 'smoke-unknown-created')), 'The lost response control did not leave the completed directory in place')
    await phone.locator(`${selectors.dialog} [data-dshm-picker-create-cancel]`).click()
    const unknownNotice = phone.locator(`${selectors.dialog} .dshm-picker__panel > .dshm-picker__status`).filter({ hasText: unknownMessage })
    await unknownNotice.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    await navigateTo(folders)
    await unknownNotice.waitFor({ state: 'hidden', timeout: CLIENT_TIMEOUT_MS })
    pass('a lost creation response stays unknown until a fresh directory read; stopping did not roll back mkdir')
    await cancelFlow()

    await adoptWorkspace('hero', heroWorkspace)
    await adoptWorkspace('sidebar', sidebarWorkspace)
    assert(requests.some(request => request.path === heroWorkspace && request.status === 200), 'Absolute path never reached the real Gateway')
    const writes = requests.filter(request => request.method === 'POST')
    assert.equal(writes.length, 3, `the create flow issued ${writes.length} writes instead of the three user-initiated ones`)
  }
  assert.deepEqual(pageErrors, [], `Page errors: ${sanitized(pageErrors.join(' | '))}`)
  assert.deepEqual(prompts, [], 'The smoke attempted a model request')
  pass('both directory flows complete without page errors or model requests')
} catch (error) {
  recordSmokeFailure(failures, error)
  if (phone !== undefined && !phone.isClosed()) {
    try {
      console.error(sanitized(JSON.stringify({ pageErrors, requests, visibleUi: (await phone.locator('body').innerText()).slice(0, 9000) })))
    } catch (diagnosticError) { recordSmokeFailure(failures, diagnosticError) }
  }
  if (dsh !== undefined) console.error(dsh.logs())
} finally {
  for (const entry of held) entry.release.resolve()
  let browserStopped = browser === undefined
  let dshStopped = dsh === undefined
  try {
    if (phone !== undefined) {
      await phone.unrouteAll({ behavior: 'wait' })
      await Promise.all(routeTasks)
      if (!phone.isClosed()) await phone.evaluate(() => window.__directoryPickerSmoke?.dispose())
    }
  } catch (error) { recordSmokeFailure(failures, error) }
  try { await browser?.close(); browserStopped = true } catch (error) { recordSmokeFailure(failures, error) }
  try {
    const stopped = await dsh?.close()
    dshStopped = true
    if (stopped?.forced === true) recordSmokeFailure(failures, new Error('Owned DSH needed a forced shutdown'))
  } catch (error) { recordSmokeFailure(failures, error) }
  if (previousNpmCache === undefined) delete process.env.npm_config_cache
  else process.env.npm_config_cache = previousNpmCache
  if (browserStopped && dshStopped) {
    try { await removeTemporaryRoot(root, prefix) } catch (error) { recordSmokeFailure(failures, error) }
  } else recordSmokeFailure(failures, new Error(`Retained owned fixture because process shutdown was not confirmed: ${root}`))
  if (prompts.length > 0) recordSmokeFailure(failures, new Error('A model request was attempted during acceptance or cleanup'))
}

completeSmoke(failures)
console.log(`directory picker smoke passed: ${checks} behavior checks`)
