import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultResolveIdentity } from '../src/iroh.js'
import { IrohComponentManager, IROH_COMPONENT_RELEASES } from '../src/iroh-component.js'
import { ensureIrohDirectory } from '../src/iroh-files.js'
import { restrictPrivateDirectory } from '../src/private-file.js'

const executable = process.env.DSH_IROH_PINNED_FIRST_USE

describe.skipIf(process.platform !== 'win32' || !executable || !process.env.USERPROFILE)('published pinned sidecar first use', () => {
  it('initializes fresh private state, retains identity, and refuses corrupt identity without replacing it', async () => {
    const bytes = await readFile(executable!)
    const artifact = IROH_COMPONENT_RELEASES['win32-x64']!
    expect(bytes.length).toBe(artifact.executableBytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.executableSha256)
    // The normal DSH state and native lease fixtures live under USERPROFILE;
    // arbitrary AppData ancestors may grant other principals write access.
    const base = resolve(process.env.USERPROFILE!)
    const root = await mkdtemp(join(base, 'dsh-mobile-pinned-first-use-'))
    try {
      // Match IrohController.start(): mode 0700 alone is not a private Windows DACL.
      await restrictPrivateDirectory(root)
      const component = new IrohComponentManager({ stateDirectory: root, fetchArtifact: async () => bytes })
      await component.initialize()
      await component.install()
      const managedExecutable = component.executable!
      const dataDirectory = join(root, 'remote', 'iroh', 'sidecar')
      await ensureIrohDirectory(root, dataDirectory)
      await restrictPrivateDirectory(dataDirectory)
      const prepare = async (stage: string): Promise<string> => {
        let exit: number | null | undefined
        let nativeFailure = false
        try {
          return await defaultResolveIdentity(managedExecutable, dataDirectory, { onSpawn: child => {
            child.stderr?.on('data', (chunk: Buffer) => { nativeFailure ||= chunk.toString().includes('host TLS preparation failed') })
            child.once('close', code => { exit = code })
          } })
        } catch (error) {
          throw new Error(`${stage}: ${error instanceof Error ? error.message : 'probe failed'}; exit=${exit}; nativeTlsFailure=${nativeFailure}`, { cause: error })
        }
      }
      const first = await prepare('fresh')
      expect(first).toMatch(/^[0-9a-f]{64}$/u)
      expect(await prepare('reuse')).toBe(first)
      const identityPath = join(dataDirectory, 'identity.key')
      const identity = await readFile(identityPath)
      await writeFile(identityPath, 'controlled corrupt identity')
      await expect(prepare('corrupt')).rejects.toThrow('iroh_identity_invalid')
      expect((await readFile(identityPath)).toString()).toBe('controlled corrupt identity')
      await writeFile(identityPath, identity)
    } finally {
      if (resolve(root, '..') !== base) throw new Error('Unowned sidecar fixture')
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
