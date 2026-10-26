import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const roots: string[] = []
const prefix = 'dsh-mobile-iroh-host-real-'

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (resolve(root) === root && basename(root).startsWith(prefix) && resolve(root, '..') === resolve(tmpdir())) {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } else throw new Error('Refusing to remove an unowned fixture')
  }
})

/**
 * Opt-in real sidecar check. Set DSH_IROH_SIDECAR to an installed
 * dsh-mobile-iroh-host executable. Without it the suite explicitly skips
 * instead of establishing any host evidence.
 *
 * A failure here with `host identity unavailable` on Windows almost always
 * means the private-storage ancestry check refused the machine: every
 * ancestor directory up to the drive root must be owned by the user, SYSTEM,
 * Administrators (or TrustedInstaller) and grant no write/replace rights to
 * any other SID. Sandbox-hardened drive roots that grant Authenticated Users
 * write access can never host a sidecar identity; use a normally permissioned
 * machine instead. See docs/IROH.md troubleshooting.
 */
describe.skipIf(!process.env.DSH_IROH_SIDECAR)('real iroh sidecar identity', () => {
  it('resolves a 64-hex endpoint identity in an owned private directory', async () => {
    const executable = process.env.DSH_IROH_SIDECAR!
    const dataDirectory = await mkdtemp(join(tmpdir(), prefix))
    roots.push(dataDirectory)
    const { stdout } = await run(executable, ['--lang', 'en', 'id', '--data-dir', dataDirectory], {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 64 * 1024,
    })
    expect(stdout.trim()).toMatch(/^[0-9a-f]{64}$/)
  })
})
