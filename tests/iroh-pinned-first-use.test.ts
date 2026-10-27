import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultResolveIdentity } from '../src/iroh.js'
import { IROH_COMPONENT_RELEASES } from '../src/iroh-component.js'
import { restrictPrivateDirectory } from '../src/private-file.js'

const executable = process.env.DSH_IROH_PINNED_FIRST_USE

describe.skipIf(process.platform !== 'win32' || !executable || !process.env.LOCALAPPDATA)('published pinned sidecar first use', () => {
  it('initializes fresh private state, retains identity, and refuses corrupt identity without replacing it', async () => {
    const bytes = await readFile(executable!)
    const artifact = IROH_COMPONENT_RELEASES['win32-x64']!
    expect(bytes.length).toBe(artifact.executableBytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.executableSha256)
    const base = resolve(process.env.LOCALAPPDATA!)
    const root = await mkdtemp(join(base, 'dsh-mobile-pinned-first-use-'))
    try {
      // Match IrohController.start(): mode 0700 alone is not a private Windows DACL.
      await restrictPrivateDirectory(root)
      const first = await defaultResolveIdentity(executable!, root)
      expect(first).toMatch(/^[0-9a-f]{64}$/u)
      expect(await defaultResolveIdentity(executable!, root)).toBe(first)
      const identityPath = join(root, 'identity.key')
      const identity = await readFile(identityPath)
      await writeFile(identityPath, 'controlled corrupt identity')
      await expect(defaultResolveIdentity(executable!, root)).rejects.toThrow('iroh_identity_invalid')
      expect((await readFile(identityPath)).toString()).toBe('controlled corrupt identity')
      await writeFile(identityPath, identity)
    } finally {
      if (resolve(root, '..') !== base) throw new Error('Unowned sidecar fixture')
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
