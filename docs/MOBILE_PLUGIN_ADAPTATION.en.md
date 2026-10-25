# Mobile plugin adaptation guide

[中文](MOBILE_PLUGIN_ADAPTATION.md) · [Documentation index](README.md)

Whether a plugin is usable on a small screen is the plugin's own responsibility: the mobile layer owns layout and connectivity and does not rearrange third-party panels. This guide is the shortest path to **desktop unchanged, usable on a phone** — no interaction redesign, and no Android device needed to start.

## How the mobile page hosts a plugin

| Fact | What it means for a plugin |
| --- | --- |
| A panel registered in the `main` slot takes the full phone width, above a 56px "back to conversation" bar | The panel has 56px less height than on desktop; do not assume the whole screen |
| The sidebar is a 340px drawer, not a persistent column | Sidebar entries must let their text and buttons shrink |
| The layout provides `[data-pane="conversation"]`, `[data-pane="sidebar"]` and `.dshm-shell` | Prefer those markers over desktop CSS-module class names |
| The shell forces `font-size: max(16px, …)` on `input`/`textarea` | Inputs are taller; design form density around that |
| The shell only fixes touch targets inside public slots | Your own buttons, inline actions and close controls must reach 44px themselves |

## Switch on the panel's measured width

Measure once at the panel root, then follow later size changes:

```js
const MOBILE_MAX_WIDTH = 600
const [panelWidth, setPanelWidth] = useState(null)
const isMobile = panelWidth !== null && panelWidth <= MOBILE_MAX_WIDTH

useEffect(() => {
  const element = rootRef.current
  if (element === null) return undefined
  const measure = () => setPanelWidth(element.getBoundingClientRect().width)
  measure()
  window.addEventListener('resize', measure)
  const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(measure) : null
  observer?.observe(element)
  return () => {
    window.removeEventListener('resize', measure)
    observer?.disconnect()
  }
}, [])
```

```js
h('div', { className: 'panel', 'data-mobile': isMobile ? '1' : '0' }, …)
```

Do not decide from the user agent, and do not replace this with `@media (max-width: 600px)`:

- A panel's width is not the viewport width. The same panel can be 400px wide inside a desktop sidebar, and it needs the mobile rules there too.
- When a desktop window is dragged narrow, users want it usable, not a layout pretending it is wide.
- A measured width can be supplied by a static preview harness, which is what makes the adaptation testable.

600px is a suggestion, not a rule. Existing wide-screen breakpoints (for example a second column at 960px) still apply: `data-mobile` governs touch and density, `data-wide` governs columns.

## Checklist

### Touch targets of at least 44px

Desktop-sized 28–32px buttons are hard to hit. Give buttons, inputs and selects `min-height: 44px`, and icon buttons `min-width: 44px`. Keep a round checkbox visually 24px and grow only its hit area:

```css
[data-mobile="1"] .check { position: relative; }
[data-mobile="1"] .check::after { content: ''; position: absolute; inset: -10px; }
```

Do not enlarge the whole card: the hit area can grow without the visual size.

### Make horizontal chips and tabs scroll

Filter strips and group tabs are the first thing a phone clips, and the clipped entries are often the ones that only appear when they have data.

```css
[data-mobile="1"] .chips {
  flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden;
  padding: 0; scrollbar-width: none; -webkit-overflow-scrolling: touch;
}
[data-mobile="1"] .chips::-webkit-scrollbar { display: none; }
[data-mobile="1"] .chip { flex: 0 0 auto; min-height: 44px; }
```

Hide separators that only exist to divide the row: once it scrolls, they wrap onto a line of their own.

### Collapse inline text actions to icons

Side-by-side text buttons eat the title width and push the body onto two or three lines. Wrap the label, hide it on a phone, keep an accessible name, and keep the text entry points in menus and details:

```js
h('button', { className: 'btn', 'aria-label': label }, h(Icon, { name: 'play' }), h('span', { className: 'btn-label' }, label))
```

```css
[data-mobile="1"] .btn-label { display: none; }
[data-mobile="1"] .btn { min-width: 44px; padding: 0; justify-content: center; }
```

The words may disappear; the action must not.

### Hide desktop-only affordances

`/` to focus search, `kbd` hints and shortcut tables are noise without a keyboard. Hide them on a phone and keep the explanations in help.

### Bottom safe area and scroll boundaries

When the panel is its own scroll container, the shell's top inset does not reach the end of the list, and momentum scrolling can drag the page behind it.

```css
[data-mobile="1"] .inner { padding-bottom: max(28px, calc(14px + env(safe-area-inset-bottom))); }
[data-mobile="1"] .list { overscroll-behavior: contain; }
```

### Follow the shell's text size

The mobile page exposes its text-size setting as `--dsh-content-font-size` (16px by default). Hard-coding 13px means only the inputs grow when a reader enlarges the text:

```css
[data-mobile="1"] .panel { font-size: var(--dsh-content-font-size, 15px); }
[data-mobile="1"] .meta { font-size: max(12px, 0.8em); }
```

Desktop does not define the variable, so the fallback applies and the desktop is unaffected.

### Dialogs and forms

A fixed 360px settings card is clipped on both sides at 390px, and two-column forms squeeze into one. On a phone, anchor the surface to both edges, collapse form rows, and give multi-line inputs at least 96px:

```css
[data-mobile="1"] .settings { width: auto; max-width: none; }
[data-mobile="1"] .form-row { grid-template-columns: minmax(0, 1fr); }
[data-mobile="1"] textarea { min-height: 96px; }
```

### Compress the header, not the targets

A phone's first screen belongs to content. Drop the title to about 1.2em, clamp the subtitle to one line and tighten card spacing — without tightening the touch targets with it.

## Verification

Adaptations rot where only a device can see the difference. Most regressions can still be caught automatically.

### Give the static preview harness a width

If the plugin renders static HTML previews for baseline screenshots, the panel's width measurement never runs there (there is no layout engine), so every preview lands on the wide branch. Make the harness answer the measurement:

```js
const viewport = { width: 0, height: 0 }
for (const arg of process.argv.slice(2)) {
  const match = /^--(width|height)=(\d+)$/.exec(arg)
  if (match) viewport[match[1]] = Number(match[2])
}
// While rendering, give every ref a layout stub that answers with the target width
if (typeof type === 'string' && viewport.width > 0 && props?.ref) {
  props.ref.current = {
    getBoundingClientRect: () => ({ width: viewport.width, height: viewport.height, top: 0, left: 0, right: viewport.width, bottom: viewport.height }),
    contains: () => false, focus() {}, blur() {}, scrollIntoView() {},
    querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
  }
}
```

With this, `--width=390` renders the actual narrow branch instead of shrinking the desktop page.

### Assert the structure in the render check

- The narrow render took the mobile branch;
- The CSS still contains the 44px, `safe-area-inset-bottom` and `--dsh-content-font-size` rules;
- Hidden hints and collapsed labels still have accessible names;
- The desktop render is pixel-identical to its baseline.

### Screenshot baselines

Take 390×844 for at least list, detail and settings; re-shoot the desktop set after the change and compare it with the previous images.

### What static checks cannot prove

The visible area after the soft keyboard opens, real `env(safe-area-inset-*)` values, momentum scrolling and bounce, and re-wrapping after a system font-size increase all wait for a device.

## Reference implementation

The 0.19.0 mobile layout of `dsh-global-todo` followed this guide (that release is not public yet):

| Item | Approach |
| --- | --- |
| Signal | Panel measured width ≤600px → `data-mobile="1"` |
| Touch | 44px controls, inputs and filters; 24px visual checkbox with a pseudo-element hit area |
| Density | Inline hand-off collapses to its icon (label kept as `aria-label`); creator attribution moves to the detail; meta returns to two or three entries per line |
| Scrolling | Filter chips scroll on one line with separators hidden; toolbar becomes one column with full-width search |
| Desktop hints | `/` badge and `kbd` hidden |
| Safe area | `max(28px, 14px + env(safe-area-inset-bottom))`; list uses `overscroll-behavior: contain` |
| Type | Body text follows `--dsh-content-font-size` (15px fallback) |
| Dialogs | Settings sheet anchored to both edges, measured top kept, no fixed 360px card |
| Result | Card height at 390×844 drops from roughly 250px to 150px; every target ≥44px; desktop screenshots pixel-identical |
| Regression | Preview harness `--width=390`; render checks assert the mobile branch and the key rules; 390×844 baselines generated |

The change used three stable hooks: the mobile switch, a wrapper class for one text label, and class names for facts that must be hidden. There is no second render path — the detail still has exactly one implementation.

## Templates for plugin authors

### Issue

```markdown
## Plugin on a small screen
- Plugin and version:
- Panel location (sidebar entry / main panel / other):
- Phone and App (or browser) version:
- Symptom (screenshot or recording):
- Expectation (only "desktop unchanged + usable on a phone"):

## Acceptance
- [ ] Touch targets ≥44px
- [ ] Horizontal chips scroll; no clipped tail
- [ ] Inline text actions collapse to icons with accessible names
- [ ] Desktop-only hints hidden
- [ ] Bottom safe area and overscroll handled
- [ ] Type follows --dsh-content-font-size
- [ ] Dialogs and forms fit at 390px
- [ ] Desktop screenshots unchanged
```

### PR

- [ ] One render/detail implementation; no second tree for mobile;
- [ ] The breakpoint uses measured width, not a user agent or the viewport;
- [ ] Mobile rules sit behind one switch; desktop selectors untouched;
- [ ] The static preview accepts a width, and the narrow branch really runs;
- [ ] The render check gained structural assertions; desktop baselines compared;
- [ ] Anything unverified on a device is stated in the description (keyboard, safe area, momentum scrolling).

## Boundaries and anti-patterns

- Do not inject third-party CSS from the mobile layer by class name: it breaks when a class changes and can hit the desktop as well.
- Do not fork the component tree per platform: two implementations diverge at the first field change.
- Do not promise that every plugin can be adapted: background services and plugins that depend on native windows are out of scope.
- Do not treat "it scrolls" as acceptance: check the first exception, the actual box sizes and the focus order.
