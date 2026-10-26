import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const fixtureUrl = new URL('../scripts/push-integration-fixture.mjs', import.meta.url)

type PublisherDeps = {
  mkdir: typeof mkdir
  writeFile: typeof writeFile
  rename: typeof rename
  rm: typeof rm
  dirname: typeof dirname
  randomUUID: typeof randomUUID
}
type PublisherHold = (candidate: string) => Promise<void> | void
type Publisher = (target: string, value: unknown, hold?: PublisherHold) => Promise<void>

const fixture: {
  atomicJsonPublisher?: (deps: PublisherDeps) => Publisher
  createPushIntegrationFixture: (options: { root: string }) => Promise<{ packageRoot: string, packageName: string }>
} = await import(fixtureUrl.href)

const makePublisher = (): Publisher => {
  if (typeof fixture.atomicJsonPublisher !== 'function') {
    throw new Error('atomic publication seam missing from scripts/push-integration-fixture.mjs')
  }
  return fixture.atomicJsonPublisher({ mkdir, writeFile, rename, rm, dirname, randomUUID })
}

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

// Windows ignores the writeFile mode and reports normal-file permission bits, so the
// 0600 privacy guarantee is only observable on POSIX (same guard as the file-logger tests).
const expectPrivateMode = async (path: string): Promise<void> => {
  if (process.platform !== 'win32') expect(await modeOf(path)).toBe(0o600)
}

describe('push integration fixture JSON publication', () => {
  it('exports one canonical atomic publisher reused by the generated Host writers', () => {
    expect(typeof fixture.atomicJsonPublisher).toBe('function')
  })

  it('keeps the previous complete document visible while a publication is held at the barrier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-fixture-barrier-'))
    try {
      const target = join(root, 'push-integration-fixture-result.json')
      const publish = makePublisher()
      await publish(target, { phase: 'first', ok: true })
      let releaseBarrier!: () => void
      let barrierReached!: (candidate: string) => void
      const gate = new Promise<void>(resolve => { releaseBarrier = resolve })
      const atBarrier = new Promise<string>(resolve => { barrierReached = resolve })
      const publishing = publish(target, { phase: 'second', ok: true }, async candidate => {
        barrierReached(candidate)
        await gate
      })
      const candidate = await atBarrier
      // Held after candidate creation, before publication: a strict reader polling the
      // target through the real filesystem still observes the previous complete document.
      expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ phase: 'first', ok: true })
      // The unpublished candidate is already complete, private and in the same directory.
      expect(JSON.parse(await readFile(candidate, 'utf8'))).toEqual({ phase: 'second', ok: true })
      expect(dirname(candidate)).toBe(root)
      await expectPrivateMode(candidate)
      releaseBarrier()
      await publishing
      expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ phase: 'second', ok: true })
      await expectPrivateMode(target)
      expect(await readdir(root)).toEqual([basename(target)])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('publishes the first complete document into a directory that does not exist yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-fixture-first-'))
    try {
      const home = join(root, 'home')
      const target = join(home, 'push-integration-fixture-settlement.json')
      await makePublisher()(target, { outcome: 'resolved' })
      expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ outcome: 'resolved' })
      await expectPrivateMode(target)
      expect(await readdir(home)).toEqual([basename(target)])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an unserializable value and leaves the previously published document intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-fixture-unserializable-'))
    try {
      const target = join(root, 'push-integration-fixture-result.json')
      const publish = makePublisher()
      await publish(target, { phase: 'first', ok: true })
      const circular: { self?: unknown } = {}
      circular.self = circular
      await expect(publish(target, circular)).rejects.toThrow(TypeError)
      expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ phase: 'first', ok: true })
      expect(await readdir(root)).toEqual([basename(target)])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('propagates a rename failure observed at the barrier without corrupting the published document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-fixture-rename-'))
    try {
      const target = join(root, 'push-integration-fixture-result.json')
      const publish = makePublisher()
      await publish(target, { phase: 'first', ok: true })
      const outcome = publish(target, { phase: 'second', ok: true }, async candidate => {
        await rm(candidate)
      })
      await expect(outcome).rejects.toMatchObject({ code: 'ENOENT' })
      expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ phase: 'first', ok: true })
      expect(await readdir(root)).toEqual([basename(target)])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes only the owned candidate after a settled rename failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-fixture-residue-'))
    try {
      const bystander = join(root, 'bystander.json')
      await writeFile(bystander, 'keep\n')
      const target = join(root, 'push-integration-fixture-result.json')
      await mkdir(target)
      const publication = makePublisher()(target, { phase: 'second', ok: true })
      // Every platform must observe an actual rename failure; POSIX reports EISDIR for
      // renaming onto a directory while Windows surfaces a different native error.
      await expect(publication).rejects.toMatchObject({ syscall: 'rename' })
      if (process.platform !== 'win32') await expect(publication).rejects.toMatchObject({ code: 'EISDIR' })
      expect(await readFile(bystander, 'utf8')).toBe('keep\n')
      expect((await stat(target)).isDirectory()).toBe(true)
      expect((await readdir(root)).sort()).toEqual(['bystander.json', basename(target)])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('generated Host publishes result and settlement through the corrected writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-fixture-host-'))
    const previousHome = process.env.DSH_HOME
    const home = join(root, 'home')
    process.env.DSH_HOME = home
    try {
      const built = await fixture.createPushIntegrationFixture({ root })
      const host: {
        writeResult: (value: unknown) => Promise<void>
        writeSettlement: (value: unknown) => Promise<void>
      } = await import(pathToFileURL(join(built.packageRoot, 'lib', 'index.mjs')).href)
      expect(typeof host.writeResult).toBe('function')
      expect(typeof host.writeSettlement).toBe('function')
      await host.writeResult({ phase: 'fixture-ready', ok: true })
      await host.writeSettlement({ outcome: 'resolved' })
      expect(JSON.parse(await readFile(join(home, 'push-integration-fixture-result.json'), 'utf8')))
        .toEqual({ phase: 'fixture-ready', ok: true })
      expect(JSON.parse(await readFile(join(home, 'push-integration-fixture-settlement.json'), 'utf8')))
        .toEqual({ outcome: 'resolved' })
      await expectPrivateMode(join(home, 'push-integration-fixture-result.json'))
      await expectPrivateMode(join(home, 'push-integration-fixture-settlement.json'))
      expect((await readdir(home)).sort()).toEqual(['push-integration-fixture-result.json', 'push-integration-fixture-settlement.json'])
      const source = await readFile(join(built.packageRoot, 'lib', 'index.mjs'), 'utf8')
      const canonicalSource = typeof fixture.atomicJsonPublisher === 'function'
        ? fixture.atomicJsonPublisher.toString()
        : '<canonical publisher missing>'
      expect(source).toContain(canonicalSource)
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(root, { recursive: true, force: true })
    }
  })
})
