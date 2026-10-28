import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveIrohSidecarAt, validateIrohNativeManifest } from '../src/iroh-manifest.js'

const roots: string[] = []
const prefix = 'dsh-mobile-iroh-manifest-test-'

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (resolve(root) === root && basename(root).startsWith(prefix) && resolve(root, '..') === resolve(tmpdir())) {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } else throw new Error('Refusing to remove an unowned fixture')
  }
})

async function fixtureCompanion(version = '0.1.0-alpha.1', tamper = false, manifestVersion = version): Promise<{ root: string; binary: Buffer }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  const binary = Buffer.alloc(128, 7)
  await mkdir(join(root, 'native'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-mobile-iroh', version }))
  const binaryPath = join(root, 'native', 'dsh-mobile-iroh-host-win32-x64.exe')
  await writeFile(binaryPath, tamper ? Buffer.alloc(128, 8) : binary)
  const manifest = {
    schemaVersion: 1,
    packageVersion: manifestVersion,
    artifacts: {
      'win32-x64': { file: 'dsh-mobile-iroh-host-win32-x64.exe', bytes: 128, sha256: createHash('sha256').update(binary).digest('hex') },
      'linux-x64': { file: 'dsh-mobile-iroh-host-linux-x64', bytes: 128, sha256: createHash('sha256').update(binary).digest('hex') },
    },
  }
  await writeFile(join(root, 'native', 'manifest.json'), JSON.stringify(manifest))
  const linuxPath = join(root, 'native', 'dsh-mobile-iroh-host-linux-x64')
  await writeFile(linuxPath, binary)
  if (process.platform !== 'win32') await chmod(linuxPath, 0o755)
  return { root, binary }
}

describe('iroh native manifest', () => {
  it('resolves the verified binary for a supported target', async () => {
    const { root } = await fixtureCompanion()
    const resolved = await resolveIrohSidecarAt(root, 'win32', 'x64')
    expect(resolved).toBe(join(await import('node:fs/promises').then(fs => fs.realpath(root)), 'native', 'dsh-mobile-iroh-host-win32-x64.exe'))
    expect(await readFile(resolved)).toHaveLength(128)
  })

  it('rejects unsupported platforms and tampered bytes', async () => {
    const { root } = await fixtureCompanion()
    await expect(resolveIrohSidecarAt(root, 'darwin', 'arm64')).rejects.toThrow('iroh_native_platform_unsupported')
    const tampered = await fixtureCompanion('0.1.0-alpha.1', true)
    await expect(resolveIrohSidecarAt(tampered.root, 'win32', 'x64')).rejects.toThrow('iroh_native_hash_mismatch')
  })

  it('rejects manifests bound to another package version', async () => {
    const { root } = await fixtureCompanion('9.9.9', false, '0.1.0-alpha.1')
    await expect(resolveIrohSidecarAt(root, 'win32', 'x64')).rejects.toThrow('iroh_native_manifest_invalid')
    expect(() => validateIrohNativeManifest({ schemaVersion: 1 }, '0.1.0-alpha.1')).toThrow('iroh_native_manifest_invalid')
  })

  it('rejects a missing companion directory', async () => {
    await expect(resolveIrohSidecarAt(join(tmpdir(), `${prefix}absent`), 'win32', 'x64')).rejects.toThrow('iroh_native_missing')
  })
})
