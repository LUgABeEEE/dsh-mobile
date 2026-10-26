/** Identity-derived browser origins for the raw TLS-over-iroh carrier.
 *
 * Ported from the independent `dsh-mobile-iroh` companion's origin contract.
 * The local port is a deployment choice; changing it changes browser storage
 * identity, so the selected port is part of every persisted record.
 */
export const DEFAULT_IROH_LOCAL_PORT = 25443

const ENDPOINT_ID_PATTERN = /^[a-f0-9]{64}$/u

function checkEndpointId(endpointId: string): void {
  if (typeof endpointId !== 'string' || !ENDPOINT_ID_PATTERN.test(endpointId)) {
    throw new Error('iroh endpoint id must be a lowercase 32-byte public key')
  }
}

function checkLocalPort(localPort: number): void {
  if (!Number.isSafeInteger(localPort) || localPort < 1024 || localPort > 65535) {
    throw new Error('iroh local port must be from 1024 through 65535')
  }
}

/** Keep the full endpoint key in DNS-safe labels rather than a colliding port hash. */
export function irohHostname(endpointId: string): string {
  checkEndpointId(endpointId)
  return `${endpointId.slice(0, 32)}.${endpointId.slice(32)}.iroh.localhost`
}

/** HTTPS origin the phone's local transport listener serves for one endpoint. */
export function irohOrigin(endpointId: string, localPort: number = DEFAULT_IROH_LOCAL_PORT): string {
  checkLocalPort(localPort)
  return `https://${irohHostname(endpointId)}:${localPort}`
}

/** Reject an Origin that does not belong to the selected cryptographic host identity. */
export function validateIrohOrigin(value: unknown, endpointId: string, localPort: number = DEFAULT_IROH_LOCAL_PORT): string {
  const expected = irohOrigin(endpointId, localPort)
  if (value !== expected) throw new Error('iroh origin does not match the selected endpoint and local port')
  return expected
}
