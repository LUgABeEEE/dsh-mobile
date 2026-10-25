import { describe, expect, it } from 'vitest'
import { hasUpstreamBrowsePicker } from '../src/mobile-directory-picker.js'

/** The DSH boot graph shape the client runtime publishes on every page. */
function view (entries: { id: string }[]): Window & typeof globalThis {
  return { __DSH_BOOT__: { entries } } as unknown as Window & typeof globalThis
}

describe('upstream browse picker detection', () => {
  it('recognises DSH\'s own browse surface', () => {
    expect(hasUpstreamBrowsePicker(view([{ id: '@deepseek-ai/dsh-client-ui-directory-picker-browse' }]))).toBe(true)
  })

  it('ignores the native surface, which a remote browser cannot open', () => {
    expect(hasUpstreamBrowsePicker(view([{ id: '@deepseek-ai/dsh-client-ui-directory-picker-native' }]))).toBe(false)
  })

  it('ignores a page without a published boot graph', () => {
    expect(hasUpstreamBrowsePicker({} as Window & typeof globalThis)).toBe(false)
  })

  it('ignores unrelated entries', () => {
    expect(hasUpstreamBrowsePicker(view([{ id: '@deepseek-ai/dsh-api-gateway' }, { id: 'dsh-mobile' }]))).toBe(false)
  })
})
