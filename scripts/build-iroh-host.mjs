import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = resolve(root, 'native')
const outputDirectory = resolve(root, 'bin')
const cargo = process.env.CARGO_BINARY ?? 'cargo'

/** iroh sidecars this repository builds natively per CI runner. Cross-compilation is out of scope. */
const targets = [
  { platform: 'win32', arch: 'x64', binary: 'dsh-mobile-iroh-host.exe', file: 'dsh-mobile-iroh-host-win32-x64.exe', header: 'MZ' },
  { platform: 'linux', arch: 'x64', binary: 'dsh-mobile-iroh-host', file: 'dsh-mobile-iroh-host-linux-x64', header: 'ELF' },
]

const current = targets.find(target => target.platform === process.platform && target.arch === process.arch)
if (current === undefined) {
  throw new Error(`iroh host has no published target for ${process.platform}-${process.arch}: Windows x64 and Linux x64 only`)
}

await mkdir(outputDirectory, { recursive: true })
await execFile(cargo, ['build', '--locked', '--release', '-p', 'dsh-mobile-iroh-host'], {
  // The shared workspace root owns `target/`; building from the crate
  // directory would still emit there, so run at the root explicitly.
  cwd: workspace,
  env: { ...process.env },
  windowsHide: true,
  maxBuffer: 64 * 1024 * 1024,
})
const output = resolve(outputDirectory, current.file)
await copyFile(resolve(workspace, 'target/release', current.binary), output)
if (process.platform !== 'win32') await chmod(output, 0o755)
const bytes = await readFile(output)
const magic = bytes.subarray(0, 4)
const header = current.header === 'MZ'
  ? magic.subarray(0, 2).toString('ascii')
  : magic[0] === 0x7f && magic.subarray(1, 4).toString('ascii') === 'ELF' ? 'ELF' : 'unknown'
if (header !== current.header) throw new Error(`iroh host build did not produce a ${current.header} binary: ${output}`)
console.log(`built ${output} bytes:${bytes.length} sha256:${createHash('sha256').update(bytes).digest('hex')}`)
