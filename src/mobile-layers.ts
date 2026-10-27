/**
 * Stacking bands shared by the dedicated mobile shell and the stock mobile adapter.
 *
 * Two layer systems paint the same page. `src/mobile-layout.ts` replaces the
 * upstream layout module and renders the `.dshm-*` surfaces; `src/native-mobile.ts`
 * decorates the stock DOM. A narrow phone can hit both, so publishing one set of
 * numbers keeps the order identical instead of letting the two systems disagree.
 *
 * The shell is an isolated stacking context (`isolation:isolate`). That is what
 * actually decides issue #288: a menu a third-party plugin portals into
 * `document.body` paints above the *entire* shell regardless of its z-index,
 * because the shell no longer competes with it in the root context. Measuring
 * both candidate fixes showed the difference — lowering the drawer only helped a
 * portal that happened to pick a value above it, and still failed for a portal at
 * 10 or 45, while isolation held for every non-negative value.
 *
 * Inside the isolated shell these numbers still order the shell's own surfaces,
 * so they must stay internally consistent. They are not a contract plugins need
 * to read: a plugin's portal is either in `document.body` (above the shell) or
 * inside a panel (ordered by that panel). That is the guidance the adaptation
 * guide gives, and it is why this table is not exported as a plugin band.
 *
 * A wide viewport does not change the isolation. `.dshm-drawer` becomes
 * `position:static` in the wide grid, but z-index still applies to a Grid item,
 * so the internal order has to hold there too.
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
  /** Transient, non-interactive toast notices; above shell panels. */
  toast: 330,
})

/** Lowest DSH-owned layer the shell must stay under; settings overlays use 900. */
export const DSH_SETTINGS_LAYER_FLOOR = 900

/**
 * The shell's own surfaces must stay ordered among themselves, and below the
 * DSH layers that render inside the shell. Asserting it at module load means a
 * later band edit cannot silently reorder the drawer over a modal panel.
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
if (!(MOBILE_SHELL_LAYERS.scrim < MOBILE_SHELL_LAYERS.drawer)) {
  throw new Error('The scrim must paint behind the drawer')
}
if (!(MOBILE_SHELL_LAYERS.drawer < MOBILE_SHELL_LAYERS.drawerRoot)) {
  throw new Error('The drawer root must paint above the drawer frame')
}
if (!(MOBILE_SHELL_LAYERS.drawerToggle > MOBILE_SHELL_LAYERS.drawer)) {
  throw new Error('The collapsed-rail toggle must clear the drawer it escapes')
}
if (!(MOBILE_SHELL_LAYERS.drawer < MOBILE_SHELL_LAYERS.details)) {
  throw new Error('The detail panel must paint above the navigation drawer')
}
if (!(MOBILE_SHELL_LAYERS.details < MOBILE_SHELL_LAYERS.overlay)) {
  throw new Error('The detail panel must paint behind the shell overlay container')
}

/**
 * Emit the band table as CSS custom properties.
 *
 * Both stylesheets are single literals and the bundler keeps a `${...}` inside
 * them verbatim, so the numbers travel as variables instead. One owner means
 * the CSS and the ordering assertions above cannot disagree.
 * @returns a declaration list for a `:root` rule.
 */
export function layerCustomProperties(): string {
  const name = (key: string): string => key.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)
  return Object.entries(MOBILE_SHELL_LAYERS)
    .map(([key, value]) => `--dshm-layer-${name(key)}:${value}`)
    .join(';')
}
