/**
 * Bounded API latency samples for diagnosing slow mobile requests.
 *
 * A sample never carries a query string, request body, header or credential.
 * The path collapses to its first `/api/` segment, so the recorded key set is
 * bounded by route names rather than by session or turn identifiers, and the
 * same report stays comparable across devices and releases.
 */

/** Only methods with a fixed spelling are recorded; anything else collapses. */
const BOUNDED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])

/** Requests below this budget are ordinary traffic and stay out of the log. */
export const API_LATENCY_MIN_MS = 3_000

const LOG_INTERVAL_MS = 30_000
const ROUTE_SEGMENT = /^[a-z][a-z0-9-]{0,31}$/iu

/** One sampled API wait; `durationMs` spans the client's request to response close. */
export type ApiLatencyEntry = {
  readonly kind: 'api'
  readonly method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OTHER'
  readonly path: string
  readonly status: number
  readonly durationMs: number
} & { readonly suppressed?: number }

/**
 * Reduce a request target to a bounded diagnostic route.
 * @param url - The raw request target; its query string is ignored entirely.
 * @returns `/api/<segment>` for a recognized segment, `/api/other` for an
 *   unrecognized one, or `undefined` when the target is not an API request.
 */
export function boundedApiPath(url: string | undefined): string | undefined {
  const pathname = url?.split('?', 1)[0] ?? ''
  if (!pathname.startsWith('/api/')) return undefined
  const segment = pathname.slice('/api/'.length).split('/', 1)[0] ?? ''
  return ROUTE_SEGMENT.test(segment) ? `/api/${segment.toLowerCase()}` : '/api/other'
}

/** A raw measurement before the recorder applies its threshold and sampling. */
export interface ApiLatencySample {
  readonly method: string | undefined
  readonly path: string
  readonly status: number
  readonly durationMs: number
}

/**
 * Per-Gateway slow-request diagnostics.
 *
 * Records once immediately, then at most once per 30 seconds with a suppressed
 * count, mirroring the HTTP failure recorder. A sink failure cannot change a
 * response, retry a write or expose the diagnostic sink's error.
 */
export class ApiLatencyRecorder {
  private nextLogAt = 0
  private suppressed = 0
  private observerFailureReported = false

  constructor(
    private readonly observe: ((entry: ApiLatencyEntry) => void) | undefined,
    private readonly now: () => number = () => performance.now(),
    private readonly minDurationMs: number = API_LATENCY_MIN_MS,
    private readonly reportObserverFailure: () => void = () => {
      process.emitWarning('Mobile access latency diagnostics could not be recorded', {
        code: 'DSH_MOBILE_LATENCY_LOG_FAILED',
      })
    },
  ) {}

  /**
   * Record one completed request when it exceeded the reporting budget.
   * @param sample - The bounded route, method, status and measured duration.
   */
  record(sample: ApiLatencySample): void {
    if (this.observe === undefined) return
    if (!Number.isFinite(sample.durationMs) || sample.durationMs < this.minDurationMs) return
    const now = this.now()
    if (now < this.nextLogAt) {
      this.suppressed = Math.min(Number.MAX_SAFE_INTEGER, this.suppressed + 1)
      return
    }
    const suppressed = this.suppressed
    this.nextLogAt = now + LOG_INTERVAL_MS
    this.suppressed = 0
    const method = sample.method?.toUpperCase() ?? ''
    const status = Number.isInteger(sample.status) && sample.status >= 100 && sample.status <= 599
      ? sample.status
      : 0
    const entry: ApiLatencyEntry = {
      kind: 'api',
      method: BOUNDED_METHODS.has(method) ? method as ApiLatencyEntry['method'] : 'OTHER',
      path: sample.path,
      status,
      durationMs: Math.round(sample.durationMs),
      ...(suppressed === 0 ? {} : { suppressed }),
    }
    try {
      this.observe(entry)
    } catch (observerError) {
      void observerError // Diagnostic failure does not replace the owning HTTP result.
      if (this.observerFailureReported) return
      this.observerFailureReported = true
      try { this.reportObserverFailure() }
      catch (reporterError) { void reporterError /* HTTP handling remains independent of diagnostic output. */ }
    }
  }
}
