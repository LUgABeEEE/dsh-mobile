import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mobilePushAsset } from '../src/mobile-push/assets.js'

describe('dedicated Mobile push static assets', () => {
  it('returns the fixed credential-free standalone manifest at its dedicated route', async () => {
    const asset = await mobilePushAsset('/mobile-access/push/manifest.webmanifest')
    expect(asset?.contentType).toBe('application/manifest+json; charset=utf-8')
    const manifest = JSON.parse(String(asset?.body)) as Record<string, unknown>
    expect(manifest).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone' })
    expect(JSON.stringify(manifest)).not.toMatch(/credential|token|reference|mobile-push|\?/i)
    expect(manifest.icons).toEqual([
      { src: '/mobile-access/push/icon-180.png', sizes: '180x180', type: 'image/png' },
      { src: '/mobile-access/push/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/mobile-access/push/icon-512.png', sizes: '512x512', type: 'image/png' },
    ])
  })

  it.each([
    ['/mobile-access/push/icon-180.png', 180],
    ['/mobile-access/push/icon-192.png', 192],
    ['/mobile-access/push/icon-512.png', 512],
  ])('serves its fixed %s image from the package-relative root', async (path, size) => {
    const asset = await mobilePushAsset(path)
    expect(asset?.contentType).toBe('image/png')
    expect(Buffer.from(asset?.body as Uint8Array).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const image = await readFile(new URL(`../assets/mobile-push/icon-${size}.png`, import.meta.url))
    expect(Buffer.from(asset?.body as Uint8Array)).toEqual(image)
  })

  it('resolves default assets from the package root of an isolated single-file bundle', async () => {
    const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const owned = await mkdtemp(join(tmpdir(), 'dsh-mobile-push-mini-bundle-'))
    const packageRoot = join(owned, 'package')
    const assetRoot = join(packageRoot, 'assets', 'mobile-push')
    try {
      await mkdir(assetRoot, { recursive: true })
      await mkdir(join(packageRoot, 'lib'), { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-mobile', type: 'module', exports: { './package.json': './package.json' } }))
      for (const size of [180, 192, 512]) await cp(join(workspace, 'assets', 'mobile-push', `icon-${size}.png`), join(assetRoot, `icon-${size}.png`))
      const { build } = await import('tsdown')
      await build({ entry: { index: join(workspace, 'src/mobile-push/assets.ts') }, outDir: join(packageRoot, 'lib'), format: 'esm', platform: 'node', target: 'node22', dts: false, clean: true, config: false })
      const bundleUrl = pathToFileURL(join(packageRoot, 'lib/index.mjs')).href
      const script = `const m=await import(${JSON.stringify(bundleUrl)}); const a=await m.mobilePushAsset('/mobile-access/push/icon-192.png'); if(a?.contentType!=='image/png') throw Error('wrong content type'); process.stdout.write(Buffer.from(a.body).toString('base64'))`
      const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: owned, encoding: 'utf8' })
      expect(Buffer.from(result, 'base64')).toEqual(await readFile(join(assetRoot, 'icon-192.png')))
    } finally {
      await rm(owned, { recursive: true, force: true })
    }
  })

  it.each([
    '/mobile-access/push/anything.png',
    '/mobile-access/push/icon-192.png?other=1',
    '/mobile-access/manifest',
    '/../package.json',
  ])('rejects a non-allowlisted asset path (%s)', async path => {
    await expect(mobilePushAsset(path)).resolves.toBeUndefined()
  })
})
