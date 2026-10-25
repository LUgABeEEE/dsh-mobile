import { lstat, opendir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, posix, resolve, win32 } from 'node:path'
import { HttpError } from './http-security.js'

const MAX_ENTRIES = 500
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const IMAGE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
})

/** One computer-side row rendered by the authenticated mobile file sheet. */
export interface ComputerImageEntry {
  readonly kind: 'directory' | 'image'
  readonly name: string
  readonly path: string
}

/** A bounded computer-side directory listing containing folders and supported images. */
export interface ComputerImageListing {
  readonly path: string
  readonly parent?: string
  readonly entries: readonly ComputerImageEntry[]
  readonly truncated: boolean
}

/** Normalize an optional mobile-browser path without rebasing relative input. */
export function resolveComputerImagePath(path: string | null): string {
  if (path === null || path === '') return homedir()
  if (!isAbsolute(path) || path.includes('\0')) throw new HttpError(400, 'bad_path')
  return resolve(path)
}

/** List folders and supported image files without following symbolic links. */
export async function listComputerImages(path: string | null, signal?: AbortSignal): Promise<ComputerImageListing> {
  signal?.throwIfAborted()
  const target = resolveComputerImagePath(path)
  const rows: ComputerImageEntry[] = []
  let truncated = false
  let directory
  try {
    directory = await opendir(target)
    for await (const entry of directory) {
      signal?.throwIfAborted()
      if (entry.isSymbolicLink()) continue
      const kind = entry.isDirectory() ? 'directory' : IMAGE_TYPES[extname(entry.name).toLowerCase()] === undefined ? undefined : 'image'
      if (kind === undefined) continue
      if (rows.length === MAX_ENTRIES) {
        truncated = true
        break
      }
      rows.push({ kind, name: entry.name, path: resolve(target, entry.name) })
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    throw new HttpError(404, 'directory_unavailable')
  } finally {
    await directory?.close().catch(() => undefined)
  }
  rows.sort((left, right) => left.kind === right.kind
    ? left.name.localeCompare(right.name)
    : left.kind === 'directory' ? -1 : 1)
  const parent = dirname(target)
  return Object.freeze({
    path: target,
    ...(parent === target ? {} : { parent }),
    entries: Object.freeze(rows),
    truncated,
  })
}

/** One folder row rendered by the authenticated mobile directory picker. */
export interface DirectoryPickerEntry {
  readonly name: string
  readonly path: string
}

/** A bounded folder-only listing for the mobile workspace directory picker. */
export interface DirectoryPickerListing {
  readonly path: string
  readonly parent?: string
  readonly entries: readonly DirectoryPickerEntry[]
  readonly truncated: boolean
}

/**
 * Resolve a workspace path without a relative or current-drive fallback.
 *
 * @param path - Fully qualified directory, or null/empty for the Host home.
 * @param platform - Host path syntax; explicit for cross-platform parser tests.
 * @returns The normalized fully qualified path in the selected syntax.
 */
export function resolveWorkspaceDirectoryPath(path: string | null, platform: NodeJS.Platform = process.platform): string {
  if (path === null || path === '') return homedir()
  const paths = platform === 'win32' ? win32 : posix
  const qualified = platform !== 'win32' || (
    /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+(?:[\\/]|$))/u.test(path)
    && !/^[\\/]{2}[?.][\\/]/u.test(path)
  )
  if (path.includes('\0') || !paths.isAbsolute(path) || !qualified) throw new HttpError(400, 'bad_path')
  return paths.resolve(path)
}

/**
 * List folders only for the dedicated mobile workspace picker.
 *
 * Returns at most 500 enterable folders, including directory links. A truncated
 * level retains its first filesystem-enumerated rows; callers can enter an
 * absolute path to reach an omitted row. Cancellation preserves its reason;
 * pending filesystem operations and handle closure settle before this request
 * releases its Gateway work slot.
 */
export async function listWorkspaceDirectories(path: string | null, signal?: AbortSignal): Promise<DirectoryPickerListing> {
  signal?.throwIfAborted()
  const target = resolveWorkspaceDirectoryPath(path)
  const rows: DirectoryPickerEntry[] = []
  let truncated = false
  let directory
  try {
    directory = await opendir(target)
    for (;;) {
      signal?.throwIfAborted()
      const entry = await directory.read()
      signal?.throwIfAborted()
      if (entry === null) break
      const entryPath = resolve(target, entry.name)
      let enterable = entry.isDirectory()
      if (!enterable && entry.isSymbolicLink()) {
        try {
          enterable = (await stat(entryPath)).isDirectory()
          signal?.throwIfAborted()
        } catch {
          signal?.throwIfAborted()
          // Broken or unreadable links cannot be entered by this picker.
          continue
        }
      }
      if (!enterable) continue
      if (rows.length === MAX_ENTRIES) {
        truncated = true
        break
      }
      rows.push({ name: entry.name, path: entryPath })
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    throw new HttpError(404, 'directory_unavailable')
  } finally {
    try {
      await directory?.close()
    } catch {
      throw new HttpError(500, 'directory_cleanup_failed')
    }
  }
  signal?.throwIfAborted()
  rows.sort((left, right) => left.name.localeCompare(right.name))
  const parent = dirname(target)
  return Object.freeze({
    path: target,
    ...(parent === target ? {} : { parent }),
    entries: Object.freeze(rows),
    truncated,
  })
}

/** Read one bounded regular image file selected by an authenticated device. */
export async function readComputerImage(path: string | null, signal?: AbortSignal): Promise<{ body: Buffer; contentType: string; name: string }> {
  signal?.throwIfAborted()
  const target = resolveComputerImagePath(path)
  const contentType = IMAGE_TYPES[extname(target).toLowerCase()]
  if (contentType === undefined) throw new HttpError(415, 'unsupported_file_type')
  let info
  try {
    info = await lstat(target)
  } catch {
    throw new HttpError(404, 'file_unavailable')
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(404, 'file_unavailable')
  if (info.size > MAX_IMAGE_BYTES) throw new HttpError(413, 'file_too_large')
  try {
    return { body: await readFile(target, { signal }), contentType, name: basename(target) }
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    throw new HttpError(404, 'file_unavailable')
  }
}
