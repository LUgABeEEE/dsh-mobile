/**
 * Owned-child OUTER fail-fast network tripwire for the packed push smoke (test fixture; not a product file).
 *
 * Hostname lookups and non-loopback TCP/TLS requests are rejected. Literal-IP lookup is local
 * address parsing, so it remains available for UDP wildcard/broadcast binding; it does not
 * authorize a connection to that address. Evidence paths must be absolute on the current OS.
 *
 * Loaded through NODE_OPTIONS --import BEFORE the Task8 transport helper, so the helper's
 * "original" references point at this tripwire. Any DNS or connect attempt that the helper does not
 * deliberately serve throws here instead of reaching the network.
 *
 * Hardening (unchanged from the audited v2/v3):
 * - Connect-argument classification is FAIL-CLOSED. Node normalizes an array first argument
 *   (`net.connect([port, host])`, `Socket#connect([[port, host], cb])`) and tls additionally
 *   rewrites it into a numeric-keyed object (`{0: port, 1: host, ...}`). Both shapes are parsed
 *   explicitly; anything not positively identified as loopback/local is denied. "No host" is no
 *   longer treated as loopback.
 * - Request-options classification denies opaque targets (truthy `agent`, `createConnection`).
 * - Every delegation to the captured original is counted, so a caller can prove that a denied shape
 *   never reached the real function (no socket, no DNS).
 * - Decisions are recorded as an auditable trace, not just counters.
 * - A call whose options carry BOTH `host` and `hostname` naming different hosts is denied as
 *   `conflicting-host-field`, because `net`/`tls` consume `options.host` while `http`/`https`
 *   prefer `options.hostname`; resolving that disagreement in either direction is unsafe.
 *
 * Scope decisions (unchanged): loopback and unix sockets are allowed and recorded (not egress);
 * UDP is recorded and only destination port 53 is blocked (mDNS is a legitimate local protocol,
 * port 53 is a DNS egress path). This is JS-level defense in depth over the patched APIs, not a
 * native/kernel sandbox.
 */
import { writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import dns from 'node:dns'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import dgram from 'node:dgram'
import { syncBuiltinESMExports } from 'node:module'
// Force the builtin ESM facades to exist BEFORE patching, so the later syncBuiltinESMExports()
// calls are the only thing that can make the production named imports live.
import { lookup as promiseLookupFacadeProbe } from 'node:dns/promises'
import { request as httpsRequestFacadeProbe } from 'node:https'

const evidencePath = process.env.DSH_GUARD_TRIPWIRE_EVIDENCE
if (typeof evidencePath !== 'string' || !isAbsolute(evidencePath)) {
  throw new Error('guard_tripwire_not_configured')
}

const MAX_TRACE = 40
const state = {
  artifact: 'push-integration-network-guard',
  version: 3,
  processId: process.pid,
  helperMarkerPresentAtTripwireLoad: globalThis[Symbol.for('dsh.mobile.push.integration.transport')] !== undefined,
  dnsBlocked: 0,
  resolveBlocked: 0,
  connectBlocked: 0,
  httpBlocked: 0,
  fetchBlocked: 0,
  udpDnsBlocked: 0,
  loopbackAllowed: 0,
  udpObserved: 0,
  blocked: [],
  trace: [],
  delegatedOriginals: {
    dnsLookup: 0, dnsPromisesLookup: 0, netConnect: 0, netCreateConnection: 0, socketConnect: 0,
    tlsConnect: 0, tlsCreateConnection: 0, httpRequest: 0, httpGet: 0, httpsRequest: 0, httpsGet: 0, fetch: 0,
  },
  facadeProbesPresent: typeof promiseLookupFacadeProbe === 'function' && typeof httpsRequestFacadeProbe === 'function',
}
const save = () => writeFileSync(evidencePath, JSON.stringify(state), { mode: 0o600 })
const trace = entry => { state.trace.push(entry); if (state.trace.length > MAX_TRACE) state.trace.shift() }

const isLoopbackName = host => {
  const value = String(host ?? '').toLowerCase()
  if (value === '') return false
  return value === 'localhost' || value.endsWith('.localhost')
    || value === '::1' || value === '0:0:0:0:0:0:0:1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(value)
}

const block = (kind, api, host, port) => {
  state[kind]++
  state.blocked.push({ api, host: host === undefined || host === null ? '<unresolved>' : String(host), port: port === undefined || port === null ? null : port })
  save()
  throw new Error(`guard_tripwire_blocked_${api}`)
}
const allow = (reason, api, host, port) => {
  state.loopbackAllowed++
  trace({ api, decision: 'allow', reason, host: host ?? null, port: port ?? null })
  save()
}
const deny = (reason, kind, api, host, port) => {
  trace({ api, decision: 'deny', reason, host: host ?? null, port: port ?? null })
  block(kind, api, host, port)
}
const delegate = api => { state.delegatedOriginals[api]++; save() }

/**
 * Normalize Node connect() arguments into a positive identification.
 * Returns { shape: 'tcp', host } | { shape: 'local' } | { shape: 'default-localhost' } | { shape: 'unknown' }.
 */
/**
 * Reconcile the two host fields Node consumers disagree about: `net`/`tls` consume `options.host`
 * while `http`/`https` prefer `options.hostname`. When both are present they must name the same
 * host (after stripping an embedded `:port`); disagreement is a conflicting-host-field and is
 * denied rather than resolved in either direction.
 */
function reconcileHostFields(record) {
  const rawHost = typeof record.host === 'string' ? record.host : undefined
  const rawHostname = typeof record.hostname === 'string' ? record.hostname : undefined
  const normalize = value => {
    if (value === undefined) return undefined
    if (/:\d+$/u.test(value)) { try { return new URL(`http://${value}`).hostname.toLowerCase() } catch { return value.toLowerCase() } }
    return value.toLowerCase()
  }
  const host = normalize(rawHost)
  const hostname = normalize(rawHostname)
  if (host !== undefined && hostname !== undefined && host !== hostname) {
    return { conflict: true, host: `${rawHostname} != ${rawHost}` }
  }
  return { host: hostname ?? host }
}

function classifyConnectArguments(rawArgs) {
  let args = rawArgs
  if (Array.isArray(args[0])) args = args[0] // Node: ArrayIsArray(args[0]) -> args = args[0]
  const first = args[0]
  if (Array.isArray(first)) return classifyConnectArguments(first)
  if (first !== null && typeof first === 'object') {
    const fields = reconcileHostFields(first)
    if (fields.conflict === true) return { shape: 'conflict', host: fields.host, port: first.port }
    if (fields.host !== undefined) return { shape: 'tcp', host: fields.host, port: first.port }
    if (typeof first.path === 'string' || typeof first.socketPath === 'string') return { shape: 'local' }
    // tls normalizes an array argument into a numeric-keyed object ({0: port, 1: host, ...}).
    if (typeof first[0] === 'number' && typeof first[1] === 'string') return { shape: 'tcp', host: first[1], port: first[0] }
    if (typeof first[0] === 'string' && !/^\d+$/u.test(first[0])) return { shape: 'local' }
    if (typeof first.port === 'number') return { shape: 'default-localhost', port: first.port }
    return { shape: 'unknown' }
  }
  if (typeof first === 'number') {
    if (typeof args[1] === 'string') return { shape: 'tcp', host: args[1], port: first }
    return { shape: 'default-localhost', port: first }
  }
  if (typeof first === 'string') {
    if (/^\d+$/u.test(first)) {
      if (typeof args[1] === 'string') return { shape: 'tcp', host: args[1], port: Number(first) }
      return { shape: 'default-localhost', port: Number(first) }
    }
    return { shape: 'local' } // unix socket path
  }
  return { shape: 'unknown' }
}

/** Normalize http/https request input into a positive identification. */
function classifyRequestInput(input) {
  if (input instanceof URL) return { shape: 'tcp', host: input.hostname, port: input.port }
  if (typeof input === 'string') {
    try { const url = new URL(input); return { shape: 'tcp', host: url.hostname, port: url.port } } catch { return { shape: 'unknown' } }
  }
  if (input !== null && typeof input === 'object') {
    if (typeof input.url === 'string') { // Request-like object
      try { const url = new URL(input.url); return { shape: 'tcp', host: url.hostname, port: url.port } } catch { return { shape: 'unknown' } }
    }
    const fields = reconcileHostFields(input)
    if (fields.conflict === true) return { shape: 'conflict', host: fields.host, port: input.port }
    if (fields.host !== undefined) return { shape: 'tcp', host: fields.host, port: input.port }
    if (typeof input.socketPath === 'string') return { shape: 'local' }
    if (typeof input.createConnection === 'function') return { shape: 'unknown' } // opaque target
    if (input.agent !== undefined && input.agent !== false && input.agent !== null) return { shape: 'unknown' } // opaque agent
    return { shape: 'default-localhost' }
  }
  return { shape: 'unknown' }
}

function wrapRequest(moduleObject, name, api, kind, counter) {
  const original = moduleObject[name]
  moduleObject[name] = function (...args) {
    const classified = classifyRequestInput(args[0])
    if (classified.shape === 'conflict') deny('conflicting-host-field', kind, api, classified.host, classified.port)
    if (classified.shape === 'unknown') deny('unidentified-request-target', kind, api, classified.host, classified.port)
    if (classified.shape === 'tcp' && !isLoopbackName(classified.host)) deny('non-loopback-host', kind, api, classified.host, classified.port)
    allow(classified.shape, api, classified.host, classified.port)
    delegate(counter)
    return Reflect.apply(original, this, args)
  }
}

function wrapConnect(moduleObject, name, api, kind, counter) {
  const original = moduleObject[name]
  moduleObject[name] = function (...args) {
    const classified = classifyConnectArguments(args)
    if (classified.shape === 'conflict') deny('conflicting-host-field', kind, api, classified.host, classified.port)
    if (classified.shape === 'unknown') deny('unidentified-connect-target', kind, api, classified.host, classified.port)
    if (classified.shape === 'tcp' && !isLoopbackName(classified.host)) deny('non-loopback-host', kind, api, classified.host, classified.port)
    allow(classified.shape, api, classified.host, classified.port)
    delegate(counter)
    return Reflect.apply(original, this, args)
  }
}

function wrapDnsLookup(moduleObject, name, api, counter) {
  const original = moduleObject[name]
  moduleObject[name] = function (...args) {
    const host = args[0]
    if (isLoopbackName(host)) { allow('loopback-host', api, host, null); delegate(counter); return Reflect.apply(original, this, args) }
    // Node returns literal IP addresses without DNS I/O. UDP bind uses this path
    // for its wildcard/broadcast addresses; TCP/TLS destinations remain guarded.
    if (typeof host === 'string' && net.isIP(host) !== 0) { allow('literal-address-no-dns', api, host, null); delegate(counter); return Reflect.apply(original, this, args) }
    deny(typeof host === 'string' && host !== '' ? 'non-loopback-host' : 'unidentified-host', 'dnsBlocked', api, host, null)
  }
}

// ---- DNS -------------------------------------------------------------------
wrapDnsLookup(dns, 'lookup', 'dns_lookup', 'dnsLookup')
wrapDnsLookup(dns.promises, 'lookup', 'dns_promises_lookup', 'dnsPromisesLookup')
const RESOLVE_FAMILY = /^resolve(?:4|6|Any|Caa|Cname|Mx|Naptr|Ns|Ptr|Soa|Srv|Txt)?$/u
for (const name of Object.getOwnPropertyNames(dns)) {
  if (RESOLVE_FAMILY.test(name)) {
    dns[name] = function (...args) {
      state.resolveBlocked++
      block('resolveBlocked', `dns_${name}`, args[0], null)
    }
  }
}
for (const name of Object.getOwnPropertyNames(dns.promises)) {
  if (RESOLVE_FAMILY.test(name)) {
    dns.promises[name] = function (...args) {
      state.resolveBlocked++
      block('resolveBlocked', `dns_promises_${name}`, args[0], null)
    }
  }
}
for (const name of Object.getOwnPropertyNames(dns.promises.Resolver.prototype)) {
  if (RESOLVE_FAMILY.test(name)) {
    dns.promises.Resolver.prototype[name] = function (...args) {
      state.resolveBlocked++
      block('resolveBlocked', `dns_promises_Resolver_${name}`, args[0], null)
    }
  }
}

// ---- TCP / TLS / HTTP ------------------------------------------------------
wrapConnect(net, 'connect', 'net_connect', 'connectBlocked', 'netConnect')
wrapConnect(net, 'createConnection', 'net_createConnection', 'connectBlocked', 'netCreateConnection')
wrapConnect(net.Socket.prototype, 'connect', 'net_Socket_connect', 'connectBlocked', 'socketConnect')
wrapConnect(tls, 'connect', 'tls_connect', 'connectBlocked', 'tlsConnect')
wrapConnect(tls, 'createConnection', 'tls_createConnection', 'connectBlocked', 'tlsCreateConnection')
wrapRequest(http, 'request', 'http_request', 'httpBlocked', 'httpRequest')
wrapRequest(http, 'get', 'http_get', 'httpBlocked', 'httpGet')
wrapRequest(https, 'request', 'https_request', 'httpBlocked', 'httpsRequest')
wrapRequest(https, 'get', 'https_get', 'httpBlocked', 'httpsGet')

const originalFetch = globalThis.fetch
globalThis.fetch = function (input, init) {
  const classified = classifyRequestInput(input)
  if (classified.shape === 'unknown') deny('unidentified-fetch-target', 'fetchBlocked', 'fetch', classified.host, classified.port)
  if (classified.shape === 'tcp' && !isLoopbackName(classified.host)) deny('non-loopback-host', 'fetchBlocked', 'fetch', classified.host, classified.port)
  allow(classified.shape, 'fetch', classified.host, classified.port)
  delegate('fetch')
  return Reflect.apply(originalFetch, this, [input, init])
}

// ---- UDP: record, block DNS port only --------------------------------------
const originalCreateSocket = dgram.createSocket
dgram.createSocket = function (...args) {
  const socket = Reflect.apply(originalCreateSocket, this, args)
  const originalSend = socket.send
  socket.send = function (...sendArgs) {
    const port = typeof sendArgs[1] === 'number' ? sendArgs[1] : (typeof sendArgs[3] === 'number' ? sendArgs[3] : undefined)
    state.udpObserved++
    if (port === 53) { state.udpDnsBlocked++; save(); throw new Error('guard_tripwire_blocked_udp_dns') }
    save()
    return Reflect.apply(originalSend, this, sendArgs)
  }
  return socket
}

const tripwireLookup = dns.promises.lookup
const tripwireHttpsRequest = https.request
syncBuiltinESMExports()
// Recorded, not thrown: the tripwire's own coverage does not depend on facade sync (it patches the
// shared CJS objects and the socket layer), and the caller needs this datum even when it fails.
state.facadeSyncEffective = dns.promises.lookup === promiseLookupFacadeProbe && https.request === httpsRequestFacadeProbe
state.cjsPatchVisible = dns.promises.lookup === tripwireLookup && https.request === tripwireHttpsRequest
globalThis[Symbol.for('dsh.mobile.push.guard.tripwire')] = Object.freeze({ version: 3 })
save()
