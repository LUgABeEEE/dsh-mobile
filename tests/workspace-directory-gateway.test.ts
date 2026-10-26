import { request as requestHttp } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { CSRF_HEADER, SESSION_COOKIE } from '../src/http-security.js'
import { MemoryDeviceStore } from '../src/storage.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-directory-gateway-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const parsed = parseGatewayConfig({
    listenHost: '127.0.0.1', listenPort: 0, tls: { mode: 'disabled' },
    upstreamOrigin: 'http://127.0.0.1:1', publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'], stateFile: join(root, 'devices.json'),
  })
  const gateway = new MobileAccessGateway(Object.freeze({ ...parsed, discovery: false }), new MemoryDeviceStore())
  cleanups.push(() => gateway.close())
  await gateway.start()
  const pairing = await gateway.access.openPairing()
  const credential = await gateway.access.pair('fixture', pairing.token, 'Folder QA')
  const origin = gateway.address().origin
  const request = (method: 'GET' | 'POST', body?: unknown, override: Record<string, string | undefined> = {}): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const headers: Record<string, string | number | undefined> = {
      host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin',
      cookie: `${SESSION_COOKIE}=${credential.sessionToken}`, [CSRF_HEADER]: credential.csrfToken,
      ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }), ...override,
    }
    for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key]
    const outgoing = requestHttp({ host: '127.0.0.1', port: gateway.address().port, path: '/mobile-access/workspace-directories', method, agent: false, headers }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      response.once('error', reject)
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.once('error', reject)
    outgoing.end(data)
  })
  return { root, gateway, request }
}

describe('authenticated workspace directory writes', () => {
  it('creates one child through POST and leaves duplicate names unchanged', async () => {
    const value = await fixture()
    const result = await value.request('POST', { path: value.root, name: '新项目' })
    expect(result.status).toBe(201)
    expect(JSON.parse(result.body)).toEqual({ path: join(value.root, '新项目') })
    expect((await stat(join(value.root, '新项目'))).isDirectory()).toBe(true)
    const duplicate = await value.request('POST', { path: value.root, name: '新项目' })
    expect(duplicate.status).toBe(409)
    expect(JSON.parse(duplicate.body)).toEqual({ error: 'directory_exists' })
  })

  it.each([{}, { path: null, name: 'child' }, { path: 1, name: 'child' }, { path: '', name: 'child' }, { path: false, name: 'child' }, { path: '/parent', name: 1 }])('rejects malformed input instead of silently choosing the home directory: %j', async body => {
    const value = await fixture()
    const result = await value.request('POST', body)
    expect(result.status).toBe(400)
    expect(JSON.parse(result.body)).toEqual({ error: 'directory_create_invalid' })
  })

  it('refuses traversal without creating any intermediate directory', async () => {
    const value = await fixture()
    const result = await value.request('POST', { path: value.root, name: 'one/two' })
    expect(result.status).toBe(400)
    await expect(stat(join(value.root, 'one'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires a valid paired session before a write', async () => {
    const value = await fixture()
    expect((await value.request('POST', { path: value.root, name: 'child' }, { cookie: undefined })).status).toBe(401)
    await expect(stat(join(value.root, 'child'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires CSRF and the exact admitted Origin even for an authenticated device', async () => {
    const value = await fixture()
    expect((await value.request('POST', { path: value.root, name: 'child' }, { [CSRF_HEADER]: undefined })).status).toBe(403)
    expect((await value.request('POST', { path: value.root, name: 'child' }, { origin: 'https://foreign.example' })).status).toBe(403)
    await expect(stat(join(value.root, 'child'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('bounds the JSON request body before directory creation', async () => {
    const value = await fixture()
    expect((await value.request('POST', { path: value.root, name: 'child', excess: 'x'.repeat(70_000) })).status).toBe(413)
    await expect(stat(join(value.root, 'child'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
