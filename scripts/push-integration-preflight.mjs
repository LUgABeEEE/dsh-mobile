/**
 * Owned-child PRE-MAIN hard attestation preflight for the packed push smoke (test fixture; not a product file).
 *
 * Promoted without behavioral change from the independently audited resume-guard bootstrap-assert
 * (sha256 6e2fa051bd2c9a5bdc76addbf3ba7c68dc6945360198e4cc022d5c5ff99c3795d): checks, markers,
 * error strings and evidence shape are identical; only the artifact name and this header differ.
 *
 * Loaded LAST in the preload chain — `--import=network-guard --import=transport --import=preflight`
 * — so it runs after both guards are installed and, because `--import` modules are awaited before
 * the main entry, it aborts the child BEFORE any DSH/plugin module is imported or executed if the
 * guard is not demonstrably in force.
 *
 * It asserts IDENTITY, not merely a marker and not merely a recorded flag:
 *   1. both guard markers exist (ordering);
 *   2. the module-scope ESM binding `lookup` from `node:dns/promises` IS the same function object as
 *      the patched `dns.promises.lookup` property — this is checked BEFORE any call, so a runtime
 *      where syncBuiltinESMExports() does not publish the patch aborts without emitting any query;
 *   3. that same function behaves as the helper's fixture (owned nonce host -> 17.0.0.1) rather than
 *      as the tripwire's blocker or the real resolver;
 *   4. `https.request` rejects an unowned Apple URL with the helper's error, not the tripwire's.
 *
 * Any failure throws here, which kills the child at preload time. Every result is written to
 * DSH_GUARD_BOOTSTRAP_EVIDENCE so the run has an attestation record as well as an exit code.
 * The deliberate probes below add dnsOwned+1 / appleRequestsBlocked+2 to the helper evidence;
 * consumers must read counters as deltas from this baseline, never as absolute feature counts.
 *
 * No network can result from this module: step 2 performs no I/O, and steps 3-4 can only be served
 * by the guards (the tripwire throws instead of delegating, the helper answers synthetically).
 */
import { writeFileSync } from 'node:fs'
import dns from 'node:dns'
import https from 'node:https'
import { lookup as promiseLookupBinding } from 'node:dns/promises'

const evidencePath = process.env.DSH_GUARD_BOOTSTRAP_EVIDENCE
if (typeof evidencePath !== 'string' || !evidencePath.startsWith('/')) {
  throw new Error('guard_bootstrap_not_configured')
}
const nonce = process.env.DSH_PUSH_TRANSPORT_NONCE
if (typeof nonce !== 'string' || !/^[a-f0-9]{48}$/u.test(nonce)) throw new Error('guard_bootstrap_nonce_not_configured')
const ownedHost = `n-${nonce}.push.apple.com`
const unownedHost = `n-${(nonce[0] === 'a' ? 'b' : 'a') + nonce.slice(1)}.push.apple.com`
const ownedEndpoint = `https://${ownedHost}/${nonce}`
const unownedEndpoint = `https://${unownedHost}/${nonce}`

const record = { artifact: 'push-integration-preflight', version: 1, processId: process.pid, checks: [], failure: null }
const save = () => writeFileSync(evidencePath, JSON.stringify(record, null, 2), { mode: 0o600 })
const fail = message => {
  record.failure = message
  save()
  throw new Error(`guard_bootstrap_attestation_failed: ${message}`)
}
const pass = name => { record.checks.push(name); save() }

try {
  // 1. ordering / presence
  if (globalThis[Symbol.for('dsh.mobile.push.guard.tripwire')]?.version !== 3) fail('outer tripwire marker absent or not v3')
  if (globalThis[Symbol.for('dsh.mobile.push.integration.transport')] === undefined) fail('Task8 helper marker absent')
  pass('tripwire and helper preloaded before the bootstrap')

  // 2. IDENTITY, before any call — a stale binding is detected here without emitting a query.
  record.bindingIdentity = {
    namedBindingIsCjsProperty: promiseLookupBinding === dns.promises.lookup,
    cjsLookupName: typeof dns.promises.lookup === 'function' ? (dns.promises.lookup.name || '<anonymous>') : '<not-a-function>',
  }
  save()
  if (!record.bindingIdentity.namedBindingIsCjsProperty) {
    fail('ESM binding node:dns/promises lookup is not the patched dns.promises.lookup property (stale binding)')
  }
  pass('named node:dns/promises lookup binding is identical to the patched CJS property (no I/O performed)')

  // 3. behavioural identification: the shared function must be the helper's fixture, not the
  //    tripwire blocker (which throws) and not the real resolver (which would answer differently).
  const answer = await promiseLookupBinding(ownedHost, { all: true, verbatim: true })
  record.ownedAnswer = answer
  save()
  if (JSON.stringify(answer) !== JSON.stringify([{ address: '17.0.0.1', family: 4 }])) {
    fail(`owned nonce host did not resolve to the controlled fixture answer: ${JSON.stringify(answer)}`)
  }
  pass('production binding kind returns only the controlled fixture answer for the owned nonce host')

  let unownedError
  try { await promiseLookupBinding(unownedHost, { all: true }) } catch (error) { unownedError = error }
  record.unownedDnsError = unownedError?.message ?? null
  save()
  if (unownedError?.message !== 'push_fixture_external_apple_dns_blocked') {
    fail(`unowned Apple DNS did not fail closed in the helper: ${record.unownedDnsError}`)
  }
  pass('unowned Apple DNS fails closed inside the helper, not in the tripwire and not on the network')

  // 4. HTTPS binding actually used by production (`https.request` property on the default export).
  const options = {
    method: 'POST', headers: {}, agent: false, servername: unownedHost, rejectUnauthorized: true,
    lookup: (_host, _options, callback) => callback(null, '17.0.0.1', 4), timeout: 10_000,
  }
  let unownedHttpsError
  try { https.request(new URL(unownedEndpoint), options) } catch (error) { unownedHttpsError = error }
  record.unownedHttpsError = unownedHttpsError?.message ?? null
  save()
  if (unownedHttpsError?.message !== 'push_fixture_external_apple_https_blocked') {
    fail(`unowned Apple HTTPS did not fail closed in the helper: ${record.unownedHttpsError}`)
  }
  pass('unowned Apple HTTPS fails closed inside the helper before any socket is created')

  record.attested = true
  record.attestedAt = new Date().toISOString()
  save()
  globalThis[Symbol.for('dsh.mobile.push.guard.bootstrap')] = Object.freeze({ version: 1, attested: true })
} catch (error) {
  if (record.failure === null) { record.failure = `unexpected: ${error?.message ?? error}`; save() }
  throw error
}
