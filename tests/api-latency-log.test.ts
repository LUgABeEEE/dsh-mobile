import { describe, expect, it, vi } from 'vitest'
import {
  API_LATENCY_MIN_MS,
  ApiLatencyRecorder,
  boundedApiPath,
  type ApiLatencyEntry,
} from '../src/api-latency-log.js'

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return { now: () => current, advance: (ms: number) => { current += ms } }
}

describe('boundedApiPath', () => {
  it('keeps only the first API route segment', () => {
    expect(boundedApiPath('/api/sessions')).toBe('/api/sessions')
    expect(boundedApiPath('/api/session/page?sessionId=secret')).toBe('/api/session')
    expect(boundedApiPath('/api/session/uploadFileBinary?x=1')).toBe('/api/session')
    expect(boundedApiPath('/api/Sessions')).toBe('/api/sessions')
  })

  it('collapses unrecognized segments and non-API targets', () => {
    expect(boundedApiPath('/api/')).toBe('/api/other')
    expect(boundedApiPath('/api/../secrets')).toBe('/api/other')
    expect(boundedApiPath('/api/%2e%2e/x')).toBe('/api/other')
    expect(boundedApiPath('/api')).toBeUndefined()
    expect(boundedApiPath('/plugins/mobile.js?rev=1')).toBeUndefined()
    expect(boundedApiPath(undefined)).toBeUndefined()
  })

  it('never echoes a query string', () => {
    const path = boundedApiPath('/api/session?token=launch-secret&x=1')
    expect(path).toBe('/api/session')
    expect(String(path)).not.toContain('launch-secret')
  })
})

describe('ApiLatencyRecorder', () => {
  const sample = (overrides: Partial<Parameters<ApiLatencyRecorder['record']>[0]> = {}) => ({
    method: 'GET', path: '/api/session', status: 200, durationMs: API_LATENCY_MIN_MS, ...overrides,
  })

  it('ignores ordinary traffic below the reporting budget', () => {
    const entries: ApiLatencyEntry[] = []
    const recorder = new ApiLatencyRecorder(entry => entries.push(entry), clock().now)
    recorder.record(sample({ durationMs: API_LATENCY_MIN_MS - 1 }))
    expect(entries).toEqual([])
  })

  it('records the bounded route, method and rounded duration', () => {
    const entries: ApiLatencyEntry[] = []
    const recorder = new ApiLatencyRecorder(entry => entries.push(entry), clock().now)
    recorder.record(sample({ method: 'post', durationMs: 4_321.6 }))
    expect(entries).toEqual([{
      kind: 'api', method: 'POST', path: '/api/session', status: 200, durationMs: 4_322,
    }])
  })

  it('collapses unknown methods and out-of-range statuses', () => {
    const entries: ApiLatencyEntry[] = []
    const recorder = new ApiLatencyRecorder(entry => entries.push(entry), clock().now)
    recorder.record(sample({ method: 'TRACE', status: 99, durationMs: 3_000 }))
    expect(entries[0]).toMatchObject({ method: 'OTHER', status: 0 })
  })

  it('samples at most once per window and reports the suppressed count', () => {
    const entries: ApiLatencyEntry[] = []
    const time = clock()
    const recorder = new ApiLatencyRecorder(entry => entries.push(entry), time.now)
    recorder.record(sample())
    recorder.record(sample())
    recorder.record(sample())
    expect(entries).toHaveLength(1)
    time.advance(30_000)
    recorder.record(sample())
    expect(entries).toHaveLength(2)
    expect(entries[1]).toMatchObject({ suppressed: 2 })
  })

  it('keeps a failing sink from changing the HTTP result', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const recorder = new ApiLatencyRecorder(() => { throw new Error('sink offline') })
    expect(() => recorder.record(sample())).not.toThrow()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('does no work without a sink', () => {
    const recorder = new ApiLatencyRecorder(undefined)
    expect(() => recorder.record(sample({ durationMs: 60_000 }))).not.toThrow()
  })
})
