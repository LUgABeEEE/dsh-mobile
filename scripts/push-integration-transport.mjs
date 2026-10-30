/**
 * Owned-child preload for the packed push smoke only.
 * It returns synthetic DNS/HTTPS responses for the single nonce-owned Apple endpoint,
 * rejects every other Apple Push hostname before network access, and passes unrelated
 * Node DNS/HTTPS traffic through unchanged. Never load this in the main test process.
 */
import { writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import dns from 'node:dns'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'

const nonce = process.env.DSH_PUSH_TRANSPORT_NONCE
const evidencePath = process.env.DSH_PUSH_TRANSPORT_EVIDENCE
if (typeof nonce !== 'string' || !/^[a-f0-9]{48}$/u.test(nonce)
  || typeof evidencePath !== 'string' || !isAbsolute(evidencePath)) {
  throw new Error('push_transport_fixture_not_configured')
}

const expectedHost = `n-${nonce}.push.apple.com`
const expectedPath = `/${nonce}`
const state = { processId: process.pid, dnsOwned: 0, requestsAccepted: 0, appleRequestsBlocked: 0, bodyBytes: 0, bodySha256: undefined, bodyBase64: undefined }
const save = () => writeFileSync(evidencePath, JSON.stringify(state), { mode: 0o600 })
const originalLookup = dns.promises.lookup
const fakeLookup = async (hostname, options) => {
  const host = String(hostname).toLowerCase()
  if (host === expectedHost) {
    state.dnsOwned++
    save()
    const addresses = [{ address: '17.0.0.1', family: 4 }]
    return options?.all === true ? addresses : addresses[0]
  }
  if (host === 'push.apple.com' || host.endsWith('.push.apple.com')) {
    state.appleRequestsBlocked++
    save()
    throw new Error('push_fixture_external_apple_dns_blocked')
  }
  return originalLookup(hostname, options)
}
dns.promises.lookup = fakeLookup

class FixtureResponse extends Readable {
  statusCode = 201
  headers = Object.freeze({ 'content-length': '0' })
  _read() { this.push(null) }
}

class FixtureRequest extends EventEmitter {
  destroyed = false
  constructor(callback) { super(); this.callback = callback }
  end(body) {
    if (this.destroyed) return this
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '')
    state.requestsAccepted++
    state.bodyBytes = bytes.length
    state.bodySha256 = createHash('sha256').update(bytes).digest('hex')
    state.bodyBase64 = bytes.toString('base64')
    save()
    queueMicrotask(() => {
      if (this.destroyed) return
      const response = new FixtureResponse()
      this.emit('response', response)
      this.callback?.(response)
    })
    return this
  }
  destroy(error) {
    this.destroyed = true
    if (error) this.emit('error', error)
    return this
  }
}

const originalRequest = https.request
const fixtureRequest = function (...args) {
  let url
  const [input, second] = args
  if (input instanceof URL) url = input
  else if (typeof input === 'string') {
    try { url = new URL(input) } catch { url = undefined }
  } else if (input && typeof input === 'object') {
    try {
      const protocol = input.protocol ?? 'https:'
      const host = input.hostname ?? input.host
      if (typeof host === 'string') url = new URL(`${protocol}//${host}${input.path ?? '/'}`)
    } catch { url = undefined }
  }
  const hostname = url?.hostname.toLowerCase()
  if (hostname === 'push.apple.com' || hostname?.endsWith('.push.apple.com')) {
    const options = input instanceof URL || typeof input === 'string' ? second : input
    const correct = hostname === expectedHost && url.protocol === 'https:' && url.pathname === expectedPath
      && url.search === '' && url.username === '' && url.password === ''
      && options?.servername === expectedHost && options?.method === 'POST'
      && options?.rejectUnauthorized === true && options?.agent === false
    if (!correct) {
      state.appleRequestsBlocked++
      save()
      throw new Error('push_fixture_external_apple_https_blocked')
    }
    return new FixtureRequest(args[2])
  }
  return Reflect.apply(originalRequest, this, args)
}
https.request = fixtureRequest
syncBuiltinESMExports()
if (dns.promises.lookup !== fakeLookup || https.request !== fixtureRequest) {
  throw new Error('push_transport_fixture_patch_not_active')
}

globalThis[Symbol.for('dsh.mobile.push.integration.transport')] = Object.freeze({ version: 1 })
save()
