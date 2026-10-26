import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request as requestHttp } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { limitMobileBootBatches, MobileAccessGateway, parseMobileBootPlan, splitMobileBootBatch } from '../src/gateway.js'
import { SESSION_COOKIE } from '../src/http-security.js'
import { MemoryDeviceStore } from '../src/storage.js'

const MIB = 1024 * 1024
const LAYOUT = '@deepseek-ai/dsh-client-ui-layout'
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Boot budget fixture cleanup failed')
})

function entry(id: string) {
  return { id, url: `/plugins/${id === LAYOUT ? 'layout' : id}.js?rev=current`, rev: 'current' }
}

function split(ids: readonly string[], bytes = 2 * MIB) {
  const entries = ids.map(entry)
  const sizes = new Map(entries.filter(item => item.id !== LAYOUT).map(item => [item.url, bytes]))
  return splitMobileBootBatch(entries, sizes, new Set())
}

describe('mobile boot graph budget', () => {
  it('serves the authenticated document, retained batches and overflow resources through the gateway', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-boot-budget-'))
    cleanups.push(async () => {
      const inside = relative(tmpdir(), root)
      if (isAbsolute(inside) || !inside.startsWith('dsh-mobile-boot-budget-')) throw new Error('Unsafe boot budget fixture root')
      await rm(root, { recursive: true, force: true })
    })
    const ids = Array.from({ length: 17 }, (_value, index) => `feature-${index}`)
    const graph = {
      rev: 'current',
      entries: [...ids.map(entry), {
        ...entry(LAYOUT), inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      }],
      batches: [{ phase: 'application', url: '/plugins/application.js', rev: 'current', entries: [...ids, LAYOUT] }],
    }
    const index = `<!doctype html><html><head><link rel="preload" as="script" href="/plugins/application.js"><script>window.__DSH_BOOT__=${JSON.stringify(graph)};</script></head><body></body></html>`
    const source = Buffer.from(`/*${'x'.repeat(2 * MIB - 4)}*/`)
    const upstream = createServer((request, response) => {
      const body = request.url === '/' ? Buffer.from(index) : source
      response.writeHead(200, { 'content-type': request.url === '/' ? 'text/html' : 'text/javascript', 'content-length': body.byteLength })
      response.end(body)
    })
    cleanups.push(async () => {
      upstream.closeAllConnections()
      if (upstream.listening) await new Promise<void>((resolve, reject) => {
        upstream.close(error => { if (error) reject(error); else resolve() })
      })
    })
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject)
      upstream.listen(0, '127.0.0.1', () => { upstream.removeListener('error', reject); resolve() })
    })
    const address = upstream.address()
    if (address === null || typeof address === 'string') throw new Error('Owned upstream has no TCP address')
    const mobileLayoutFile = join(root, 'mobile-layout.js')
    await writeFile(mobileLayoutFile, 'globalThis.__bootBudgetLayout = true;\n')
    const config = parseGatewayConfig({
      listenHost: '127.0.0.1', listenPort: 0, upstreamOrigin: `http://127.0.0.1:${address.port}`,
      publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
      stateFile: join(root, 'devices.json'), tls: { mode: 'disabled' }, mobileLayoutFile,
    })
    const gateway = new MobileAccessGateway(Object.freeze({ ...config, discovery: false }), new MemoryDeviceStore())
    cleanups.push(() => gateway.close())
    await gateway.start()
    const pairing = await gateway.access.openPairing()
    const paired = await gateway.access.pair('boot-budget-device', pairing.token, 'Boot budget test')
    const origin = gateway.address().origin
    const get = (path: string) => new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const outgoing = requestHttp({
        host: '127.0.0.1', port: gateway.address().port, path, agent: false,
        headers: { host: new URL(origin).host, origin, accept: 'text/html', 'accept-encoding': 'identity',
          cookie: `${SESSION_COOKIE}=${paired.sessionToken}` },
      }, incoming => {
        const chunks: Buffer[] = []
        incoming.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
        incoming.once('error', reject)
        incoming.once('end', () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks) }))
      })
      outgoing.once('error', reject)
      outgoing.setTimeout(4_000, () => { outgoing.destroy(new Error('Owned boot budget request timed out')) })
      outgoing.end()
    })
    const document = await get('/')
    expect(document.status, `dedicated boot document response: ${document.status} ${document.body.toString('utf8').slice(0, 160)}`).toBe(200)
    const html = document.body.toString('utf8')
    const assignment = /window\.__DSH_BOOT__=(\{[\s\S]*?\});/u.exec(html)
    expect(assignment).not.toBeNull()
    const projected = JSON.parse(assignment![1]!) as {
      batches: Array<{ url: string; entries: string[] }>
    }
    const merged = projected.batches.filter(batch => batch.url.startsWith('/mobile-access/mobile-boot/'))
    expect(merged).toHaveLength(16)
    expect(projected.batches.flatMap(batch => batch.entries).sort()).toEqual([...ids, LAYOUT].sort())
    expect(html).not.toContain('href="/plugins/application.js"')
    for (const batch of projected.batches) expect(html).toContain(`href="${batch.url.replaceAll('&', '&amp;')}"`)
    expect((await get(merged[0]!.url)).status).toBe(200)
    const layoutBatch = merged.find(batch => batch.entries.includes(LAYOUT))!
    const layout = await get(layoutBatch.url)
    expect(layout.status).toBe(200)
    expect(layout.body.toString('utf8')).toContain('globalThis.__bootBudgetLayout = true;')
    const overflow = projected.batches.find(batch => batch.url.startsWith('/plugins/'))!
    const direct = await get(overflow.url)
    expect(direct.status).toBe(200)
    expect(direct.body.equals(source)).toBe(true)
  })

  it('keeps seventeen 2 MiB modules loadable without evicting the layout replacement', () => {
    const ids = [...Array.from({ length: 17 }, (_value, index) => `feature-${index}`), LAYOUT]
    const original = split(ids)
    expect(original.plans).toHaveLength(17)

    const [bounded] = limitMobileBootBatches([original])
    expect(bounded!.plans).toHaveLength(16)
    expect(bounded!.plans.some(plan => plan.entries.some(item => item.id === LAYOUT))).toBe(true)
    expect(bounded!.rows.flatMap(row => row.entries).sort()).toEqual([...ids].sort())
    const direct = bounded!.rows.filter(row => row.url.startsWith('/plugins/'))
    expect(direct).toHaveLength(1)
    expect(direct[0]).toEqual({
      phase: 'application', url: entry(direct[0]!.entries[0]!).url,
      rev: 'current', entries: direct[0]!.entries,
    })
    expect(bounded!.rows.filter(row => row.url.startsWith('/mobile-access/mobile-boot/'))).toHaveLength(16)
    expect(limitMobileBootBatches([original])).toEqual([bounded])
  })

  it('shares the merged-batch allowance across application batches after exclusions', () => {
    const ids = Array.from({ length: 27 }, (_value, index) => `feature-${index}`)
    const excluded = ['omit-second', 'omit-third']
    const groups = [
      [...ids.slice(0, 9), LAYOUT],
      [...ids.slice(9, 18), excluded[0]!],
      [...ids.slice(18), excluded[1]!],
    ]
    const entries = [...ids, ...excluded, LAYOUT].map(id => ({
      ...entry(id),
      ...(id === LAYOUT ? { inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'] } : {}),
    }))
    const graph = {
      rev: 'current', entries,
      batches: groups.map((members, index) => ({
        phase: 'application', url: `/plugins/application-${index}.js`, rev: 'current', entries: members,
      })),
    }
    const html = `<!doctype html><script>window.__DSH_BOOT__=${JSON.stringify(graph)};</script>`
    const parsed = parseMobileBootPlan(html, excluded)
    const sizes = new Map(ids.map(id => [entry(id).url, 2 * MIB]))
    const originals = parsed.rewrittenBatchEntries!.map(batch => splitMobileBootBatch(batch.entries, sizes, new Set()))
    expect(originals).toHaveLength(3)

    const bounded = limitMobileBootBatches(originals)
    expect(bounded.flatMap(batch => batch.plans)).toHaveLength(16)
    expect(bounded.flatMap(batch => batch.rows.flatMap(row => row.entries)).sort()).toEqual([...ids, LAYOUT].sort())
    expect(parsed.entries.some(item => excluded.includes(item.id))).toBe(false)
    expect(bounded.flatMap(batch => batch.plans).some(plan => plan.entries.some(item => item.id === LAYOUT))).toBe(true)
    for (const row of bounded.flatMap(batch => batch.rows).filter(row => row.url.startsWith('/plugins/'))) {
      expect(row.entries).toHaveLength(1)
      expect(row.url).toBe(entry(row.entries[0]!).url)
      expect(row.rev).toBe('current')
    }
  })

  it('retains a module above the target as a whole without raising the per-entry cap', () => {
    const oversized = splitMobileBootBatch([entry('large'), entry(LAYOUT)], new Map([[entry('large').url, 5 * MIB]]), new Set())
    const [bounded] = limitMobileBootBatches([oversized])
    const merged = bounded!.plans.find(plan => plan.entries.some(item => item.id === 'large'))
    expect(merged!.entries.map(item => item.id)).toEqual(['large'])

    const capped = splitMobileBootBatch([entry('large'), entry(LAYOUT)], new Map([[entry('large').url, 8 * MIB]]), new Set())
    const [cappedBounded] = limitMobileBootBatches([capped])
    expect(cappedBounded!.plans.flatMap(plan => plan.entries).map(item => item.id)).toEqual([LAYOUT])
    expect(cappedBounded!.rows.find(row => row.entries.includes('large'))!.url).toBe(entry('large').url)
  })

  it('does not turn an invalid overflow source into a browser script URL', () => {
    const initial = split(Array.from({ length: 16 }, (_value, index) => `feature-${index}`))
    const invalid = splitMobileBootBatch([
      { id: 'invalid', url: 'https://outside.invalid/module.js', rev: 'current' },
    ], new Map([['https://outside.invalid/module.js', 2 * MIB]]), new Set())
    const layout = split([LAYOUT])
    expect(() => limitMobileBootBatches([initial, invalid, layout])).toThrow('no valid module URL')
  })
})
