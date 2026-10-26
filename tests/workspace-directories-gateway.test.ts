import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { createServer, request as requestHttp, ServerResponse, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { listWorkspaceDirectories } from '../src/computer-images.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { CSRF_HEADER, SESSION_COOKIE } from '../src/http-security.js'
import { MemoryDeviceStore } from '../src/storage.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, opendir: vi.fn(actual.opendir) }
})

vi.mock('../src/computer-images.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/computer-images.js')>()
  return { ...actual, listWorkspaceDirectories: vi.fn(actual.listWorkspaceDirectories) }
})

interface HttpResult { readonly status: number; readonly body: string }
const cleanups: Array<() => Promise<void>> = []
const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(listWorkspaceDirectories).mockClear()
  vi.mocked(fs.opendir).mockReset().mockImplementation(native.opendir)
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('owned test listener has no TCP address')
  return address.port
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) })
}

function beginRequest(port: number, path: string, headers: IncomingHttpHeaders, method = 'GET', body?: string) {
  let cancel = (): void => {}
  const wireHeaders = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined))
  if (body !== undefined) wireHeaders['content-length'] = String(Buffer.byteLength(body))
  const result = new Promise<HttpResult>((resolve, reject) => {
    const outgoing = requestHttp({ host: '127.0.0.1', port, path, method, headers: wireHeaders, agent: false }, incoming => {
      const chunks: Buffer[] = []
      incoming.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      incoming.once('error', reject)
      incoming.once('end', () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.once('error', reject)
    outgoing.setTimeout(2_000, () => { outgoing.destroy(new Error('owned directory request timed out')) })
    cancel = () => { outgoing.destroy(new Error('fixture caller cancelled')) }
    outgoing.end(body)
  })
  return { result, cancel: () => cancel() }
}

async function fixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-workspace-gateway-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const observations: string[] = []
  const upstream = createServer((request, response) => {
    observations.push(request.url ?? '')
    response.writeHead(404)
    response.end()
  })
  cleanups.push(() => close(upstream))
  const upstreamPort = await listen(upstream)
  const config = parseGatewayConfig({
    listenHost: '127.0.0.1', listenPort: 0,
    upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
    publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
    stateFile: join(root, 'devices.json'), tls: { mode: 'disabled' }, ...overrides,
  })
  const instance = new MobileAccessGateway(Object.freeze({ ...config, discovery: false }), new MemoryDeviceStore())
  let acknowledgedCloseFailure: unknown = Symbol('no acknowledged cleanup failure')
  cleanups.push(async () => {
    try { await instance.close() } catch (error) { if (error !== acknowledgedCloseFailure) throw error }
  })
  await instance.start()
  const opened = await instance.access.openPairing()
  const paired = await instance.access.pair('owned-directory-test', opened.token, 'Owned directory test')
  const origin = instance.address().origin
  const headers: IncomingHttpHeaders = {
    host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin',
    cookie: `${SESSION_COOKIE}=${paired.sessionToken}`,
  }
  const get = (path: string, overrides: IncomingHttpHeaders = {}) => beginRequest(instance.address().port, path, { ...headers, ...overrides }).result
  return { root, instance, paired, headers, observations, get,
    acknowledgeCloseFailure: (error: unknown) => { acknowledgedCloseFailure = error } }
}

const directoryRoute = (path: string): string => `/mobile-access/workspace-directories?path=${encodeURIComponent(path)}`

describe('authenticated workspace directory gateway', () => {
  it('serves only folder rows locally and preserves filesystem rejection codes', async () => {
    const context = await fixture()
    await mkdir(join(context.root, 'workspace'))
    await writeFile(join(context.root, 'notes.txt'), 'not a folder')
    const listed = await context.get(directoryRoute(context.root))
    expect(listed.status).toBe(200)
    expect(JSON.parse(listed.body)).toMatchObject({ entries: [{ name: 'workspace', path: join(context.root, 'workspace') }] })
    const relative = await context.get(directoryRoute('relative'))
    expect(relative.status).toBe(400)
    expect(JSON.parse(relative.body)).toEqual({ error: 'bad_path' })
    const missing = await context.get(directoryRoute(join(context.root, 'missing')))
    expect(missing.status).toBe(404)
    expect(JSON.parse(missing.body)).toEqual({ error: 'directory_unavailable' })
    expect(context.observations).toEqual([])
  })

  it('rejects absent or invalid Sessions before listing a directory', async () => {
    const context = await fixture()
    expect((await context.get(directoryRoute(context.root), { cookie: undefined })).status).toBe(401)
    expect((await context.get(directoryRoute(context.root), { cookie: `${SESSION_COOKIE}=invalid` })).status).toBe(401)
    expect(listWorkspaceDirectories).not.toHaveBeenCalled()
    expect(context.observations).toEqual([])
  })

  it('rejects foreign Origins, invalid Fetch Metadata and Host authorities despite a valid Session', async () => {
    const context = await fixture()
    for (const headers of [{ origin: 'https://foreign.example' }, { 'sec-fetch-site': 'invalid' }, { host: 'foreign.example' }]) {
      expect((await context.get(directoryRoute(context.root), headers)).status).toBe(403)
    }
    expect(listWorkspaceDirectories).not.toHaveBeenCalled()
    expect(context.observations).toEqual([])
  })

  it('rejects expired and revoked Sessions without reading directory contents', async () => {
    let current = Date.now()
    const now = vi.spyOn(Date, 'now').mockImplementation(() => current)
    try {
      const context = await fixture()
      current = context.paired.sessionExpiresAt + 1
      expect((await context.get(directoryRoute(context.root))).status).toBe(401)
      current = context.paired.sessionExpiresAt - context.instance.config.sessionTtlMs
      await context.instance.access.revokeDevice(context.paired.deviceId)
      expect((await context.get(directoryRoute(context.root))).status).toBe(401)
      expect(listWorkspaceDirectories).not.toHaveBeenCalled()
      expect(context.observations).toEqual([])
    } finally { now.mockRestore() }
  })

  it('refuses unsupported directory methods and an unauthenticated write', async () => {
    const context = await fixture()
    for (const method of ['HEAD', 'PUT', 'DELETE']) {
      const response = await beginRequest(context.instance.address().port, directoryRoute(context.root), context.headers, method).result
      expect(response.status).toBe(404)
    }
    const write = await beginRequest(context.instance.address().port, directoryRoute(context.root), context.headers, 'POST', JSON.stringify({ path: context.root, name: 'created' })).result
    expect(write.status).toBe(403)
    expect(listWorkspaceDirectories).not.toHaveBeenCalled()
    expect(context.observations).toEqual([])
  })

  it('creates one child directory for an authenticated write', async () => {
    const context = await fixture()
    const headers = { ...context.headers, [CSRF_HEADER]: context.paired.csrfToken, 'content-type': 'application/json' }
    const response = await beginRequest(context.instance.address().port, '/mobile-access/workspace-directories', headers, 'POST', JSON.stringify({ path: context.root, name: 'created' })).result
    expect(response.status, response.body).toBe(201)
    expect(JSON.parse(response.body).path).toBe(join(context.root, 'created'))
    expect((await fs.stat(join(context.root, 'created'))).isDirectory()).toBe(true)
  })

  it('refuses a write that names a path instead of one child', async () => {
    const context = await fixture()
    const headers = { ...context.headers, [CSRF_HEADER]: context.paired.csrfToken, 'content-type': 'application/json' }
    const response = await beginRequest(context.instance.address().port, '/mobile-access/workspace-directories', headers, 'POST', JSON.stringify({ path: context.root, name: 'a/b' })).result
    expect(response.status).toBe(400)
    expect(await fs.stat(join(context.root, 'a')).catch(() => undefined)).toBeUndefined()
  })

  it('withdraws a disconnected caller but retains its slot until physical listing work settles', async () => {
    const context = await fixture({ maxActiveRequests: 1 })
    let started!: () => void
    let cancelled!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const aborted = new Promise<void>(resolve => { cancelled = resolve })
    let release!: () => void
    const physicalWork = new Promise<void>(resolve => { release = resolve })
    vi.mocked(listWorkspaceDirectories).mockImplementationOnce(async (_path, signal) => {
      if (signal === undefined) throw new Error('directory operation has no cancellation owner')
      signal.addEventListener('abort', cancelled, { once: true })
      started()
      await physicalWork
      signal.throwIfAborted()
      throw new Error('cancelled listing unexpectedly remained authorized')
    })
    const request = beginRequest(context.instance.address().port, directoryRoute(context.root), context.headers)
    const rejected = expect(request.result).rejects.toThrow('fixture caller cancelled')
    try {
      await entered
      request.cancel()
      await rejected
      await aborted
      expect((await context.get(directoryRoute(context.root))).status).toBe(429)
    } finally { release() }
    await vi.waitFor(async () => { expect((await context.get(directoryRoute(context.root))).status).toBe(200) })
    expect(context.observations).toEqual([])
  })

  it.each([false, true])('drains a pending directory handle before closing and cleans the listener after close failure=%s', async failClosing => {
    const context = await fixture()
    let entered!: () => void
    let release!: () => void
    const opening = new Promise<void>(resolve => { entered = resolve })
    const physicalWork = new Promise<void>(resolve => { release = resolve })
    let handleClosed = false
    vi.mocked(fs.opendir).mockImplementationOnce(async path => {
      entered()
      await physicalWork
      const level = await native.opendir(path)
      const closeHandle = level.close.bind(level)
      vi.spyOn(level, 'close').mockImplementation(async () => {
        await closeHandle()
        handleClosed = true
        if (failClosing) throw new Error('fixture raw filesystem close detail')
      })
      return level
    })
    const writes = vi.spyOn(ServerResponse.prototype, 'writeHead')
    const port = context.instance.address().port
    const request = beginRequest(port, directoryRoute(context.root), context.headers)
    const disconnected = request.result.catch((error: unknown) => error)
    await opening
    let closeSettled = false
    let closeFailure: unknown
    const closing = context.instance.close().catch((error: unknown) => { closeFailure = error }).finally(() => { closeSettled = true })
    try {
      expect(await disconnected).toBeInstanceOf(Error)
      expect(closeSettled).toBe(false)
      expect(handleClosed).toBe(false)
    } finally { release() }
    await closing
    expect(handleClosed).toBe(true)
    expect(writes).not.toHaveBeenCalled()
    expect(() => context.instance.address()).toThrow('gateway is not listening')
    expect(() => context.instance.devices()).toThrow('access controller is not available')
    await expect(beginRequest(port, directoryRoute(context.root), context.headers).result).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    if (failClosing) {
      expect(closeFailure).toBeInstanceOf(AggregateError)
      expect((closeFailure as AggregateError).errors).toEqual([expect.objectContaining({ status: 500, code: 'directory_cleanup_failed' })])
      expect(String(closeFailure)).not.toContain('fixture raw filesystem close detail')
      context.acknowledgeCloseFailure(closeFailure)
    } else expect(closeFailure).toBeUndefined()
    expect(context.observations).toEqual([])
  })
})
