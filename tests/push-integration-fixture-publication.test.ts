import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

const contractFixtureUrl = new URL('../scripts/push-contract-fixture.mjs', import.meta.url)
const contract: {
  createPushContractFixture: (options: { root: string, repository: string, tsdown: string }) => Promise<{ packageRoot: string, entry: string, packageName: string }>
} = await import(contractFixtureUrl.href)

// Tolerant while the shared publication module does not exist yet so the rest of this file keeps running.
const publicationUrl = new URL('../scripts/push-fixture-publication.mjs', import.meta.url)
const publication: { atomicJsonPublisher?: (deps: PublisherDeps) => Publisher } = await import(publicationUrl.href).catch(() => ({}) as Record<string, never>)

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

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

describe('push contract fixture JSON publication', () => {
  let contractBuild: Promise<{ packageRoot: string, entry: string, packageName: string, root: string }> | undefined
  const buildContract = (): typeof contractBuild => contractBuild ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-contract-publication-'))
    // Windows launches npm bin shims through their .CMD launcher; run() enables a shell there.
    const tsdownBin = join(repositoryRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsdown.CMD' : 'tsdown')
    const built = await contract.createPushContractFixture({ root, repository: repositoryRoot, tsdown: tsdownBin })
    return { ...built, root }
  })()

  it('exposes the identical canonical publisher through the shared publication module', () => {
    expect(typeof publication.atomicJsonPublisher).toBe('function')
    expect(fixture.atomicJsonPublisher).toBeTypeOf('function')
    expect(publication.atomicJsonPublisher!.toString()).toBe(fixture.atomicJsonPublisher!.toString())
  })

  it('generated contract Host exports and exercises thin atomic writeProgress/writeResult wrappers', async () => {
    const built = (await buildContract())!
    try {
      const host: {
        writeProgress?: (target: string, value: unknown, hold?: PublisherHold) => Promise<void>
        writeResult?: (target: string, value: unknown, hold?: PublisherHold) => Promise<void>
      } = await import(pathToFileURL(built.entry).href)
      expect(typeof host.writeProgress).toBe('function')
      expect(typeof host.writeResult).toBe('function')
      // First publication creates the directory and the complete document without residue.
      const home = join(built.root, 'fresh-home')
      const progressTarget = join(home, 'push-contract-progress.json')
      const resultTarget = join(home, 'push-contract-result.json')
      await host.writeProgress!(progressTarget, { stage: 'job-started', ok: true })
      await host.writeResult!(resultTarget, { stage: 'teardown-complete', ok: true })
      expect(JSON.parse(await readFile(progressTarget, 'utf8'))).toEqual({ stage: 'job-started', ok: true })
      expect(JSON.parse(await readFile(resultTarget, 'utf8'))).toEqual({ stage: 'teardown-complete', ok: true })
      if (process.platform !== 'win32') {
        expect(await modeOf(progressTarget)).toBe(0o600)
        expect(await modeOf(resultTarget)).toBe(0o600)
      }
      expect((await readdir(home)).sort()).toEqual(['push-contract-progress.json', 'push-contract-result.json'])
    } finally {
      await rm(built.root, { recursive: true, force: true })
      contractBuild = undefined
    }
  })

  it('keeps the previous complete contract document visible while a publication is held at the barrier', async () => {
    const built = (await buildContract())!
    try {
      const host: { writeProgress: (target: string, value: unknown, hold?: PublisherHold) => Promise<void> } = await import(pathToFileURL(built.entry).href)
      const home = join(built.root, 'barrier-home')
      const target = join(home, 'push-contract-progress.json')
      await host.writeProgress(target, { stage: 'first', ok: true })
      let releaseBarrier!: () => void
      let barrierReached!: (candidate: string) => void
      const gate = new Promise<void>(resolve => { releaseBarrier = resolve })
      const atBarrier = new Promise<string>(resolve => { barrierReached = resolve })
      const publishing = host.writeProgress(target, { stage: 'second', ok: true }, async candidate => {
        barrierReached(candidate)
        await gate
      })
      const candidate = await atBarrier
      // A strict reader polling the target only ever sees the previous complete document.
      expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ stage: 'first', ok: true })
      expect(JSON.parse(await readFile(candidate, 'utf8'))).toEqual({ stage: 'second', ok: true })
      expect(dirname(candidate)).toBe(home)
      releaseBarrier()
      await publishing
      expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ stage: 'second', ok: true })
      expect(await readdir(home)).toEqual([basename(target)])
    } finally {
      await rm(built.root, { recursive: true, force: true })
      contractBuild = undefined
    }
  })

  it('propagates a contract rename failure without corrupting evidence or leaving residue', async () => {
    const built = (await buildContract())!
    try {
      const host: { writeResult: (target: string, value: unknown, hold?: PublisherHold) => Promise<void> } = await import(pathToFileURL(built.entry).href)
      const home = join(built.root, 'failure-home')
      const bystander = join(home, 'bystander.json')
      await mkdir(home, { recursive: true })
      await writeFile(bystander, 'keep\n')
      const target = join(home, 'push-contract-result.json')
      await host.writeResult(target, { stage: 'first', ok: true })
      const outcome = host.writeResult(target, { stage: 'second', ok: true }, async candidate => {
        await rm(candidate)
      })
      await expect(outcome).rejects.toMatchObject({ code: 'ENOENT' })
      expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ stage: 'first', ok: true })
      expect(await readFile(bystander, 'utf8')).toBe('keep\n')
      expect((await readdir(home)).sort()).toEqual(['bystander.json', 'push-contract-result.json'])
      // tsdown re-prints the embedded factory, so the bundled artifact is verified by the
      // behavioral cases above plus the writer's structural markers.
      const source = await readFile(built.entry, 'utf8')
      expect(source).toContain('.candidate')
      // tsdown minifies the private mode literal (0o600 -> 384); both spellings prove the marker.
      expect(source).toMatch(/mode:\s*(384|0o600)/)
      expect(source).toMatch(/rename\(\s*candidate\s*,\s*target\s*\)/)
    } finally {
      await rm(built.root, { recursive: true, force: true })
      contractBuild = undefined
    }
  })
})
