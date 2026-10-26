/**
 * Verify the published mobile shell bands against a real browser: a third-party
 * plugin that portals a menu into document.body must stay reachable while the
 * navigation drawer is open, and the shell's modal surfaces must stay above it.
 *
 * This is the regression for issue #288. It drives the built stylesheet from
 * `lib/mobile-layout.js` and a real Chromium layout engine, so it fails on the
 * reported defect (drawer above the portal) instead of on a source string.
 *
 * Scope: built stylesheet plus an owned DOM fixture. Not a full DSH runtime, a
 * real third-party plugin, or a physical device.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url))
  : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const client = await readFile(resolve(mobileRoot, 'lib/mobile-layout.js'), 'utf8')

/** A body portal menu shaped like the one reported in #288 (z-index 60). */
const PORTAL_LAYER = 60

const VIEWPORTS = Object.freeze({
  // Below the 900px breakpoint the drawer is a fixed overlay.
  portrait: { width: 390, height: 844 },
  // At and above it the drawer becomes a real grid column.
  landscape: { width: 1024, height: 768 },
})

function fixture({ drawerOpen, detailsOpen }) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<div id="root"><div data-slot="root"><div class="dshm-shell">
  <main class="dshm-main" data-pane="conversation"><div class="dshm-mainContent">
    <div data-slot="main"><div data-slot="main.conversation">
      <div id="conversation-content">Owned conversation content</div>
    </div></div>
  </div></main>
  <button class="dshm-scrim" data-open="${drawerOpen && !detailsOpen}" aria-label="Close panels" type="button"></button>
  <aside class="dshm-drawer" data-pane="sidebar" data-open="${drawerOpen}">
    <div id="sidebar-root"><button id="sidebar-action" type="button">Owned sidebar action</button></div>
  </aside>
  <aside class="dshm-details" data-open="${detailsOpen}">
    <div id="details-root">Owned details content</div>
  </aside>
  <div class="dshm-overlay"></div>
</div></div></div>
<!-- The third-party plugin's own portal: a sibling of the shell in body. -->
<div id="plugin-portal" role="menu" style="position:fixed;left:8px;bottom:8px;z-index:${PORTAL_LAYER};width:200px;height:120px;background:#fff">
  <button id="plugin-menu-item" type="button" style="width:100%;height:44px">Owned plugin menu item</button>
</div>
<!-- DSH's own settings overlay (900), which the shell must never cover. A plain
     div, not a <dialog>: a closed dialog is display:none and would not paint.
     Kept clear of the shell panels' geometry so the probe measures stacking. -->
<div id="stock-settings" role="dialog" aria-modal="true" style="z-index:900;position:fixed;right:20px;bottom:20px;width:120px;height:60px;background:#fff">
  <button id="stock-settings-action" type="button" style="width:100%;height:100%">Owned settings action</button>
</div>
</body></html>`
}

const browser = await chromium.launch()
const failures = []
let cases = 0

try {
  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    for (const drawerOpen of [true, false]) {
      for (const detailsOpen of [true, false]) {
        cases++
        const context = await browser.newContext({ viewport })
        try {
          const page = await context.newPage()
          const pageErrors = []
          page.on('pageerror', error => pageErrors.push(error.message))
          await page.setContent(fixture({ drawerOpen, detailsOpen }))
          await page.evaluate(() => {
            window.__ModuleLoader__ = { load: ({ id, factory }) => {
              if (id !== '@deepseek-ai/dsh-client-ui-layout') throw new Error('Unexpected built layout identity')
              window.layoutClient = factory(name => {
                if (name === 'react') return {}
                throw new Error(`Unexpected layout dependency: ${name}`)
              })
            } }
          })
          await page.addScriptTag({ content: client })
          await page.evaluate(() => {
            window.layoutClient.apply({
              effect: effect => { effect() },
              get: () => undefined,
              on: () => () => {},
              reflect: { provide: () => () => {} },
              slots: { entries: () => [], subscribe: () => () => {}, register: () => () => {}, provideRoot: () => () => {} },
              theme: { getTheme: () => ({ active: { colorScheme: 'light', tokens: {} } }) },
            })
          })
          await page.locator('#plugin-menu-item').waitFor({ state: 'visible', timeout: 10_000 })
          assert.deepEqual(pageErrors, [], `${label} drawer=${drawerOpen} details=${detailsOpen}: page errors`)

          const probe = await page.evaluate(({ portalLayer }) => {
            const drawer = document.querySelector('.dshm-drawer')
            const details = document.querySelector('.dshm-details')
            const overlay = document.querySelector('.dshm-overlay')
            const scrim = document.querySelector('.dshm-scrim')
            const portal = document.querySelector('#plugin-portal')
            const item = document.querySelector('#plugin-menu-item')
            const settings = document.querySelector('#stock-settings')
            const settingsAction = document.querySelector('#stock-settings-action')
            const zOf = node => {
              if (node === null) return null
              const parsed = Number.parseInt(getComputedStyle(node).zIndex, 10)
              return Number.isFinite(parsed) ? parsed : null
            }
            const hit = node => {
              const rect = node.getBoundingClientRect()
              const found = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
              return found === node || node.contains(found) ? 'self' : found === null ? 'none' : found.id || found.className || found.tagName
            }
            // The wide grid turns the drawer into a static grid item. z-index
            // still orders it against the root stacking context, so read the
            // computed value rather than assuming the property stopped applying.
            const drawerPosition = getComputedStyle(drawer).position
            return {
              drawerZ: zOf(drawer), drawerPosition,
              detailsZ: zOf(details), overlayZ: zOf(overlay), scrimZ: zOf(scrim),
              portalZ: zOf(portal) ?? portalLayer,
              portalHit: hit(portal), itemHit: hit(item),
              settingsHit: hit(settings), settingsActionHit: hit(settingsAction),
              settingsZ: zOf(settings),
            }
          }, { portalLayer: PORTAL_LAYER })

          const at = `${label} drawer=${drawerOpen} details=${detailsOpen}`
          // The plugin's own portal must be reachable whenever the shell has no
          // modal surface over it. A body-portal menu is how community plugins
          // draw menus, so covering it makes their controls dead (#288).
          if (!detailsOpen) {
            assert.equal(probe.portalHit, 'self', `${at}: the plugin portal is covered by ${probe.portalHit}`)
            assert.equal(probe.itemHit, 'self', `${at}: the plugin menu item is covered by ${probe.itemHit}`)
          } else {
            // The detail panel is a modal shell surface and may cover the portal,
            // but it must never be covered by the portal.
            assert.ok(probe.detailsZ > probe.portalZ,
              `${at}: detail panel ${probe.detailsZ} must stay above the plugin portal ${probe.portalZ}`)
          }
          // The navigation drawer is persistent chrome, never a modal layer.
          assert.ok(probe.drawerZ < probe.portalZ,
            `${at}: drawer ${probe.drawerZ} must stay below the plugin portal ${probe.portalZ}`)
          assert.ok(probe.scrimZ < probe.drawerZ,
            `${at}: scrim ${probe.scrimZ} must paint behind the drawer ${probe.drawerZ}`)
          assert.ok(probe.overlayZ > probe.portalZ,
            `${at}: shell overlay ${probe.overlayZ} must stay above the plugin portal ${probe.portalZ}`)
          // DSH's own settings dialog outranks every shell surface.
          assert.equal(probe.settingsActionHit, 'self', `${at}: DSH settings action covered by ${probe.settingsActionHit}`)
          assert.ok(probe.settingsZ > probe.overlayZ,
            `${at}: DSH settings ${probe.settingsZ} must outrank the shell overlay ${probe.overlayZ}`)
          assert.ok(probe.settingsZ > probe.detailsZ,
            `${at}: DSH settings ${probe.settingsZ} must outrank the detail panel ${probe.detailsZ}`)
          // The wide grid must keep ordering the drawer; a static grid item still
          // honours z-index, which is why the wide drawer can occlude a portal.
          if (label === 'landscape') assert.equal(probe.drawerPosition, 'static', `${at}: expected the wide grid drawer`)
          else assert.equal(probe.drawerPosition, 'fixed', `${at}: expected the narrow overlay drawer`)
        } finally { await context.close() }
      }
    }
  }
} catch (error) {
  failures.push(error)
} finally {
  await browser.close()
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure instanceof Error ? failure.message : failure)
  console.error(`Plugin portal layering failed after ${cases} owned browser cases.`)
  process.exit(1)
}
console.log(`Plugin portal layering passed ${cases} owned browser cases: a body portal menu stays clickable under the navigation drawer in portrait and landscape, shell modal surfaces stay above it, and DSH settings stay above the shell. This is not a full DSH runtime or physical-device acceptance.`)
