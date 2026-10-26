/** Self-signed TLS identity for the experimental iroh gateway.
 *
 * Reuses this repository's managed CA path (`managed-setup.ts`) instead of
 * the companion's native TLS manager: the CA persists under the iroh state
 * directory, one leaf carries the identity-derived DNS name, and corrupt or
 * foreign material fails closed rather than regenerating silently. The
 * gateway terminates TLS with this leaf (see `irohGatewayConfig`), so the
 * sidecar only proxies opaque bytes and the app pins the CA from
 * `GET /mobile-access/ca.cer` in Phase 2.
 */
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseAuthority, parseCidr } from './network.js'
import { ensureManagedCa, issueServerCertificate } from './managed-setup.js'
import { assertManagedParents, writeManagedPrivateFile } from './managed-files.js'
import { DEFAULT_IROH_LOCAL_PORT, irohHostname, irohOrigin } from './iroh-origin.js'
import type { FrpIngressCertificate } from './frp-ingress.js'
import type { ResolvedGatewayConfig } from './config.js'

/** Leaf lifetime and renewal headroom, matching the companion's native policy. */
export const IROH_LEAF_VALIDITY_DAYS = 90
export const IROH_LEAF_RENEW_BEFORE_DAYS = 30

/** Private files owned by the iroh TLS identity. */
export interface IrohTlsPaths {
  readonly directory: string
  readonly caCertFile: string
  readonly caKeyFile: string
  readonly certFile: string
  readonly keyFile: string
  readonly statusFile: string
}

/** Signed iroh material plus the fingerprint the app must pin. */
export interface IrohTlsCertificate {
  readonly paths: IrohTlsPaths
  readonly ca: X509Certificate
  readonly leaf: X509Certificate
  readonly caFingerprint: string
  readonly endpointId: string
}

/** Private TLS directory, always a sibling of the remote device file. */
export function irohTlsPaths(stateFile: string, ownedRoot?: string): IrohTlsPaths {
  const directory = join(ownedRoot ?? dirname(stateFile), 'iroh-tls')
  return Object.freeze({
    directory,
    caCertFile: join(directory, 'ca.pem'),
    caKeyFile: join(directory, 'ca-key.pem'),
    certFile: join(directory, 'server.pem'),
    keyFile: join(directory, 'server-key.pem'),
    // Keep the identity marker outside the certificate directory so deleting
    // that directory cannot silently create a replacement CA on next start.
    statusFile: join(dirname(stateFile), 'iroh-identity.json'),
  })
}

async function regularFileExists(file: string): Promise<boolean> {
  try {
    const entry = await lstat(file)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('iroh_tls_file_invalid')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return false
  }
}

interface IrohIdentity {
  readonly endpointId: string
  readonly caFingerprint: string
}

async function readIrohIdentity(file: string): Promise<IrohIdentity | undefined> {
  if (!(await regularFileExists(file))) return undefined
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid identity')
    const record = parsed as Record<string, unknown>
    if (record.version !== 1 || typeof record.endpointId !== 'string' || !/^[a-f0-9]{64}$/u.test(record.endpointId)
      || typeof record.caFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(record.caFingerprint)) {
      throw new Error('invalid identity')
    }
    return Object.freeze({ endpointId: record.endpointId, caFingerprint: record.caFingerprint })
  } catch (error) {
    throw new Error('iroh_tls_ca_invalid', { cause: error })
  }
}

async function writeIrohIdentity(file: string, identity: IrohIdentity, ownedRoot: string): Promise<void> {
  await writeManagedPrivateFile(ownedRoot, file,
    `${JSON.stringify({ version: 1, endpointId: identity.endpointId, caFingerprint: identity.caFingerprint })}\n`, 'iroh_tls')
}

function fingerprintOf(certificate: X509Certificate): string {
  return certificate.fingerprint256.replaceAll(':', '').toLowerCase()
}

function leafCoversEndpoint(leaf: X509Certificate, endpointId: string, now: number): boolean {
  const hostname = irohHostname(endpointId)
  const alternatives = (leaf.subjectAltName ?? '').split(',').map(entry => entry.trim())
  if (!alternatives.includes(`DNS:${hostname}`)) return false
  const notAfter = Date.parse(leaf.validTo)
  if (!Number.isFinite(notAfter)) return false
  // Renew while more than the headroom remains expired-proof: a leaf inside
  // the renewal window is replaced, never served until expiry.
  return notAfter - now > IROH_LEAF_RENEW_BEFORE_DAYS * 24 * 60 * 60_000 && Date.parse(leaf.validFrom) <= now
}

/**
 * Materialize the CA and endpoint leaf the iroh gateway terminates TLS with.
 *
 * A recorded CA fingerprint that no longer matches fails closed: deleting or
 * replacing the CA is an explicit operator act, never an automatic recovery.
 * The endpoint may change under a stable CA; only the leaf is re-issued then.
 */
export async function ensureIrohTls(
  endpointId: string,
  stateFile: string,
  ownedRoot: string,
  now: number = Date.now(),
): Promise<IrohTlsCertificate> {
  if (!/^[a-f0-9]{64}$/u.test(endpointId)) throw new Error('iroh endpoint id must be a lowercase 32-byte public key')
  await assertManagedParents(ownedRoot, stateFile, 'iroh_tls')
  const paths = irohTlsPaths(stateFile, ownedRoot)
  const identity = await readIrohIdentity(paths.statusFile)
  const ca = await ensureManagedCa({
    mode: 'managed',
    caCertFile: paths.caCertFile,
    caKeyFile: paths.caKeyFile,
    certFile: paths.certFile,
    keyFile: paths.keyFile,
  }).catch((error: unknown) => { throw new Error('iroh_tls_ca_invalid', { cause: error }) })
  const caFingerprint = fingerprintOf(ca)
  if (identity !== undefined && identity.caFingerprint !== caFingerprint) throw new Error('iroh_tls_ca_invalid')
  let leaf: X509Certificate | undefined
  if (await regularFileExists(paths.certFile) && await regularFileExists(paths.keyFile)) {
    try {
      const [certPem, keyPem] = await Promise.all([readFile(paths.certFile, 'utf8'), readFile(paths.keyFile, 'utf8')])
      const candidate = new X509Certificate(certPem)
      const key = createPrivateKey(keyPem)
      if (!candidate.ca && candidate.verify(ca.publicKey) && candidate.checkPrivateKey(key) && leafCoversEndpoint(candidate, endpointId, now)) {
        leaf = candidate
      }
    } catch {
      throw new Error('iroh_tls_ca_invalid')
    }
  }
  if (leaf === undefined) {
    await issueServerCertificate(
      { caCertFile: paths.caCertFile, caKeyFile: paths.caKeyFile },
      { commonName: 'DeepSeek Harness Mobile iroh', dnsNames: [irohHostname(endpointId)] },
      { certFile: paths.certFile, keyFile: paths.keyFile },
      IROH_LEAF_VALIDITY_DAYS,
    ).catch((error: unknown) => { throw new Error('iroh_tls_leaf_invalid', { cause: error }) })
    try {
      const [certPem, keyPem] = await Promise.all([readFile(paths.certFile, 'utf8'), readFile(paths.keyFile, 'utf8')])
      const candidate = new X509Certificate(certPem)
      const key = createPrivateKey(keyPem)
      // Newborn material is validated against the real clock: issuance always
      // stamps real now, while `now` may simulate a future renewal decision.
      if (candidate.ca || !candidate.verify(ca.publicKey) || !candidate.checkPrivateKey(key) || !leafCoversEndpoint(candidate, endpointId, Date.now())) {
        throw new Error('iroh_tls_leaf_invalid')
      }
      leaf = candidate
    } catch (error) {
      if (error instanceof Error && (error.message === 'iroh_tls_leaf_invalid' || error.message === 'iroh_tls_ca_invalid')) throw error
      throw new Error('iroh_tls_leaf_invalid', { cause: error })
    }
  }
  await writeIrohIdentity(paths.statusFile, { endpointId, caFingerprint }, ownedRoot)
  return Object.freeze({ paths, ca, leaf, caFingerprint, endpointId })
}

/**
 * Gateway config for the iroh endpoint-pinned entry.
 *
 * Like the self-signed FRP ingress, the gateway itself terminates TLS: the
 * sidecar only forwards raw TCP, so the listener speaks HTTPS with the leaf
 * the iroh CA signed, and the pairing CA is retained so the app can pin it
 * from `GET /mobile-access/ca.cer`. The listener stays on loopback because
 * the public path is the iroh transport, never a direct bind.
 */
export function irohGatewayConfig(
  template: ResolvedGatewayConfig,
  endpointId: string,
  stateFile: string,
  tls: Pick<FrpIngressCertificate, 'paths' | 'caFingerprint'>,
  listenPort = 0,
): ResolvedGatewayConfig {
  const { pairingCaFile: _templateCaFile, ...shared } = template
  const authority = new URL(irohOrigin(endpointId, DEFAULT_IROH_LOCAL_PORT)).host
  return Object.freeze({
    ...shared,
    listenHost: '127.0.0.1',
    listenPort,
    authorities: Object.freeze([parseAuthority(authority)]),
    // Only the sidecar originates connections, from the same computer.
    allowedCidrs: Object.freeze([parseCidr('127.0.0.0/8')]),
    stateFile,
    // The app validates `instance` against the CA it pins, so this channel
    // uses the CA fingerprint, not the plugin-wide installation id.
    instanceId: tls.caFingerprint,
    pairingCaFile: tls.paths.caCertFile,
    tls: Object.freeze({ mode: 'provided', certFile: tls.paths.certFile, keyFile: tls.paths.keyFile }),
    publicTls: true,
    discovery: false,
    // Pairing windows on this channel default to five minutes to match the
    // controller; the gateway rejects anything above its own ceiling.
    pairingTtlMs: 300_000,
  })
}
