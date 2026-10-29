import { afterEach, describe, expect, it, vi } from 'vitest'
import { installCustomizationNotice } from '../src/mobile-customization-notice.js'

/**
 * The notice is a user-visible signal for a channel that used to fail silently
 * (issue #298). These tests pin the parts that decide what a user is told, so a
 * later refactor cannot quietly turn it back into a console-only message.
 */

type Listener = (reason: 'authentication_required' | 'gateway_required' | 'resource_unavailable' | undefined) => void

/** A minimal document stub: enough to build and mutate the notice tree. */
function stubDocument() {
  interface StubNode {
    tag: string; attributes: Map<string, string>; children: unknown[]; textContent: string; hidden: boolean
    listeners: Map<string, () => void>; dataset: Record<string, string>; className: string; removed: boolean
    remove: () => void; append: (...nodes: unknown[]) => void
    setAttribute: (name: string, value: string) => void; getAttribute: (name: string) => string | null
    addEventListener: (type: string, handler: () => void) => void; removeEventListener: (type: string, handler: () => void) => void; click: () => void
  }
  const created: StubNode[] = []
  const make = (tag: string): StubNode => {
    const node: StubNode = {
      tag, attributes: new Map<string, string>(), children: [] as unknown[], textContent: '', hidden: false,
      listeners: new Map<string, () => void>(), dataset: {}, className: '', removed: false,
      remove() { node.removed = true },
      append(...nodes: unknown[]) { node.children.push(...nodes) },
      setAttribute(name: string, value: string) { node.attributes.set(name, value) },
      getAttribute(name: string) { return node.attributes.get(name) ?? null },
      addEventListener(type: string, handler: () => void) { node.listeners.set(type, handler) },
      removeEventListener(type: string, handler: () => void) { if (node.listeners.get(type) === handler) node.listeners.delete(type) },
      click() { node.listeners.get('click')?.() },
    }
    created.push(node)
    return node
  }
  const body = { children: [] as unknown[], append(node: unknown) { body.children.push(node) } }
  const head = { children: [] as unknown[], append(node: unknown) { head.children.push(node) } }
  const document = {
    createElement: (tag: string) => make(tag),
    body, head,
  }
  return { document, created, body, head }
}

const disposers: Array<() => void> = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose() })

function mount(options: { locale?: () => 'en' | 'zh' | 'it'; reconnect?: () => boolean } = {}) {
  const stub = stubDocument()
  let listener: Listener | undefined
  const dispose = installCustomizationNotice(stub.document as unknown as Document, {
    locale: options.locale ?? (() => 'en'),
    reconnect: options.reconnect ?? (() => true),
    subscribe: (next) => { listener = next; return () => { listener = undefined } },
    message: reason => `detail:${reason}`,
  })
  disposers.push(dispose)
  const notice = stub.created.find(node => node.attributes.has('data-dsh-mobile-customization-notice'))
  const action = stub.created.find(node => node.className === 'dshm-notice-action')
  const dismiss = stub.created.find(node => node.className === '' && node.listeners.has('click') && node !== action)
  return { stub, dispose, notice, action, dismiss, emit: (reason: Listener extends (r: infer R) => void ? R : never) => listener?.(reason) }
}

describe('customization notice', () => {
  it('starts hidden so a healthy page shows nothing', () => {
    const mounted = mount()
    expect(mounted.notice?.hidden).toBe(true)
  })

  it('shows a localized, specific message when authentication is lost', () => {
    const mounted = mount()
    mounted.emit('authentication_required')
    expect(mounted.notice?.hidden).toBe(false)
    // The copy must name the failure rather than repeat a generic error.
    expect(mounted.notice?.children.length).toBeGreaterThan(0)
    const text = mounted.notice?.children[0] as { textContent: string }
    expect(text.textContent).toContain('authentication is unavailable')
    expect(text.textContent).toContain('detail:authentication_required')
  })

  it('uses the active locale', () => {
    const mounted = mount({ locale: () => 'zh' })
    mounted.emit('authentication_required')
    const text = mounted.notice?.children[0] as { textContent: string }
    expect(text.textContent).toContain('设备认证暂不可用')
  })

  it('hides again once the channel recovers', () => {
    const mounted = mount()
    mounted.emit('authentication_required')
    expect(mounted.notice?.hidden).toBe(false)
    mounted.emit(undefined)
    expect(mounted.notice?.hidden).toBe(true)
  })

  it('keeps a dismissed failure hidden but returns for a different one', () => {
    const mounted = mount()
    mounted.emit('authentication_required')
    mounted.dismiss?.click()
    expect(mounted.notice?.hidden).toBe(true)
    // The same failure must not re-nag on every refresh cycle.
    mounted.emit('authentication_required')
    expect(mounted.notice?.hidden).toBe(true)
    // A different failure is new information.
    mounted.emit('gateway_required')
    expect(mounted.notice?.hidden).toBe(false)
  })

  it('only claims a recovery the page can actually attempt', () => {
    // With no native bridge the action must not promise automatic renewal.
    const mounted = mount({ reconnect: () => false })
    mounted.emit('authentication_required')
    expect(mounted.notice?.hidden).toBe(false)
    mounted.action?.click()
    expect(mounted.notice?.hidden).toBe(false)
  })

  it('keeps the notice while a real recovery attempt is running', () => {
    const reconnect = vi.fn(() => true)
    const mounted = mount({ reconnect })
    mounted.emit('authentication_required')
    mounted.action?.click()
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(mounted.notice?.hidden).toBe(false)
  })

  it('removes its node and stylesheet on disposal', () => {
    const mounted = mount()
    mounted.emit('authentication_required')
    mounted.dispose()
    expect(mounted.notice?.removed).toBe(true)
    const style = mounted.stub.created.find(node => node.tag === 'style')
    expect(style?.removed).toBe(true)
  })

  it('does not invoke recovery through a retained button after disposal', () => {
    const reconnect = vi.fn(() => true)
    const mounted = mount({ reconnect })
    mounted.emit('authentication_required')
    mounted.dispose()
    mounted.action?.click()
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('degrades instead of throwing when the document cannot build nodes', () => {
    // Unit fixtures and any non-DOM environment must not break the load path.
    const bare = { createElement: undefined } as unknown as Document
    expect(() => installCustomizationNotice(bare, {
      locale: () => 'en', reconnect: () => true,
      subscribe: () => () => {}, message: reason => reason,
    })()).not.toThrow()
  })
})
