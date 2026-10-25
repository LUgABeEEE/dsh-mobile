import type { Dir } from 'node:fs'
import * as fs from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listComputerImages, listWorkspaceDirectories, readComputerImage, resolveComputerImagePath, resolveWorkspaceDirectoryPath } from '../src/computer-images.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, opendir: vi.fn(actual.opendir), stat: vi.fn(actual.stat) }
})

const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const roots: string[] = []
const { mkdir, symlink, writeFile } = fs
async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
beforeEach(() => {
  vi.mocked(fs.opendir).mockReset().mockImplementation(native.opendir)
  vi.mocked(fs.stat).mockReset().mockImplementation(native.stat)
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0).reverse()) await native.rm(root, { recursive: true, force: true })
})

describe('authenticated computer image browser', () => {
  it('lists directories and supported images while omitting other files', async () => {
    const root = await temporaryRoot('dsh-mobile-images-')
    await Promise.all([
      mkdir(join(root, 'album')),
      writeFile(join(root, 'photo.PNG'), 'png'),
      writeFile(join(root, 'notes.txt'), 'text'),
    ])
    await expect(listComputerImages(root)).resolves.toMatchObject({
      path: root,
      entries: [
        { kind: 'directory', name: 'album' },
        { kind: 'image', name: 'photo.PNG' },
      ],
      truncated: false,
    })
  })

  it('reads supported regular images and rejects relative or non-image paths', async () => {
    const root = await temporaryRoot('dsh-mobile-image-')
    const image = join(root, 'photo.webp')
    await writeFile(image, 'webp')
    await expect(readComputerImage(image)).resolves.toMatchObject({ contentType: 'image/webp', name: 'photo.webp' })
    expect(() => resolveComputerImagePath('relative.png')).toThrow(/bad_path/)
    await expect(readComputerImage(join(root, 'notes.txt'))).rejects.toThrow(/unsupported_file_type/)
  })

  it('stops directory and file reads when device authorization is revoked', async () => {
    const root = await temporaryRoot('dsh-mobile-image-abort-')
    const image = join(root, 'photo.png')
    await writeFile(image, 'png')
    const controller = new AbortController()
    controller.abort(new Error('device_revoked'))
    await expect(listComputerImages(root, controller.signal)).rejects.toThrow('device_revoked')
    await expect(readComputerImage(image, controller.signal)).rejects.toThrow('device_revoked')
  })
})

describe('mobile workspace directory picker listing', () => {
  it('lists folders only, sorted, with the parent for upward navigation', async () => {
    const root = await temporaryRoot('dsh-mobile-directories-')
    await Promise.all([
      mkdir(join(root, 'zeta')),
      mkdir(join(root, 'alpha')),
      writeFile(join(root, 'notes.txt'), 'text'),
    ])
    await expect(listWorkspaceDirectories(root)).resolves.toMatchObject({
      path: root,
      parent: expect.any(String),
      entries: [{ name: 'alpha' }, { name: 'zeta' }],
      truncated: false,
    })
  })

  it('keeps enterable directory links, omits broken links, and leaves the image browser unchanged', async () => {
    const root = await temporaryRoot('dsh-mobile-directories-links-')
    const outside = await temporaryRoot('dsh-mobile-directories-outside-')
    await mkdir(join(root, 'real'))
    await mkdir(join(outside, 'child'))
    const link = join(root, 'linked')
    const kind = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(outside, link, kind)
    await symlink(join(outside, 'missing'), join(root, 'broken'), kind)
    const listing = await listWorkspaceDirectories(root)
    expect(listing.entries.map(entry => entry.name)).toEqual(['linked', 'real'])
    expect((await listWorkspaceDirectories(link)).entries).toEqual([{ name: 'child', path: join(link, 'child') }])
    expect((await listComputerImages(root)).entries).toEqual([{ kind: 'directory', name: 'real', path: join(root, 'real') }])
  })

  it('reports no parent at the actual filesystem root', async () => {
    const listing = await listWorkspaceDirectories(parse(tmpdir()).root)
    expect(listing.parent).toBeUndefined()
  })

  it('uses the home directory by default and rejects a missing target without leaking its path', async () => {
    expect(resolveWorkspaceDirectoryPath(null)).toBe(homedir())
    expect(resolveWorkspaceDirectoryPath('')).toBe(homedir())
    expect((await listWorkspaceDirectories(null)).path).toBe(homedir())
    const root = await temporaryRoot('dsh-mobile-directories-missing-')
    await expect(listWorkspaceDirectories(join(root, 'missing'))).rejects.toMatchObject({ status: 404, message: 'directory_unavailable' })
  })

  it('maps a permission failure to the stable unreadable-directory response', async () => {
    const root = await temporaryRoot('dsh-mobile-directories-denied-')
    vi.mocked(fs.opendir).mockRejectedValueOnce(Object.assign(new Error(`permission failure at ${root}`), { code: 'EACCES' }))
    await expect(listWorkspaceDirectories(root)).rejects.toMatchObject({ status: 404, message: 'directory_unavailable' })
  })

  it('retains a bounded 500-row level and allows direct access to an omitted folder', async () => {
    const root = await temporaryRoot('dsh-mobile-directories-limit-')
    const names = Array.from({ length: 501 }, (_, index) => `folder-${String(index).padStart(3, '0')}`)
    await Promise.all(names.map(name => mkdir(join(root, name))))
    const listing = await listWorkspaceDirectories(root)
    expect(listing.entries).toHaveLength(500)
    expect(listing.truncated).toBe(true)
    const shown = listing.entries.map(entry => entry.name)
    expect(shown).toEqual([...shown].sort((left, right) => left.localeCompare(right)))
    const omitted = names.find(name => !shown.includes(name))
    expect(omitted).toBeDefined()
    expect((await listWorkspaceDirectories(join(root, omitted!))).path).toBe(join(root, omitted!))
  })

  it('honours cancellation like the image browser', async () => {
    const root = await temporaryRoot('dsh-mobile-directories-abort-')
    const controller = new AbortController()
    controller.abort(new Error('device_revoked'))
    await expect(listWorkspaceDirectories(root, controller.signal)).rejects.toThrow('device_revoked')
  })

  it('retains a cancelled open until its acquired handle is closed', async () => {
    const root = await temporaryRoot('dsh-mobile-directories-opening-')
    const opening = deferred<Dir>()
    vi.mocked(fs.opendir).mockReturnValueOnce(opening.promise)
    const controller = new AbortController()
    const reason = new Error('device_revoked')
    const pending = listWorkspaceDirectories(root, controller.signal)
    const rejected = expect(pending).rejects.toBe(reason)
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    controller.abort(reason)
    await Promise.resolve()
    expect(settled).toBe(false)
    const level = await native.opendir(root)
    const closed = deferred<void>()
    const close = level.close.bind(level)
    vi.spyOn(level, 'close').mockImplementation(async () => { await close(); closed.resolve() })
    opening.resolve(level)
    await rejected
    await closed.promise
  })

  it('preserves cancellation during an empty-directory read rather than returning success or 404', async () => {
    const root = await temporaryRoot('dsh-mobile-directories-reading-')
    const level = await native.opendir(root)
    const reading = deferred<null>()
    const started = deferred<void>()
    const closed = deferred<void>()
    const close = level.close.bind(level)
    vi.spyOn(level, 'close').mockImplementation(async () => { await close(); closed.resolve() })
    vi.spyOn(level, 'read').mockImplementationOnce(() => { started.resolve(); return reading.promise })
    vi.mocked(fs.opendir).mockResolvedValueOnce(level)
    const controller = new AbortController()
    const reason = new Error('cancelled')
    const pending = listWorkspaceDirectories(root, controller.signal)
    const rejected = expect(pending).rejects.toBe(reason)
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    await started.promise
    controller.abort(reason)
    await Promise.resolve()
    expect(settled).toBe(false)
    reading.resolve(null)
    await rejected
    await closed.promise
  })

  it('preserves cancellation while probing a directory link', async () => {
    const root = await temporaryRoot('dsh-mobile-directories-link-abort-')
    const outside = await temporaryRoot('dsh-mobile-directories-link-target-')
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const targetInfo = await native.stat(outside)
    const probing = deferred<typeof targetInfo>()
    const started = deferred<void>()
    vi.mocked(fs.stat).mockImplementationOnce(() => { started.resolve(); return probing.promise })
    const controller = new AbortController()
    const reason = new Error('device_revoked')
    const pending = listWorkspaceDirectories(root, controller.signal)
    const rejected = expect(pending).rejects.toBe(reason)
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    await started.promise
    controller.abort(reason)
    await Promise.resolve()
    expect(settled).toBe(false)
    probing.resolve(targetInfo)
    await rejected
  })
})

describe('workspace directory path syntax', () => {
  it.each([
    ['C:\\', 'C:\\'],
    ['D:\\projects', 'D:\\projects'],
    ['E:/work/../projects', 'E:\\projects'],
    ['\\\\server\\share', '\\\\server\\share\\'],
    ['\\\\server\\share\\projects', '\\\\server\\share\\projects'],
  ])('normalizes the fully qualified Windows path %s without changing its root', (path, expected) => {
    expect(resolveWorkspaceDirectoryPath(path, 'win32')).toBe(expected)
  })

  it.each(['relative', 'C:relative', 'C:', '\\projects', '/projects', '\\\\', '\\\\server', '\\\\?\\C:\\projects', '\\\\.\\pipe\\test', 'C:\\a\0b'])('rejects current-drive or unsafe Windows path %s', path => {
    expect(() => resolveWorkspaceDirectoryPath(path, 'win32')).toThrow('bad_path')
  })

  it('normalizes only absolute POSIX paths', () => {
    expect(resolveWorkspaceDirectoryPath('/work/a/../project', 'linux')).toBe('/work/project')
    expect(() => resolveWorkspaceDirectoryPath('work/project', 'linux')).toThrow('bad_path')
    expect(() => resolveWorkspaceDirectoryPath('/a\0b', 'linux')).toThrow('bad_path')
  })
})
