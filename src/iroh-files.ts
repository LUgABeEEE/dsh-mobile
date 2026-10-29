import { assertManagedParents, ensureManagedDirectory, removeManagedTree, renameManagedPath } from './managed-files.js'

/** The iroh sidecar lives under the shared plugin state directory. */
export async function assertIrohParents(root: string, target: string): Promise<void> {
  await assertManagedParents(root, target, 'iroh')
}

export async function renameIrohPath(root: string, source: string, destination: string): Promise<void> {
  await renameManagedPath(root, source, destination, 'iroh')
}

export async function ensureIrohDirectory(root: string, directory: string): Promise<void> {
  await ensureManagedDirectory(root, directory, 'iroh')
}

export async function removeIrohTree(root: string, target: string): Promise<void> {
  await removeManagedTree(root, target, 'iroh')
}
