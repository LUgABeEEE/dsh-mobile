/**
 * keyboard-bridge —— 实体键盘 → 桌面 DSH 键位（移动端补齐）
 *
 * 背景（实测，见 09-键盘快捷键.md / 12-键盘桥接.md）：
 *   · 接了实体键盘时，Android 输入法把 `Ctrl+Enter` 送进 WebView 会变成
 *     `keyCode 229`（composition 态）或单纯的 `Enter` —— **修饰键在这个路径上丢掉了**；
 *   · `Control` 自身的 keydown 是**可信且能到达页面**的（已验），因此用
 *     「Control 按下 → 紧随其后的 beforeinput(insertText \r\n) / Enter(229)」组合判定 Ctrl+Enter。
 *
 * 设计原则：
 *   1. 只读键、不伪造事件：需要「发送」时点真实按钮；需要「插话」时调用页面暴露的提交入口。
 *   2. 软键盘可见 / IME 组合态 → 一律放行（不破坏原有移动端手感）。
 *   3. 每个键位可单独关闭；整页可 opt-out（`<html data-dsh-keyboard-bridge="off">`）。
 *   4. 纯函数式安装：返回 dispose，重复安装不会叠加监听。
 */

export interface KeyboardBridgeOptions {
  /** 软键盘是否可见（宿主已有状态源，这里注入以便测试） */
  softKeyboardVisible?: () => boolean
  /** 触发插话（steer）；由调用方决定走页面提交入口还是原生桥 */
  onSteer?: (text: string) => boolean
  /** 触发普通发送；默认实现是点真实发送按钮 */
  onSend?: () => boolean
  /** 组合态判定窗口（ms）：Control 按下后多久内到达的 Enter 视为组合 */
  comboWindowMs?: number
  /** 单键开关 */
  enableCtrlEnter?: boolean
  enableEscape?: boolean
  enablePageKeys?: boolean
  enableHomeEnd?: boolean
  enableTabFocus?: boolean
}

interface Disposable {
  (): void
}

const CONFIG_ATTR = 'data-dsh-keyboard-bridge-config'
const OPTOUT_ATTR = 'data-dsh-keyboard-bridge'
const LAST_ATTR = 'data-dsh-keyboard-bridge-last'

/** 发送按钮定位顺序（与扩展版一致，宿主改版时只需改这里） */
const SEND_SELECTORS = [
  '[data-slot="conversation.input.send"] button',
  '[data-slot="conversation.input.send"]',
  'button[aria-label*="发送"]',
  'button[aria-label*="Send"]',
  'button[type="submit"]',
]

/** 会话可滚动容器（宿主用 data-slot 标记主区；没有就退到 window） */
const SCROLL_SELECTORS = [
  '[data-slot="conversation.scroll"]',
  '[data-slot="main"] [data-scroll]',
  '.dshm-main',
]

function pickConfig(base: KeyboardBridgeOptions): Required<Omit<KeyboardBridgeOptions, 'softKeyboardVisible' | 'onSteer' | 'onSend'>> {
  const merged = {
    comboWindowMs: base.comboWindowMs ?? 1200,
    enableCtrlEnter: base.enableCtrlEnter !== false,
    enableEscape: base.enableEscape !== false,
    enablePageKeys: base.enablePageKeys !== false,
    enableHomeEnd: base.enableHomeEnd !== false,
    enableTabFocus: base.enableTabFocus !== false,
  }
  const root = typeof document !== 'undefined' ? document.documentElement : null
  const raw = root?.getAttribute(CONFIG_ATTR)
  if (raw === null || raw === undefined || raw === '') return merged
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const key of Object.keys(merged) as (keyof typeof merged)[]) {
      if (key in parsed) {
        // @ts-expect-error 运行时按同名键覆盖（值类型来自 JSON，布尔/数字自检）
        merged[key] = typeof parsed[key] === typeof merged[key] ? parsed[key] : merged[key]
      }
    }
  } catch {
    /* 配置写错就用默认 */
  }
  return merged
}

function mark(text: string): void {
  const root = typeof document !== 'undefined' ? document.documentElement : null
  root?.setAttribute(LAST_ATTR, text.slice(0, 200))
}

function optedOut(): boolean {
  const root = typeof document !== 'undefined' ? document.documentElement : null
  return root?.getAttribute(OPTOUT_ATTR) === 'off'
}

export function findSendButton(doc: Document = document): HTMLElement | null {
  const editor = doc.querySelector('[data-composer-input][contenteditable="true"]')
  const card = editor?.closest('[data-composer-card]') ?? null
  const scopes: (Element | Document)[] = card ? [card, doc] : [doc]
  for (const scope of scopes) {
    for (const selector of SEND_SELECTORS) {
      const node = scope.querySelector<HTMLElement>(selector)
      if (node !== null && !node.hasAttribute('disabled') && node.getAttribute('aria-disabled') !== 'true') return node
    }
  }
  return null
}

export function findScrollContainer(doc: Document = document): HTMLElement | null {
  for (const selector of SCROLL_SELECTORS) {
    const node = doc.querySelector<HTMLElement>(selector)
    if (node !== null && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

function composerEditor(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-composer-input][contenteditable="true"]')
}

function scrollByPage(target: HTMLElement | null, direction: 1 | -1, pageRatio = 0.9): boolean {
  const host = target ?? null
  if (host !== null) {
    const delta = Math.max(120, Math.round(host.clientHeight * pageRatio)) * direction
    host.scrollBy?.({ top: delta, behavior: 'smooth' })
    return true
  }
  if (typeof window !== 'undefined') {
    window.scrollBy?.({ top: window.innerHeight * pageRatio * direction, behavior: 'smooth' })
    return true
  }
  return false
}

/** 安装键盘桥接；返回 dispose。重复安装（同一 window）不会叠加。 */
export function installKeyboardBridge(options: KeyboardBridgeOptions = {}): Disposable {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  const config = pickConfig(options)
  const softKeyboardVisible = options.softKeyboardVisible ?? (() => {
    const state = (window as unknown as { __DSH_MOBILE_KEYBOARD_STATE__?: { imeVisible?: boolean } }).__DSH_MOBILE_KEYBOARD_STATE__
    return state?.imeVisible === true
  })
  const onSteer = options.onSteer ?? ((_text: string) => {
    const host = (window as unknown as { __DSH_MOBILE_STEER__?: (t: string) => boolean }).__DSH_MOBILE_STEER__
    if (typeof host === 'function') {
      try { if (host(_text) !== false) return true } catch { /* 宿主导航失败则回落 */ }
    }
    return dispatchSteer()
  })
  const onSend = options.onSend ?? (() => {
    const button = findSendButton()
    if (button === null) return false
    button.click()
    return true
  })

  let ctrlDownAt = 0
  let composing = false
  let composingUntil = 0
  let disposed = false

  const recentlyComposing = (): boolean => composing || (typeof performance !== 'undefined' && performance.now() < composingUntil)

  /** Ctrl+Enter 的「组合」判定窗口：Control 按下后 comboWindowMs 内出现的 Enter/beforeinput 才算 */
  const inComboWindow = (): boolean => ctrlDownAt !== 0 && (typeof performance === 'undefined' || performance.now() - ctrlDownAt <= config.comboWindowMs)

  const shouldPassThrough = (): boolean => optedOut() || softKeyboardVisible() || recentlyComposing()

  const onKeyDown = (event: KeyboardEvent): void => {
    if (disposed) return
    // Control 自身的 keydown 是这条链路上唯一保留修饰位的信号
    if (event.key === 'Control' && event.isTrusted) {
      ctrlDownAt = typeof performance === 'undefined' ? Date.now() : performance.now()
      return
    }
    // 坑：Enter（含 229）本身不能清时间戳，否则紧随其后的 beforeinput 判定永远拿不到组合态；
    // 只有「既不是 Control 也不是 Enter」的按键才重置窗口。
    // 输入法会把 Enter 送成 key='Unidentified'/keyCode=229 —— 它既不是 Control 也不是 Enter，
    // 若在这里重置窗口，紧随其后的 beforeinput 判定就永远拿不到组合态（实测踩过）。
    const imeEnter = event.keyCode === 229 || event.key === 'Unidentified'
    if (event.key !== 'Control' && event.key !== 'Enter' && !imeEnter && event.isTrusted && !event.ctrlKey && !event.metaKey) ctrlDownAt = 0
    if (shouldPassThrough()) return
    if (!event.isTrusted) return
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return

    // 1) Ctrl/Cmd + Enter（正常键盘路径：修饰位还在）
    if (config.enableCtrlEnter && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      event.stopPropagation()
      const steered = onSteer(composerText())
      mark(steered ? 'ctrl+enter steer' : 'ctrl+enter steer-unavailable')
      if (!steered) onSend()
      return
    }

    // 2) Esc：交给宿主的 dialog 处理；这里只在「有面板且能定位关闭按钮」时补一刀
    if (config.enableEscape && event.key === 'Escape') {
      const panel = document.querySelector<HTMLElement>('[role="dialog"][open], [data-panel-open="true"]')
      const close = panel?.querySelector<HTMLElement>('[data-slot$="close"], button[aria-label*="关闭"], button[aria-label*="Close"]') ?? null
      if (panel !== null && close !== null) {
        event.preventDefault()
        event.stopPropagation()
        close.click()
        mark('esc closed panel')
      }
      return
    }

    // 3) PageUp/PageDown、Space/Shift+Space：滚动会话（Space 只在焦点不在输入框时接管）
    if (config.enablePageKeys) {
      const inEditor = composerEditor()?.contains(event.target as Node) ?? false
      const pageDown = event.key === 'PageDown' || (event.key === ' ' && !inEditor && !event.shiftKey)
      const pageUp = event.key === 'PageUp' || (event.key === ' ' && !inEditor && event.shiftKey)
      if (pageDown || pageUp) {
        event.preventDefault()
        scrollByPage(findScrollContainer(), pageDown ? 1 : -1)
        mark(pageDown ? 'page down' : 'page up')
        return
      }
    }

    // 4) Home/End（Ctrl+Home/Ctrl+End 同义）：跳顶/底
    if (config.enableHomeEnd && (event.key === 'Home' || event.key === 'End')) {
      const host = findScrollContainer()
      if (host !== null) {
        event.preventDefault()
        host.scrollTo?.({ top: event.key === 'Home' ? 0 : host.scrollHeight, behavior: 'smooth' })
        mark(event.key === 'Home' ? 'scroll top' : 'scroll bottom')
        return
      }
      if (typeof window !== 'undefined') {
        event.preventDefault()
        window.scrollTo?.({ top: event.key === 'Home' ? 0 : document.body.scrollHeight, behavior: 'smooth' })
        mark(event.key === 'Home' ? 'page top' : 'page bottom')
        return
      }
    }

    // 5) Tab / Shift+Tab：输入区内移动焦点（不接管时让宿主自己走）
    if (config.enableTabFocus && event.key === 'Tab') {
      const editor = composerEditor()
      if (editor !== null && (editor.contains(event.target as Node) || event.target === editor)) {
        // 输入框内 Tab 默认会插入制表符/跳走；这里显式拦下并聚焦发送按钮，便于「Tab→Enter」连招
        const button = findSendButton()
        if (button !== null) {
          event.preventDefault()
          button.focus?.()
          mark('tab -> send button')
        }
      }
    }
  }

  /**
   * 关键补丁：输入法把 Ctrl+Enter 变成一个「普通的 Enter + 229」时，
   * 只有 Control 的时间戳留了下来。抓 beforeinput(insertText "\r\n") 与 229 的 keydown，
   * 只要还在组合窗口内，就当作 Ctrl+Enter 处理。
   */
  const onBeforeInput = (event: Event): void => {
    if (disposed || !config.enableCtrlEnter) return
    const input = event as InputEvent
    if (input.inputType !== 'insertLineBreak' && input.inputType !== 'insertText') return
    const text = input.data ?? ''
    if (text !== '' && text !== '\n' && text !== '\r\n' && text !== '\r') return
    if (!inComboWindow()) return
    if (shouldPassThrough()) return
    ctrlDownAt = 0
    event.preventDefault()
    const steered = onSteer(composerText())
    mark(steered ? 'ctrl+enter(ime) steer' : 'ctrl+enter(ime) steer-unavailable')
    if (!steered) onSend()
  }

  const onKeyDownFallback = (event: KeyboardEvent): void => {
    // 229 = IME 吞掉了这次 Enter；若仍在组合窗口内，同样按 Ctrl+Enter 处理
    if (disposed || !config.enableCtrlEnter) return
    if (event.keyCode !== 229) return
    if (!inComboWindow()) return
    if (shouldPassThrough()) return
    ctrlDownAt = 0
    event.preventDefault()
    const steered = onSteer(composerText())
    mark(steered ? 'ctrl+enter(229) steer' : 'ctrl+enter(229) steer-unavailable')
    if (!steered) onSend()
  }

  const onCompositionStart = (): void => { composing = true }
  const onCompositionEnd = (): void => {
    composing = false
    composingUntil = (typeof performance === 'undefined' ? Date.now() : performance.now()) + 10
  }

  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('keydown', onKeyDownFallback, true)
  document.addEventListener('beforeinput', onBeforeInput, true)
  document.addEventListener('compositionstart', onCompositionStart, true)
  document.addEventListener('compositionend', onCompositionEnd, true)

  const dispose = (): void => {
    disposed = true
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('keydown', onKeyDownFallback, true)
    document.removeEventListener('beforeinput', onBeforeInput, true)
    document.removeEventListener('compositionstart', onCompositionStart, true)
    document.removeEventListener('compositionend', onCompositionEnd, true)
  }
  return dispose
}

/**
 * 默认 steer 实现：在 composer 编辑器上派发**合成的 Ctrl+Enter**。
 *
 * 依据（用户实测，2026-11-02）：DSH 的提交逻辑只读 `event.ctrlKey`，**不校验 `isTrusted`**，
 * 所以合成事件能走到「插话（steer）」分支——与 PC 端一致，不需要原生 dispatchKeyEvent。
 * 关键字段：`key/code=Enter`、`keyCode/which=13`、`ctrlKey=true`、`bubbles/cancelable/composed=true`。
 */
export function dispatchSteer(doc: Document = document): boolean {
  const editor = doc.querySelector<HTMLElement>('[data-composer-input][contenteditable="true"]')
  if (editor === null) return false
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    composed: true,
  } as KeyboardEventInit)
  editor.dispatchEvent(event)
  return true
}

/** 当前输入框文本（用于把草稿交给 steer 通道） */
export function composerText(): string {
  const editor = composerEditor()
  if (editor === null) return ''
  return (editor.textContent ?? '').replaceAll('\u200b', '')
}

export const keyboardBridgeInternals = { pickConfig, scrollByPage, SEND_SELECTORS, SCROLL_SELECTORS }
