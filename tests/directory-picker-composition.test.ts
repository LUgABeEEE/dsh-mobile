import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

interface ManifestPage {
  evaluate(callback: () => boolean): Promise<boolean>
}

const { browsePickerOwnsFlow }: { browsePickerOwnsFlow(page: ManifestPage): Promise<boolean> } = await import(
  new URL('../scripts/directory-picker-composition.mjs', import.meta.url).href
)

function page(graph: unknown): ManifestPage {
  return {
    evaluate: async callback => runInNewContext(`(${callback.toString()})()`, { globalThis: { __DSH_BOOT__: graph } }) as boolean,
  }
}

describe('directory-picker smoke composition', () => {
  it('recognizes the exact upstream browse module in the page manifest', async () => {
    await expect(browsePickerOwnsFlow(page({ entries: [{ id: '@deepseek-ai/dsh-client-ui-directory-picker-browse' }] }))).resolves.toBe(true)
  })

  it('keeps native compositions on the plugin flow', async () => {
    await expect(browsePickerOwnsFlow(page({ entries: [{ id: '@deepseek-ai/dsh-client-ui-directory-picker-native' }] }))).resolves.toBe(false)
  })

  it('does not mistake a similarly named community module for the upstream picker', async () => {
    await expect(browsePickerOwnsFlow(page({ entries: [{ id: 'community/dsh-client-ui-directory-picker-browse-wrapper' }] }))).resolves.toBe(false)
  })

  it('does not require a manifest on a page without one', async () => {
    await expect(browsePickerOwnsFlow(page(undefined))).resolves.toBe(false)
  })

  it('rejects malformed entry collections and ignores non-module entries', async () => {
    await expect(browsePickerOwnsFlow(page({ entries: 'browse' }))).resolves.toBe(false)
    await expect(browsePickerOwnsFlow(page({ entries: [null, 1, {}, { id: 1 }] }))).resolves.toBe(false)
  })
})
