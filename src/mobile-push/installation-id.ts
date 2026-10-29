/** Browser-safe installation-id validation shared by the browser controller and the Gateway. */

const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/** True only for a UUID-shaped installation id with an allowed version and variant nibble. */
export function isPushInstallationId(value: unknown): value is string {
  return typeof value === 'string' && INSTALLATION_ID.test(value)
}
