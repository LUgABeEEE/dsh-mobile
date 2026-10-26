/**
 * Stacking bands shared by the dedicated mobile shell and the stock mobile adapter.
 *
 * Two layer systems paint the same page. `src/mobile-layout.ts` replaces the
 * upstream layout module and renders the `.dshm-*` surfaces; `src/native-mobile.ts`
 * decorates the stock DOM. A narrow phone can hit both, so publishing one set of
 * numbers keeps the order identical instead of letting the two systems disagree.
 *
 * `.dshm-shell` is `position:relative` with `z-index:auto`, so it creates no
 * stacking context and every shell surface competes with community plugins'
 * `document.body` portals in the root context. That competition is the point of
 * this module: a plugin menu opened from the drawer must paint above the drawer.
 *
 * The navigation drawer is persistent chrome, not a modal, so it sits below the
 * plugin band. The detail panel and the overlay container are modal shell
 * surfaces and sit above it. DSH's own stacked layers stay above everything the
 * shell owns: settings overlays at 900/1000 and menus at 1100. Those values come
 * from the installed `@deepseek-ai/dsh-client-ui-*` bundles, so the shell must
 * stay below 900 and plugins must stay below 1000.
 *
 * A wide viewport does not change this. `.dshm-drawer` becomes `position:static`
 * in the wide grid, but z-index still applies to a Grid item, so a wide drawer
 * can occlude a lower body portal too. It only *looks* harmless because it
 * occupies a real column instead of floating over the content.
 */

/** Bands reserved for the mobile shell itself. Values are z-index numbers. */
export const MOBILE_SHELL_LAYERS = Object.freeze({
  /** Dimming layer behind the narrow overlay drawer and the detail panel. */
  scrim: 40,
  /** Persistent navigation drawer, both the narrow overlay and the wide column. */
  drawer: 50,
  /** The drawer's inner positioning root; orders nodes inside the drawer only. */
  drawerRoot: 51,
  /** Collapsed-rail toggle, which escapes the zero-width drawer. */
  drawerToggle: 54,
  /** The right detail panel: a shell-owned modal surface. */
  details: 80,
  /** Shell overlay container: transparent and click-through. */
  overlay: 90,
  /** Transient, non-interactive toast notices; above shell panels, below DSH settings. */
  toast: 330,
})

/**
 * Range a plugin-drawn overlay should use. The floor clears the persistent
 * navigation chrome (drawer, drawer root, collapsed-rail toggle) so a menu
 * opened from inside the drawer is never covered; the ceiling stays below the
 * shell's modal surfaces and below every DSH-owned layer, so a plugin overlay
 * cannot trap a settings dialog or a shell panel.
 *
 * The floor sits just above the drawer and matches the `z-index:60`
 * body-portal menu reported in issue 288.
 */
export const MOBILE_PLUGIN_OVERLAY_BAND = Object.freeze({ min: 60, max: 69 })

/** Lowest value that clears the drawer, for plugin guidance and tests. */
export const MOBILE_PLUGIN_OVERLAY_FLOOR = MOBILE_PLUGIN_OVERLAY_BAND.min

/** Lowest DSH-owned layer the shell must stay under; settings overlays use 900. */
export const DSH_SETTINGS_LAYER_FLOOR = 900

/**
 * The drawer is the only shell surface that must lose to third-party portals,
 * so keep its band below the plugin floor and assert the relation in code
 * rather than in a comment. A later band change that inverted this order would
 * silently reintroduce the occlusion this module exists to prevent.
 */
const ordered = [
  ['scrim', MOBILE_SHELL_LAYERS.scrim],
  ['drawer', MOBILE_SHELL_LAYERS.drawer],
  ['drawer root', MOBILE_SHELL_LAYERS.drawerRoot],
  ['collapsed-rail toggle', MOBILE_SHELL_LAYERS.drawerToggle],
  ['detail panel', MOBILE_SHELL_LAYERS.details],
  ['overlay container', MOBILE_SHELL_LAYERS.overlay],
  ['toast', MOBILE_SHELL_LAYERS.toast],
] as const

for (const [name, value] of ordered) {
  if (!(value < DSH_SETTINGS_LAYER_FLOOR)) {
    throw new Error(`The mobile ${name} band must stay below DSH's settings layers`)
  }
}
// Only the surfaces that are not modal chrome must lose to a plugin portal.
for (const [name, value] of ordered.slice(0, 4)) {
  if (!(value < MOBILE_PLUGIN_OVERLAY_FLOOR)) {
    throw new Error(`The mobile ${name} band must stay below the plugin overlay band`)
  }
}
// The modal shell surfaces must beat a plugin portal opened from inside them.
for (const [name, value] of ordered.slice(4, 6)) {
  if (!(value > MOBILE_PLUGIN_OVERLAY_BAND.max)) {
    throw new Error(`The mobile ${name} band must stay above the plugin overlay band`)
  }
}if (!(MOBILE_SHELL_LAYERS.scrim < MOBILE_SHELL_LAYERS.drawer)) {
  throw new Error('The scrim must paint behind the drawer')
}
if (!(MOBILE_SHELL_LAYERS.drawer < MOBILE_SHELL_LAYERS.drawerRoot)) {
  throw new Error('The drawer root must paint above the drawer frame')
}
if (!(MOBILE_SHELL_LAYERS.drawerToggle > MOBILE_SHELL_LAYERS.drawer)) {
  throw new Error('The collapsed-rail toggle must clear the drawer it escapes')
}
if (!(MOBILE_SHELL_LAYERS.details < MOBILE_SHELL_LAYERS.overlay)) {
  throw new Error('The detail panel must paint behind the shell overlay container')
}
if (!(MOBILE_PLUGIN_OVERLAY_BAND.max < DSH_SETTINGS_LAYER_FLOOR)) {
  throw new Error('The plugin overlay band must stay below DSH settings')
}
