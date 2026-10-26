import type { ReactElement } from 'react'

/**
 * Public props consumed from the shell-provided `@deepseek-ai/dsh-client-ui-primitives` Switch atom.
 *
 * The component renders `button[type=button][role=switch][aria-checked][aria-label]` with a thumb
 * span and calls `onChange(!checked)` on activation; its track/thumb paint, dimensions and hashed
 * classes are owned by the DSH web shell and are never re-created or overridden here. The shape is
 * declared locally because the primitives package exists only as a shell-side module seed (a
 * `dsh-web-frontend` devDependency bundled into the Vite shell), so no local import can resolve.
 */
export interface MobilePushSwitchProps {
  readonly checked: boolean
  readonly onChange: (next: boolean) => void
  readonly label: string
  readonly disabled?: boolean
  readonly title?: string
  readonly className?: string
}

/** Render signature of the public Switch component the owning browser integration can inject. */
export type MobilePushSwitchComponent = (props: MobilePushSwitchProps) => ReactElement

/**
 * Lazily require the public Switch from the DSH module loader at category render time.
 *
 * The plugin client bundle is a `window.__ModuleLoader__.load` factory whose `require` parameter
 * resolves seeded shell modules synchronously (`rc.2` and `rc.3` both seed the primitives namespace
 * unconditionally). Requiring lazily — inside the render that needs it, never at module scope —
 * keeps every Node test and provider-free fixture that mounts the settings row but not the push
 * toggles free of any browser-only module dependency. Outside a DSH shell there is no loader
 * `require`, so the categories are withdrawn instead of rendering a broken stand-in; native
 * rendering itself is verified by the strict packed smoke against the real mounted shell.
 */
export function requirePublicMobilePushSwitch(): MobilePushSwitchComponent | undefined {
  if (typeof window === 'undefined' || typeof require !== 'function') return undefined
  try {
    // The literal specifier is deliberate: the browser bundle keeps it an external
    // `require("@deepseek-ai/dsh-client-ui-primitives")` inside the module-loader
    // factory (declared in tsdown.config.ts), keeping the public peer boundary
    // auditable by scripts/check-client-bundle.mjs instead of a dynamic lookup.
    return (require('@deepseek-ai/dsh-client-ui-primitives') as { readonly Switch?: MobilePushSwitchComponent }).Switch
  } catch {
    return undefined
  }
}
