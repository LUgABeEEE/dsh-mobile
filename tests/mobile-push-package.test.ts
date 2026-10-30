import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'tsdown'
import { expect, it } from 'vitest'

const run = promisify(execFile)

it('exposes the provider-free push settings check as a package script alias', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> }
  expect(manifest.scripts['smoke:push-settings']).toBe('node ./scripts/smoke-mobile-push-settings.mjs')
})

it('serves the original icons from an extracted npm package outside its working directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-push-pack-'))
  try {
    const staging = join(root, 'staging')
    await mkdir(join(staging, 'lib'), { recursive: true })
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as Record<string, unknown>
    // Preserve the real package identity, exports and published file rules. Only
    // the asset Host entry is compiled here; full plugin loading is a smoke gate.
    await writeFile(join(staging, 'package.json'), JSON.stringify({ ...manifest, scripts: {}, workspaces: undefined }))
    await cp('assets/mobile-push', join(staging, 'assets', 'mobile-push'), { recursive: true })
    await build({ config: false, entry: { index: resolve('src/mobile-push/assets.ts') }, outDir: join(staging, 'lib'),
      format: ['esm'], platform: 'node', target: 'node22', clean: false, dts: false })
    const npm = process.env.npm_execpath
    if (!npm) throw new Error('Run this package test through npm so npm_execpath identifies its CLI')
    const packed = await run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: staging })
    const record = (JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[])[0]!
    expect(record.files.map(file => file.path)).toEqual(expect.arrayContaining([
      'assets/mobile-push/icon-180.png', 'assets/mobile-push/icon-192.png', 'assets/mobile-push/icon-512.png',
    ]))
    expect(record.filename).toMatch(/^dsh-mobile-[^/\\]+\.tgz$/u)
    const extracted = join(root, 'extracted')
    await mkdir(extracted)
    await run('tar', ['-xzf', join(root, record.filename), '-C', extracted])
    const entry = pathToFileURL(join(extracted, 'package', 'lib', 'index.mjs')).href
    const result = await run(process.execPath, ['--input-type=module', '-e', `
      import { createHash } from 'node:crypto';
      const { mobilePushAsset } = await import(${JSON.stringify(entry)});
      const icons = {};
      for (const size of [180,192,512]) {
        const asset = await mobilePushAsset('/mobile-access/push/icon-' + size + '.png');
        if (!asset || asset.contentType !== 'image/png') throw new Error('missing icon');
        icons[size] = createHash('sha256').update(asset.body).digest('hex');
      }
      const manifest = JSON.parse((await mobilePushAsset('/mobile-access/push/manifest.webmanifest')).body);
      console.log(JSON.stringify({icons, manifest}));
    `], { cwd: root })
    const { createHash } = await import('node:crypto')
    const expected: Record<string, string> = {}
    for (const size of [180, 192, 512]) expected[size] = createHash('sha256').update(await readFile(`assets/mobile-push/icon-${size}.png`)).digest('hex')
    const output = JSON.parse(result.stdout) as { icons: Record<string, string>; manifest: Record<string, unknown> }
    expect(output.icons).toEqual(expected)
    expect(output.manifest).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone' })
  } finally {
    const target = resolve(root)
    if (!target.startsWith(`${resolve(tmpdir())}${sep}dsh-mobile-push-pack-`)) throw new Error('Refusing to remove a non-owned package fixture')
    await rm(target, { recursive: true, force: true })
  }
}, 30_000)
