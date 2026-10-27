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
export function atomicJsonPublisher({ mkdir, writeFile, rename, rm, dirname, randomUUID }) {
  return async function publishJsonFile(target, value, hold) {
    const payload = JSON.stringify(value) + '\n'
    const directory = dirname(target)
    await mkdir(directory, { recursive: true })
    const candidate = target + '.' + randomUUID() + '.candidate'
    try {
      await writeFile(candidate, payload, { mode: 0o600 })
      if (hold !== undefined) await hold(candidate)
      await rename(candidate, target)
    } catch (error) {
      await rm(candidate, { force: true }).catch(() => {})
      throw error
    }
  }
}
