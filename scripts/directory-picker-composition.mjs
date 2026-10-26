/**
 * Which directory-flow owner DSH resolved at boot.
 *
 * DSH composes `directory-picker` as `dsh-host-directory-picker-auto`, which
 * mounts the Host backend and the Client face together and picks `browse`
 * whenever the host is reachable from a remote authority or has no display.
 * Its client face then fills the same directory-flow slots a plugin-owned
 * picker would use, and carries the official styling and folder creation.
 *
 * When DSH resolved `native` instead, no web face is
 * available for a remote browser to open, so the plugin keeps its own
 * in-page flow as the fallback.
 *
 * Fixtures must follow the host's decision rather than assume one, because a
 * Linux CI runner is a browse host while a developer's Windows or macOS
 * machine is a native one.
 */

/** Whether the page's boot manifest includes DSH's browse directory picker. */
export async function browsePickerOwnsFlow(page) {
  return page.evaluate(() => {
    const entries = globalThis.__DSH_BOOT__?.entries
    return Array.isArray(entries) && entries.some(entry => entry?.id === '@deepseek-ai/dsh-client-ui-directory-picker-browse')
  })
}
