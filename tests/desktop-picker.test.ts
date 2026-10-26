import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { Loader, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import * as yaml from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'

const auto = '@deepseek-ai/dsh-host-directory-picker-auto'
const nativeHost = '@deepseek-ai/dsh-host-directory-picker-native'
const nativeSurface = '@deepseek-ai/dsh-client-ui-directory-picker-native'
const patches = yaml.load(readFileSync(resolve(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as PatchOptions[]
const legacyNative: PatchOptions[] = [
  { id: 'directory-picker', disabled: true },
  { insert: [{ id: 'user-native-host', name: nativeHost }, { id: 'user-native-surface', name: nativeSurface }] },
]

/** Exercise real patch composition and Cordis ownership, not an OS dialog simulation. */
async function inspectComposition(layers: PatchOptions[][]): Promise<void> {
  const warn = vi.fn()
  const composed = applyEntryPatches([{ id: 'directory-picker', name: auto }], structuredClone(layers.flat()), warn)
  expect(warn).not.toHaveBeenCalled()
  const pickerRows = composed.filter(row => row.id !== 'mobile-access' && row.id !== 'dsh-ui-fixes')
  const ctx = new Context()
  await ctx.plugin(Loader).await()
  const active = new Set<string>()
  let instances = 0
  class Picker extends Service {
    readonly occurrence: number
    constructor(owner: Context) {
      super(owner, 'directoryPicker')
      this.occurrence = ++instances
      owner.effect(() => {
        const id = owner.fiber.entry!.options.id
        active.add(id)
        return () => { active.delete(id) }
      })
    }
  }
  const load = vi.spyOn(ctx.loader, 'import').mockImplementation(async name => {
    if (name === auto || name === nativeHost) return Picker
    if (name === nativeSurface) return { apply() {} }
    throw new Error(`unexpected picker composition import: ${name}`)
  })
  try {
    await ctx.loader.root.update(pickerRows as EntryOptions[])
    await ctx.loader.await()
    expect(active.size).toBe(1)
    expect(ctx.get('directoryPicker')).toBeDefined()
    const selected = instances
    // Enabling/disabling Mobile's unrelated components must not replace this provider.
    await ctx.loader.root.update(pickerRows as EntryOptions[])
    await ctx.loader.await()
    expect(ctx.get('directoryPicker')).toMatchObject({ occurrence: selected })
    await ctx.loader.root.stop()
    expect(active.size).toBe(0)
    expect(ctx.get('directoryPicker')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    load.mockRestore()
  }
}

describe('directory picker composition without Desktop marker services', () => {
  it('retains the upstream default picker with the Mobile bundle present', async () => {
    await inspectComposition([patches])
  })
  it.each([false, true])('retains an existing user native override, user layer first: %s', async userFirst => {
    await inspectComposition(userFirst ? [legacyNative, patches] : [patches, legacyNative])
  })
})
