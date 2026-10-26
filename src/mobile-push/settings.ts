import { createElement, useSyncExternalStore } from 'react'
import type { MobilePushController, MobilePushSnapshot } from './client.js'
import type { PushPreferences } from './contracts.js'
import { requirePublicMobilePushSwitch, type MobilePushSwitchComponent } from './switch-component.js'

export const MOBILE_PUSH_SETTINGS_ORDER = 120
export interface MobilePushSettingsProps { readonly controller: MobilePushController; readonly locale: 'en' | 'zh' | 'it'; readonly switchComponent?: MobilePushSwitchComponent }
export const MOBILE_PUSH_SETTINGS_COPY = {
  en: { title: 'Web push notifications', desc: 'Receive notifications when this page is closed.', enable: 'Enable', disable: 'Disable', test: 'Send test', accepted: 'Accepted by the push provider; lock-screen delivery is not confirmed.', install: 'Add this site to your Home Screen to enable push.', denied: 'Notifications are blocked in browser settings.', unsupported: 'Web push is unavailable in this context.', error: 'Could not update push settings. Try again.', busy: 'Working…', categories: ['Questions', 'Plans', 'Approvals', 'Responses', 'Goals', 'Failures'] },
  zh: { title: '网页推送通知', desc: '关闭此页面后仍可接收通知。', enable: '启用', disable: '停用', test: '发送测试', accepted: '推送服务商已接受；不代表锁屏一定送达。', install: '请将此网站添加到主屏幕以启用推送。', denied: '浏览器设置已阻止通知。', unsupported: '此环境不支持网页推送。', error: '无法更新推送设置，请重试。', busy: '处理中…', categories: ['问题', '计划', '审批', '回复', '目标', '失败'] },
  it: { title: 'Notifiche Web push', desc: 'Ricevi notifiche quando la pagina è chiusa.', enable: 'Attiva', disable: 'Disattiva', test: 'Invia test', accepted: 'Accettata dal provider; la consegna sulla schermata di blocco non è confermata.', install: 'Aggiungi il sito alla schermata Home per attivare il push.', denied: 'Le notifiche sono bloccate nelle impostazioni del browser.', unsupported: 'Web push non disponibile in questo contesto.', error: 'Impossibile aggiornare le impostazioni push. Riprova.', busy: 'Operazione…', categories: ['Domande', 'Piani', 'Approvazioni', 'Risposte', 'Obiettivi', 'Errori'] },
} as const
const KEYS = ['question', 'plan', 'approval', 'response', 'goal', 'failure'] as const
function message(snapshot: MobilePushSnapshot, copy: (typeof MOBILE_PUSH_SETTINGS_COPY)[keyof typeof MOBILE_PUSH_SETTINGS_COPY]): string {
  if (snapshot.state === 'install') return copy.install
  if (snapshot.state === 'denied') return copy.denied
  if (snapshot.state === 'unsupported') return copy.unsupported
  if (snapshot.state === 'enabled' && snapshot.error === 'push.test.accepted') return copy.accepted
  return snapshot.state === 'failed' ? copy.error : copy.desc
}
/** Browser-only settings row; mounting it never requests permission or creates a subscription. */
export function MobilePushSettings({ controller, locale, switchComponent }: MobilePushSettingsProps): ReturnType<typeof createElement> | null {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const copy = MOBILE_PUSH_SETTINGS_COPY[locale]
  if (snapshot.state === 'unsupported') return null
  const prefs = snapshot.preferences
  // Actual public DSH Switch, provided by the shell module loader at render time (or
  // injected by an owning fixture); without it the category controls are withdrawn
  // rather than replaced with a painted approximation.
  const Switch = switchComponent ?? requirePublicMobilePushSwitch()
  const toggle = (key: typeof KEYS[number], checked: boolean): void => {
    if (!prefs) return
    void controller.updatePreferences({ ...prefs, [key]: checked } as PushPreferences)
  }
  return createElement('div', { className: 'dsh-mobile-settings_row', style: { flexWrap: 'wrap' }, lang: locale === 'zh' ? 'zh-CN' : locale },
    createElement('div', { className: 'dsh-mobile-settings_rowText', style: { paddingRight: 8 } },
      createElement('div', { className: 'dsh-mobile-settings_title' }, copy.title),
      createElement('div', { className: 'dsh-mobile-settings_desc', 'aria-live': 'polite' }, message(snapshot, copy)),
      prefs && Switch !== undefined ? createElement('div', { className: 'dsh-mobile-push-categories' }, ...KEYS.map((key, index) => {
        const name = copy.categories[index]
        if (name === undefined) return null
        return createElement('label', { key, className: 'dsh-mobile-push-category' },
          createElement('span', { className: 'dsh-mobile-push-categoryName' }, name),
          createElement(Switch, { checked: prefs[key], label: name, onChange: (next: boolean): void => { toggle(key, next) } }))
      })) : null,
    ),
    createElement('div', { className: 'dsh-mobile-push-actions', style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
      snapshot.state === 'enabled' ? createElement('button', { type: 'button', className: 'dsh-mobile-settings_selector', onClick: () => void controller.sendTest() }, copy.test) : null,
      snapshot.state === 'enabled' || snapshot.state === 'suspended' ? createElement('button', { type: 'button', className: 'dsh-mobile-settings_selector', onClick: () => void controller.disable() }, copy.disable) : snapshot.state === 'ready' || snapshot.state === 'failed' || snapshot.state === 'disabled' ? createElement('button', { type: 'button', className: 'dsh-mobile-settings_selector', onClick: () => void controller.enableFromGesture() }, copy.enable) : createElement('button', { type: 'button', className: 'dsh-mobile-settings_selector', disabled: true }, copy.busy),
    ),
  )
}
