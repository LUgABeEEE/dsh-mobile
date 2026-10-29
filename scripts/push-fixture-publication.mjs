/**
 * Canonical atomic JSON publisher for fixture-polled evidence documents. It is the
 * one algorithm shared by tests and the generated Hosts: the function body references
 * only its injected bindings, so its exact source can be embedded into a generated
 * Host and exercised against the real filesystem. Publication writes the complete
 * payload to a unique same-directory private candidate (mode 0600) and renames it
 * over the target, so a strict poller only ever observes the previous complete
 * document or the new complete document, never a truncated write. `hold` is a
 * controlled barrier hook for focused publication tests; the Hosts never pass it.
 * Failed writes/renames preserve the previously published document, remove only the
 * exact owned candidate and propagate the original error.
 */
export function atomicJsonPublisher({ mkdir, writeFile, rename, rm, dirname, randomUUID, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  return async function publishJsonFile(target, value, hold) {
    const payload = JSON.stringify(value) + '\n'
    const directory = dirname(target)
    await mkdir(directory, { recursive: true })
    const candidate = target + '.' + randomUUID() + '.candidate'
    try {
      await writeFile(candidate, payload, { mode: 0o600 })
      if (hold !== undefined) await hold(candidate)
      // Windows cannot atomically replace a destination another handle holds open (a concurrent
      // strict reader or scanner): retry the SAME complete candidate briefly. Atomicity and the
      // strict reader's whole-document guarantee are unchanged; exhaustion re-raises the original error.
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(candidate, target)
          break
        } catch (error) {
          if ((error?.code === 'EPERM' || error?.code === 'EBUSY') && attempt < 8) { await delay(attempt + 1); continue }
          throw error
        }
      }
    } catch (error) {
      await rm(candidate, { force: true }).catch(() => {})
      throw error
    }
  }
}
