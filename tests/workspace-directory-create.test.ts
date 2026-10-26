import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspaceDirectory, workspaceDirectoryChildPath } from '../src/computer-images.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true })
})

async function ownedRoot (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-directory-create-'))
  roots.push(root)
  return root
}

describe('workspace directory creation', () => {
  it.each(['D:child', 'C:child', 'file:stream', 'CON', 'con.txt', 'LPT1.log', 'COM¹', 'child.', 'child ', '.. ', '<child>', 'child?'])('rejects reserved or drive-relative Windows name %s', name => {
    expect(() => workspaceDirectoryChildPath('C:\\projects', name, 'win32')).toThrowError(expect.objectContaining({ code: 'directory_create_invalid' }))
  })

  it('keeps drive and UNC children under their immediate parent', () => {
    expect(workspaceDirectoryChildPath('C:\\projects', '新项目', 'win32')).toBe('C:\\projects\\新项目')
    expect(workspaceDirectoryChildPath('\\\\server\\share', 'child', 'win32')).toBe('\\\\server\\share\\child')
    expect(workspaceDirectoryChildPath('/projects', 'colon:name', 'linux')).toBe('/projects/colon:name')
  })

  it('requires an explicit parent rather than creating in the user home', () => {
    expect(() => workspaceDirectoryChildPath('', 'child')).toThrowError(expect.objectContaining({ code: 'directory_create_invalid' }))
  })

  it('does not create anything when already cancelled', async () => {
    const root = await ownedRoot()
    const controller = new AbortController(); controller.abort(new Error('cancelled'))
    await expect(createWorkspaceDirectory(root, 'child', controller.signal)).rejects.toBe(controller.signal.reason)
    await expect(stat(join(root, 'child'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('creates one child directory and returns its absolute path', async () => {
    const root = await ownedRoot()
    const created = await createWorkspaceDirectory(root, 'projects')
    expect(created.path).toBe(join(root, 'projects'))
    expect((await stat(created.path)).isDirectory()).toBe(true)
  })

  it('refuses a name that already exists', async () => {
    const root = await ownedRoot()
    await mkdir(join(root, 'projects'))
    await expect(createWorkspaceDirectory(root, 'projects')).rejects.toMatchObject({ code: 'directory_exists' })
  })

  it('refuses a name with a path separator', async () => {
    const root = await ownedRoot()
    await expect(createWorkspaceDirectory(root, 'a/b')).rejects.toMatchObject({ code: 'directory_create_invalid' })
    await expect(createWorkspaceDirectory(root, 'a\\b')).rejects.toMatchObject({ code: 'directory_create_invalid' })
  })

  it('refuses relative markers and blank names', async () => {
    const root = await ownedRoot()
    await expect(createWorkspaceDirectory(root, '.')).rejects.toMatchObject({ code: 'directory_create_invalid' })
    await expect(createWorkspaceDirectory(root, '..')).rejects.toMatchObject({ code: 'directory_create_invalid' })
    await expect(createWorkspaceDirectory(root, '   ')).rejects.toMatchObject({ code: 'directory_create_invalid' })
  })

  it('refuses an absolute name', async () => {
    const root = await ownedRoot()
    await expect(createWorkspaceDirectory(root, join(root, 'elsewhere'))).rejects.toMatchObject({ code: 'directory_create_invalid' })
  })

  it('requires the parent to exist', async () => {
    const root = await ownedRoot()
    await expect(createWorkspaceDirectory(join(root, 'missing'), 'child')).rejects.toMatchObject({ code: 'directory_unavailable' })
  })

  it('never creates nested directories', async () => {
    const root = await ownedRoot()
    await expect(createWorkspaceDirectory(root, 'one/two')).rejects.toMatchObject({ code: 'directory_create_invalid' })
    await expect(stat(join(root, 'one'))).rejects.toThrow()
  })

  it('reports an unreadable parent instead of creating it', async () => {
    const root = await ownedRoot()
    const file = join(root, 'not-a-directory')
    await writeFile(file, 'text')
    await expect(createWorkspaceDirectory(file, 'child')).rejects.toMatchObject({ code: 'directory_create_invalid' })
  })
})
