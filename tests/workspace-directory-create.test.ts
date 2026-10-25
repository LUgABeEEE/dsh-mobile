import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspaceDirectory } from '../src/computer-images.js'

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
