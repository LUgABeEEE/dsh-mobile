import { describe, expect, it } from 'vitest'
import { hasUpstreamBrowsePicker } from '../src/mobile-directory-picker.js'

/** The DSH boot graph shape the client runtime publishes on every page. */
function view(entries: { id: string }[]): object {
  return { __DSH_BOOT__: { entries } }
}

describe('upstream browse picker detection', () => {
  it('recognises DSH\'s own browse surface', () => {
    expect(hasUpstreamBrowsePicker(view([{ id: '@deepseek-ai/dsh-client-ui-directory-picker-browse' }]))).toBe(true)
  })

  it('ignores the native surface, which a remote browser cannot open', () => {
    expect(hasUpstreamBrowsePicker(view([{ id: '@deepseek-ai/dsh-client-ui-directory-picker-native' }]))).toBe(false)
  })

  it('ignores a page without a published boot graph', () => {
    expect(hasUpstreamBrowsePicker({})).toBe(false)
  })

  it('ignores unrelated entries', () => {
    expect(hasUpstreamBrowsePicker(view([{ id: '@deepseek-ai/dsh-api-gateway' }, { id: 'dsh-mobile' }]))).toBe(false)
  })

  it('does not mistake a community wrapper for the real upstream surface', () => {
    expect(hasUpstreamBrowsePicker(view([{ id: 'community/dsh-client-ui-directory-picker-browse-wrapper' }]))).toBe(false)
  })

  it('ignores malformed boot entries without crashing the Mobile page', () => {
    expect(hasUpstreamBrowsePicker({ __DSH_BOOT__: null })).toBe(false)
    expect(hasUpstreamBrowsePicker({ __DSH_BOOT__: { entries: 'browse' } })).toBe(false)
    expect(hasUpstreamBrowsePicker({ __DSH_BOOT__: { entries: [null, 1, {}] } })).toBe(false)
  })
})
