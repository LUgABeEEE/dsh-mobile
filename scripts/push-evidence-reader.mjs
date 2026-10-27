import { readFile } from 'node:fs/promises'

/**
 * Strict evidence reader shared by the push smoke lanes.
 * ENOENT (not written yet) resolves undefined; a file that exists but does not parse REJECTS —
 * polling callers tolerate SyntaxError transiently (a live writer may be mid-write), while
 * post-exit and absence checks must fail loudly on malformed evidence instead of reading as absent.
 */
export async function readTransportEvidence(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}
