import type { MobilePushApiAdapter } from './client.js'
import type { PushEnrollment, PushEnrollmentResult, PushTarget } from './contracts.js'

export interface MobilePushBrowserApi extends MobilePushApiAdapter {
  resolve(reference: string): Promise<PushTarget | undefined>
}
export type MobilePushRequest = (path: string, init?: RequestInit) => Promise<Response>

function apiError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code === 'stale_generation' ? 'Push settings changed elsewhere.' : 'Push request failed.'), { code })
}
async function check(response: Response): Promise<void> {
  if (response.ok) return
  let code = 'request_failed'
  if (response.status === 409) {
    try {
      const body = await response.json() as { readonly error?: unknown }
      if (body?.error === 'stale_generation') code = 'stale_generation'
    } catch { /* A malformed error response is generic and never echoed. */ }
  }
  throw apiError(code)
}
async function json<T>(response: Response): Promise<T> {
  try { return await response.json() as T }
  catch { throw apiError('request_failed') }
}
async function requestOnce(request: MobilePushRequest, path: string, init: RequestInit): Promise<Response> {
  try { return await request(path, init) }
  catch { throw apiError('request_failed') }
}
function postJson(request: MobilePushRequest, path: string, value: unknown): Promise<Response> {
  return requestOnce(request, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
}

/** Build the direct authenticated browser API over mobileRequest (single-shot, same-origin, CSRF-aware). */
export function createMobilePushBrowserApi(request: MobilePushRequest): MobilePushBrowserApi {
  return {
    async getConfig(installationId) {
      const response = await requestOnce(request, `/mobile-access/push/config?installationId=${encodeURIComponent(installationId)}`, { method: 'GET' })
      await check(response)
      return json(response)
    },
    async enroll(value: PushEnrollment) {
      const response = await postJson(request, '/mobile-access/push/subscription', value)
      await check(response)
      return json<PushEnrollmentResult>(response)
    },
    async updatePreferences(value) {
      const response = await postJson(request, '/mobile-access/push/preferences', value)
      await check(response)
    },
    async disable(value) {
      const response = await postJson(request, '/mobile-access/push/disable', value)
      await check(response)
    },
    async sendTest(value) {
      const response = await postJson(request, '/mobile-access/push/test', { installationId: value.installationId })
      // Only the Test adapter surfaces the whitelisted rate-limit code; every other error stays generic.
      if (response.status === 429) throw apiError('rate_limited')
      await check(response)
    },
    async resolve(reference) {
      const response = await postJson(request, '/mobile-access/push/resolve', { reference })
      await check(response)
      const value = await json<unknown>(response)
      if (typeof value !== 'object' || value === null || !('sessionId' in value)
        || typeof value.sessionId !== 'string' || value.sessionId === ''
        || !('interaction' in value) || (value.interaction !== 'current' && value.interaction !== 'resolved')) return undefined
      return value as PushTarget
    },
  }
}
