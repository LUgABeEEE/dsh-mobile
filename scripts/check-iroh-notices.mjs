/** Check notice coverage against each Android transport's normal/build dependency graph. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const text = readFileSync(new URL('../apps/mobile/android/app/src/main/assets/THIRD_PARTY_NOTICES.txt', import.meta.url), 'utf8')
const covered = new Set([...text.matchAll(/^========== (.+) ==========\r?$/gm)].map(match => match[1]))
const workspace = new Set(['dsh-mobile-iroh-host', 'dsh-mobile-iroh-core', 'dsh-mobile-iroh-android-transport'])
for (const target of ['aarch64-linux-android', 'x86_64-linux-android']) {
  const tree = execFileSync('cargo', ['tree', '--locked', '--manifest-path', 'native/Cargo.toml',
    '-p', 'dsh-mobile-iroh-android-transport', '--target', target, '-e', 'normal,build',
    '--prefix', 'none', '--format', '{p}'], { cwd: root, encoding: 'utf8', windowsHide: true })
  const dependencies = new Set([...tree.matchAll(/^([\w-]+) v([^\s]+)/gm)]
    .filter(match => !workspace.has(match[1])).map(match => `${match[1]} ${match[2]}`))
  if (dependencies.size === 0) throw new Error(`Empty dependency graph: ${target}`)
  const missing = [...dependencies].filter(dependency => !covered.has(dependency))
  if (missing.length) throw new Error(`Missing ${target} third-party notices: ${missing.join(', ')}`)
  console.log(`${target}: notices cover ${dependencies.size} normal/build dependencies`)
}
