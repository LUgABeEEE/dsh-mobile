/** Dedicated Mobile directory-flow occupant; stock DSH retains its own chooser. */
import { useEffect, useRef } from 'react'
import { isMobileDirectoryName, isMobileDirectoryPath, MobileDirectoryBrowser, MobileDirectoryCreator,
  MobileDirectoryCreateError, MobileDirectoryReadError, type MobileDirectoryFailure } from './mobile-directory-browser.js'

interface DirectoryPickerSlots {
  readonly slots: {
    inject(key: string, callback: () => () => void): () => void
    register<Props>(options: { name: string; id: string; order?: number; priority?: number }, component: (props: Props) => unknown): () => void
  }
}

/** Public ui-workspace directory-flow owner fields. */
interface DirectoryFlowProps {
  readonly open: boolean
  readonly busy?: boolean
  readonly onPicked: (path: string) => void
  readonly onCancel: () => void
  readonly onError: (message: string) => void
}

const MESSAGES = {
  zh: {
    title: '选择工作区目录', path: '目录路径', go: '前往', home: '主目录', up: '上一级', cancel: '取消', close: '关闭', open: '打开', retry: '重试',
    loading: '正在读取文件夹…', adopting: '正在打开工作区…', empty: '此目录中没有子文件夹', truncated: '文件夹过多，仅显示开头部分；可输入完整路径前往其他目录',
    'bad-path': '请输入电脑上的绝对目录路径，例如 C:\\projects 或 /home/user/projects', unavailable: '无法读取此目录，请检查路径和访问权限后重试',
    unauthorized: '连接授权不可用，请关闭窗口并重新连接电脑', 'invalid-response': '目录响应不可用，请重试或重新连接电脑',
    'request-failed': '读取目录失败，请检查连接后重试', timeout: '读取目录超时，请重试或取消', failedOpen: '无法打开目录选择器，请重新连接后重试',
    create: '新建文件夹', createTitle: '新建文件夹名称', createAction: '创建', createInvalid: '请输入单个文件夹名称，不能包含路径分隔符。',
    createExists: '同名文件夹已存在。', createFailed: '无法创建文件夹，请检查该目录的写入权限后重试。',
    createParent: '创建位置', creating: '正在创建文件夹…', createStopping: '正在结束创建请求…',
    createUnknown: '无法确认创建结果，文件夹可能已创建。请返回并重新读取目录，确认后再决定是否重试。',
  },
  en: {
    title: 'Select workspace directory', path: 'Directory path', go: 'Go', home: 'Home', up: 'Up one level', cancel: 'Cancel', close: 'Close', open: 'Open', retry: 'Retry',
    loading: 'Loading folders…', adopting: 'Opening workspace…', empty: 'No subfolders in this directory', truncated: 'Only the first folders are shown; enter a full path to open another directory',
    'bad-path': 'Enter an absolute computer path, such as C:\\projects or /home/user/projects', unavailable: 'Could not read this directory. Check its path and access permissions, then retry.',
    unauthorized: 'Connection authorization is unavailable. Close this dialog and reconnect to the computer.', 'invalid-response': 'The directory response is unavailable. Retry or reconnect to the computer.',
    'request-failed': 'Could not load this directory. Check the connection and retry.', timeout: 'Loading timed out. Retry or cancel.', failedOpen: 'Could not open the directory picker. Reconnect and retry.',
    create: 'New folder', createTitle: 'New folder name', createAction: 'Create', createInvalid: 'Enter a single folder name without path separators.',
    createExists: 'A folder with that name already exists.', createFailed: 'Could not create the folder. Check write access to this directory and retry.',
    createParent: 'Create in', creating: 'Creating folder…', createStopping: 'Finishing the creation request…',
    createUnknown: 'The creation result is unknown; the folder may already exist. Go back and reload the directory before deciding whether to retry.',
  },
  it: {
    title: 'Seleziona la cartella del workspace', path: 'Percorso della cartella', go: 'Vai', home: 'Home', up: 'Cartella superiore', cancel: 'Annulla', close: 'Chiudi', open: 'Apri', retry: 'Riprova',
    loading: 'Caricamento delle cartelle…', adopting: 'Apertura del workspace…', empty: 'Nessuna sottocartella in questa cartella', truncated: 'Sono mostrate solo le prime cartelle; inserisci un percorso completo per aprirne un’altra',
    'bad-path': 'Inserisci un percorso assoluto del computer, come C:\\projects o /home/user/projects', unavailable: 'Impossibile leggere questa cartella. Controlla il percorso e i permessi, poi riprova.',
    unauthorized: 'Autorizzazione non disponibile. Chiudi questa finestra e riconnettiti al computer.', 'invalid-response': 'Risposta della cartella non disponibile. Riprova o riconnettiti al computer.',
    'request-failed': 'Impossibile caricare la cartella. Controlla la connessione e riprova.',
    create: 'Nuova cartella', createTitle: 'Nome della nuova cartella', createAction: 'Crea', createInvalid: 'Inserisci un singolo nome di cartella senza separatori di percorso.',
    createExists: 'Esiste già una cartella con questo nome.', createFailed: 'Impossibile creare la cartella. Controlla i permessi di scrittura e riprova.', timeout: 'Caricamento scaduto. Riprova o annulla.', failedOpen: 'Impossibile aprire la selezione della cartella. Riconnettiti e riprova.',
    createParent: 'Crea in', creating: 'Creazione della cartella…', createStopping: 'Chiusura della richiesta di creazione…',
    createUnknown: 'Esito della creazione sconosciuto: la cartella potrebbe già esistere. Torna indietro e ricarica la directory prima di riprovare.',
  },
} as const
type Locale = keyof typeof MESSAGES

/** Authenticated directory browsing/creation route; no native picker or Host service is replaced. */
export const WORKSPACE_DIRECTORIES_PATH = '/mobile-access/workspace-directories'

/** Ask only this plugin's live directory dialog to handle a routed native Back. */
export function dismissMobileDirectoryPicker(dialog: HTMLElement): boolean {
  if (dialog.tagName !== 'DIALOG' || dialog.getAttribute('data-dshm-picker-dialog') !== 'true'
    || dialog.getAttribute('open') === null) return false
  const dismiss = new Event('dsh-mobile:directory-picker-dismiss', { cancelable: true })
  dialog.dispatchEvent(dismiss)
  return dismiss.defaultPrevented
}

function localeOf(doc: Document): Locale {
  const languages = [doc.documentElement.lang, ...(doc.defaultView?.navigator.languages ?? [])]
  for (const language of languages) {
    const code = language.toLowerCase().split('-')[0]
    if (code === 'zh' || code === 'en' || code === 'it') return code
  }
  return 'en'
}

/** Create one child directory through the same authenticated route that lists them. */
async function createDirectory(path: string, name: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(WORKSPACE_DIRECTORIES_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, name }),
    signal,
  })
  if (!response.ok) {
    const code = response.status === 409 ? 'directory-exists'
      : response.status === 400 ? 'directory-create-failed'
        : response.status === 401 || response.status === 403 ? 'unauthorized' : 'directory-create-failed'
    try { await response.body?.cancel() } catch (error) { throw new MobileDirectoryCreateError(code) }
    throw new MobileDirectoryCreateError(code)
  }
  const payload = await response.json() as { path?: unknown }
  if (typeof payload?.path !== 'string' || !isMobileDirectoryPath(payload.path)) throw new MobileDirectoryCreateError('invalid-response')
  return payload.path
}

async function readDirectories(path: string | null, signal: AbortSignal): Promise<unknown> {
  const query = path === null ? '' : `?path=${encodeURIComponent(path)}`
  const response = await fetch(`${WORKSPACE_DIRECTORIES_PATH}${query}`, { credentials: 'same-origin', cache: 'no-store', signal })
  if (!response.ok) {
    const code: MobileDirectoryFailure = response.status === 400 ? 'bad-path'
      : response.status === 401 || response.status === 403 ? 'unauthorized' : 'unavailable'
    try { await response.body?.cancel() } catch (error) { throw new MobileDirectoryReadError(code, { cause: error }) }
    throw new MobileDirectoryReadError(code)
  }
  try { return await response.json() } catch (error) { throw new MobileDirectoryReadError('invalid-response', { cause: error }) }
}

const STYLES = `
dialog.dshm-picker{position:fixed;inset:0;box-sizing:border-box;width:100%;max-width:none;height:100%;max-height:none;margin:0;padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));border:0;background:transparent;color:var(--dsw-alias-label-primary,#16181d);font:400 14px/1.5 system-ui;overflow:hidden}
dialog.dshm-picker[open]{display:grid;place-items:center}dialog.dshm-picker::backdrop{background:rgb(0 0 0 / 42%)}
.dshm-picker__panel{display:flex;flex-direction:column;box-sizing:border-box;width:min(680px,100%);height:min(500px,100%);min-height:0;overflow:hidden;border:0;border-radius:28px;box-shadow:0 0 0 .5px rgba(0 0 0 / 16%),0 3px 8px rgba(0 0 0 / 4%);background:var(--dsw-alias-bg-layer-1,#fff)}
.dshm-picker__header{display:flex;align-items:center;flex:none;gap:8px;padding:16px 14px 8px 24px;border-bottom:1px solid var(--dsw-alias-border-l2,#dde0e4)}
.dshm-picker__title{flex:1;min-width:0;margin:0;font-size:16px;font-weight:510;line-height:24px;overflow-wrap:anywhere}
.dshm-picker__toolbar{display:flex;flex-wrap:wrap;gap:8px;flex:none;padding:12px 16px 8px}.dshm-picker__path-label{flex:1;min-width:min(180px,100%);display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary,#606873)}
.dshm-picker__path{box-sizing:border-box;width:100%;min-width:0;min-height:48px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:var(--dsw-alias-label-primary,#16181d);font:400 16px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
.dshm-picker__path[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary,#b42318)}.dshm-picker__go{align-self:flex-end}
.dshm-picker__navigation{display:flex;flex:none;gap:8px;padding:0 16px 8px}.dshm-picker__navigation .dshm-picker__button{flex:1;white-space:normal}
.dshm-picker__list{flex:1;min-height:0;margin:0;padding:16px 16px 16px 24px;overflow:auto;overscroll-behavior:contain;list-style:none;scroll-padding:4px}
.dshm-picker__row{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-height:44px;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;touch-action:manipulation}
.dshm-picker__folder{flex:none;width:20px;height:20px;color:var(--dsw-alias-label-secondary,#606873)}
.dshm-picker__name{flex:1;min-width:0;overflow-wrap:anywhere}.dshm-picker__row:hover:not(:disabled),.dshm-picker__button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#eef1f5)}
.dshm-picker__row:active:not(:disabled),.dshm-picker__button:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,#e4e8ee)}
.dshm-picker__button{flex:none;box-sizing:border-box;min-width:48px;min-height:48px;padding:10px 14px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:10px;background:transparent;color:inherit;font:500 14px/1.4 system-ui;cursor:pointer;touch-action:manipulation}
.dshm-picker :is(button,input):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2563eb);outline-offset:2px}.dshm-picker button:disabled{opacity:.5;cursor:default}
.dshm-picker [hidden]{display:none!important}.dshm-picker__create{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:12px 16px}
.dshm-picker__create-title{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary,#606873)}
.dshm-picker__create-input{box-sizing:border-box;width:100%;min-width:0;min-height:48px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:16px;line-height:1.4}
.dshm-picker__create-actions{display:flex;justify-content:flex-end;gap:8px}.dshm-picker__create-error{color:var(--dsw-alias-state-error-primary,#b42318)}
.dshm-picker__create-trigger{margin-right:auto}
.dshm-picker__status{flex:none;margin:0;padding:8px 16px;font-size:13px;color:var(--dsw-alias-label-secondary,#606873);overflow-wrap:anywhere}.dshm-picker__error{color:var(--dsw-alias-state-error-primary,#b42318)}
.dshm-picker__status[hidden],.dshm-picker__button[hidden]{display:none}.dshm-picker__footer{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;flex:none;gap:8px;padding:16px 24px;border-top:1px solid var(--dsw-alias-border-l2,#dde0e4)}
.dshm-picker__confirm{border-color:transparent;background:var(--dsw-alias-button-primary-fill,#2563eb);color:var(--dsw-alias-label-primary-foreground,#fff)}.dshm-picker__confirm:hover:not(:disabled),.dshm-picker__confirm:active:not(:disabled){background:var(--dsw-alias-button-primary-hover,#1d4ed8)}
@media(max-width:420px){dialog.dshm-picker{padding:max(8px,env(safe-area-inset-top)) max(8px,env(safe-area-inset-right)) max(8px,env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left))}.dshm-picker__header,.dshm-picker__toolbar,.dshm-picker__footer{padding-left:12px;padding-right:12px}.dshm-picker__footer .dshm-picker__button{flex:1}.dshm-picker__path-label{min-width:0}}
`

interface DirectoryDialogOwner { setHostBusy(value: boolean): void; dispose(): Promise<void> }

/**
 * Whether DSH's own browse directory picker is already mounted on this page.
 *
 * DSH's adaptive `directory-picker` resolves to
 * `@deepseek-ai/dsh-host-directory-picker-auto`, which mounts the Host backend
 * and the Client face together and picks `browse` whenever the host is remotely
 * reachable. Its client face fills the same directory-flow slots this plugin
 * would use, so a plugin-owned picker would shadow the upstream one and take
 * away its folder creation. The desktop keeps the native OS chooser; a remote
 * browser can only reach the web implementation.
 *
 * @returns true when the upstream browse surface owns those slots on this page.
 */
export function hasUpstreamBrowsePicker(view: object): boolean {
  if (!('__DSH_BOOT__' in view)) return false
  const graph = view.__DSH_BOOT__
  if (typeof graph !== 'object' || graph === null || !('entries' in graph) || !Array.isArray(graph.entries)) return false
  return graph.entries.some((entry: unknown) => typeof entry === 'object' && entry !== null
    && 'id' in entry && entry.id === '@deepseek-ai/dsh-client-ui-directory-picker-browse')
}

function openDirectoryDialog(doc: Document, getProps: () => DirectoryFlowProps, trackDisposal: (task: Promise<void>) => void): DirectoryDialogOwner {
  const view = doc.defaultView
  if (view === null) throw new Error('Directory picker requires a browser window')
  const copy = MESSAGES[localeOf(doc)]
  const active = doc.activeElement
  const activeText = active instanceof HTMLElement && (active.isContentEditable || active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
  const trigger = active instanceof HTMLElement && !activeText ? active : undefined
  if (activeText) active.blur()
  const dialog = doc.createElement('dialog'); dialog.className = 'dshm-picker'; dialog.lang = localeOf(doc)
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', copy.title)
  dialog.setAttribute('data-dshm-picker-dialog', 'true')
  const panel = doc.createElement('section'); panel.className = 'dshm-picker__panel'
  const button = (text: string, name?: string): HTMLButtonElement => {
    const value = doc.createElement('button'); value.type = 'button'; value.textContent = text; value.className = 'dshm-picker__button'
    if (name !== undefined) value.setAttribute(`data-dshm-picker-${name}`, '')
    return value
  }
  const header = doc.createElement('header'); header.className = 'dshm-picker__header'
  const title = doc.createElement('h2'); title.className = 'dshm-picker__title'; title.textContent = copy.title
  const close = button(copy.close); header.append(title, close)
  const toolbar = doc.createElement('form'); toolbar.className = 'dshm-picker__toolbar'
  const pathLabel = doc.createElement('label'); pathLabel.className = 'dshm-picker__path-label'; pathLabel.textContent = copy.path
  const path = doc.createElement('input'); path.type = 'text'; path.className = 'dshm-picker__path'; path.setAttribute('data-dshm-picker-path', ''); path.spellcheck = false; path.autocomplete = 'off'; path.maxLength = 8192
  pathLabel.append(path)
  const go = button(copy.go, 'load'); go.type = 'submit'; go.classList.add('dshm-picker__go'); toolbar.append(pathLabel, go)
  const navigation = doc.createElement('nav'); navigation.className = 'dshm-picker__navigation'; navigation.setAttribute('aria-label', copy.title)
  const home = button(copy.home, 'home'); const up = button(copy.up, 'up'); navigation.append(home, up)
  const status = doc.createElement('p'); status.className = 'dshm-picker__status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
  const error = doc.createElement('p'); error.className = 'dshm-picker__status dshm-picker__error'; error.setAttribute('role', 'alert'); error.hidden = true
  const list = doc.createElement('ul'); list.className = 'dshm-picker__list'; list.setAttribute('aria-label', copy.title)
  const footer = doc.createElement('footer'); footer.className = 'dshm-picker__footer'
  const retry = button(copy.retry, 'retry'); retry.hidden = true
  const create = button(copy.create, 'create'); create.classList.add('dshm-picker__create-trigger')
  const cancel = button(copy.cancel, 'cancel'); const confirm = button(copy.open, 'confirm'); confirm.classList.add('dshm-picker__confirm')
  const createPanel = doc.createElement('div'); createPanel.className = 'dshm-picker__create'; createPanel.hidden = true
  const createTitle = doc.createElement('label'); createTitle.className = 'dshm-picker__create-title'; createTitle.textContent = copy.createTitle
  const createInput = doc.createElement('input'); createInput.type = 'text'; createInput.className = 'dshm-picker__create-input'
  createInput.setAttribute('data-dshm-picker-create-name', ''); createInput.spellcheck = false; createInput.autocomplete = 'off'; createInput.maxLength = 255
  createTitle.append(createInput)
  const createParent = doc.createElement('p'); createParent.className = 'dshm-picker__status'
  const createStatus = doc.createElement('p'); createStatus.className = 'dshm-picker__status'; createStatus.setAttribute('role', 'status'); createStatus.setAttribute('aria-live', 'polite')
  const createError = doc.createElement('p'); createError.className = 'dshm-picker__status dshm-picker__create-error'; createError.setAttribute('role', 'alert'); createError.setAttribute('data-dshm-picker-create-error', ''); createError.hidden = true
  const createActions = doc.createElement('div'); createActions.className = 'dshm-picker__create-actions'
  const createCancel = button(copy.cancel, 'create-cancel'); const createConfirm = button(copy.createAction, 'create-confirm')
  createActions.append(createCancel, createConfirm)
  createPanel.append(createParent, createTitle, createError, createStatus, createActions)
  footer.append(create, retry, cancel, confirm); panel.append(header, toolbar, navigation, status, error, list, createPanel, footer); dialog.append(panel)
  const browser = new MobileDirectoryBrowser(readDirectories)
  const creator = new MobileDirectoryCreator(createDirectory, created => { browser.navigate(created) })
  let creationNotice = false
  let creationNoticeListing: ReturnType<MobileDirectoryBrowser['getSnapshot']>['listing'] = null
  const closeCreate = (): void => {
    const child = creator.getSnapshot()
    if (child.pending || child.error === 'timeout' || child.error === 'request-failed' || child.error === 'invalid-response') {
      creationNotice = true
      creationNoticeListing = browser.getSnapshot().listing
    }
    if (creator.close()) { if (create.disabled) close.focus(); else create.focus() }
  }
  create.addEventListener('click', () => {
    const parent = browser.getSnapshot().listing?.path
    if (!browser.canConfirm() || parent === undefined || !creator.open(parent)) return
    creationNotice = false
    createInput.focus(); createInput.select()
  })
  createCancel.addEventListener('click', closeCreate)
  createConfirm.addEventListener('click', () => { creator.submit() })
  createInput.addEventListener('input', () => { creator.setName(createInput.value) })
  createInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); creator.submit() }
  })
  let disposed = false
  let closedByOwner = false
  let renderedListing: ReturnType<MobileDirectoryBrowser['getSnapshot']>['listing']
  let disposal: Promise<void> | undefined
  const render = (): void => {
    if (disposed) return
    const state = browser.getSnapshot()
    if (creationNotice && state.listing !== creationNoticeListing) creationNotice = false
    const child = creator.getSnapshot()
    const adopting = state.committed || state.hostBusy
    const blocked = adopting || state.creating
    path.disabled = blocked
    if (path.value !== state.draft) path.value = state.draft
    path.setAttribute('aria-invalid', String(state.error === 'bad-path'))
    go.disabled = blocked || state.phase === 'loading' || !isMobileDirectoryPath(state.draft)
    home.disabled = blocked; up.disabled = blocked || state.listing?.parent === undefined
    confirm.disabled = !browser.canConfirm(); cancel.disabled = adopting; close.disabled = adopting
    retry.hidden = state.phase !== 'error' || state.error === 'bad-path'; retry.disabled = blocked
    create.disabled = !browser.canConfirm()
    title.textContent = child.open ? copy.create : copy.title
    toolbar.hidden = child.open; navigation.hidden = child.open; list.hidden = child.open; footer.hidden = child.open
    createPanel.hidden = !child.open
    if (createInput.value !== child.name) createInput.value = child.name
    createInput.disabled = child.pending
    createInput.setAttribute('aria-invalid', String(child.error === 'invalid-name'))
    createConfirm.disabled = child.pending || !isMobileDirectoryName(child.name.trim())
    createParent.textContent = `${copy.createParent}: ${child.parent ?? ''}`
    createError.textContent = child.error === null ? '' : child.error === 'invalid-name' ? copy.createInvalid
      : child.error === 'directory-exists' ? copy.createExists : child.error === 'directory-create-failed' ? copy.createFailed
        : child.error === 'unauthorized' ? copy.unauthorized : copy.createUnknown
    createError.hidden = child.error === null
    createStatus.textContent = child.pending && child.error === null ? copy.creating : ''
    createStatus.hidden = createStatus.textContent === ''
    status.textContent = child.pending ? copy.createStopping : creationNotice ? copy.createUnknown : adopting ? copy.adopting : state.phase === 'loading' ? copy.loading
      : state.listing?.truncated === true ? copy.truncated : state.listing?.entries.length === 0 ? copy.empty : ''
    status.hidden = child.open || status.textContent === ''
    error.textContent = state.error === null ? '' : copy[state.error]; error.hidden = child.open || state.error === null
    list.setAttribute('aria-busy', String(state.phase === 'loading'))
    if (renderedListing !== state.listing) {
      renderedListing = state.listing; list.replaceChildren()
      for (const entry of state.listing?.entries ?? []) {
        const item = doc.createElement('li'); const row = button(''); row.className = 'dshm-picker__row'
        const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
        icon.setAttribute('class', 'dshm-picker__folder'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('viewBox', '0 0 24 24')
        icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.5')
        const outline = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
        outline.setAttribute('d', 'M3 7V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z')
        icon.append(outline)
        const name = doc.createElement('span'); name.className = 'dshm-picker__name'; name.textContent = entry.name
        row.append(icon, name); row.addEventListener('click', () => { browser.navigate(entry.path) }); item.append(row); list.append(item)
      }
    }
    for (const row of list.querySelectorAll('button')) row.disabled = blocked
  }
  const unsubscribe = browser.subscribe(render)
  const unsubscribeCreate = creator.subscribe(() => {
    const child = creator.getSnapshot()
    browser.setCreating(child.open || child.pending)
    render()
  })
  const requestClose = (): void => {
    if (creator.getSnapshot().open) { closeCreate(); return }
    if (disposed || !browser.cancel()) return
    creator.close()
    // Close the modal immediately; the React owner withdraws its open edge separately.
    closedByOwner = true
    if (dialog.open) dialog.close()
    getProps().onCancel()
  }
  const onBack = (event: Event): void => {
    if (!event.cancelable || event.defaultPrevented || !dialog.open) return
    event.preventDefault(); event.stopImmediatePropagation(); requestClose()
  }
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.defaultPrevented || !dialog.open) return
    event.preventDefault(); event.stopImmediatePropagation(); requestClose()
  }
  const dispose = (): Promise<void> => {
    if (disposal !== undefined) return disposal
    disposed = true; unsubscribe(); unsubscribeCreate()
    const creationStopped = creator.dispose()
    const stopped = browser.dispose()
    const failures: unknown[] = []
    const clean = (action: () => void): void => { try { action() } catch (error) { failures.push(error) } }
    clean(() => { view.removeEventListener('dsh-mobile:native-back', onBack, true) })
    clean(() => { view.removeEventListener('keydown', onEscape, true) })
    closedByOwner = true
    clean(() => { if (dialog.open) dialog.close() })
    clean(() => { dialog.remove() })
    clean(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }) })
    disposal = (async () => {
      for (const result of await Promise.allSettled([stopped, creationStopped])) if (result.status === 'rejected') failures.push(result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'Mobile directory dialog disposal failed')
    })()
    return disposal
  }
  toolbar.addEventListener('submit', event => { event.preventDefault(); browser.navigate(path.value) })
  path.addEventListener('input', () => { browser.setDraft(path.value) })
  home.addEventListener('click', () => { browser.navigate(null) })
  up.addEventListener('click', () => { const parent = browser.getSnapshot().listing?.parent; if (parent !== undefined) browser.navigate(parent) })
  retry.addEventListener('click', () => { browser.retry() })
  cancel.addEventListener('click', requestClose); close.addEventListener('click', requestClose)
  confirm.addEventListener('click', () => {
    const picked = browser.confirm()
    if (picked !== undefined) getProps().onPicked(picked)
  })
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose() })
  dialog.addEventListener('dsh-mobile:directory-picker-dismiss', event => {
    if (!dialog.open || disposed || !event.cancelable) return
    event.preventDefault(); requestClose()
  })
  dialog.addEventListener('click', event => { if (event.target === dialog) requestClose() })
  dialog.addEventListener('close', () => {
    if (!disposed && !closedByOwner && browser.cancel()) getProps().onCancel()
  })
  view.addEventListener('dsh-mobile:native-back', onBack, true); view.addEventListener('keydown', onEscape, true)
  try {
    doc.body.append(dialog); dialog.showModal(); close.focus({ preventScroll: true }); browser.start(); browser.setHostBusy(getProps().busy === true)
  } catch (error) {
    trackDisposal(dispose())
    throw error
  }
  return { setHostBusy: value => { browser.setHostBusy(value) }, dispose }
}

/** Register two public directory flows and drain their read work before removing styles. */
export function installMobileDirectoryPicker(ctx: DirectoryPickerSlots, doc: Document): () => Promise<void> {
  const style = doc.createElement('style'); style.dataset.plugin = 'dsh-mobile-directory-picker'; style.textContent = STYLES; doc.head.append(style)
  const owners = new Set<DirectoryDialogOwner>()
  const pending = new Set<Promise<void>>()
  const cleanupFailures: unknown[] = []
  let disposed = false
  const trackDisposal = (task: Promise<void>): void => {
    pending.add(task)
    void task.then(() => { pending.delete(task) }, error => {
      pending.delete(task); cleanupFailures.push(error); console.error('DSH Mobile directory picker cleanup failed')
    })
  }
  const retire = (owner: DirectoryDialogOwner): void => {
    if (owners.delete(owner)) trackDisposal(owner.dispose())
  }
  function MobileDirectoryFlow(props: DirectoryFlowProps): null {
    const current = useRef(props); current.current = props
    const owner = useRef<DirectoryDialogOwner | undefined>(undefined)
    useEffect(() => {
      if (!props.open || disposed) return
      try {
        const dialog = openDirectoryDialog(doc, () => current.current, trackDisposal)
        owners.add(dialog); owner.current = dialog
        return () => { owner.current = undefined; retire(dialog) }
      } catch (error) {
        console.error('DSH Mobile directory picker could not open')
        current.current.onError(MESSAGES[localeOf(doc)].failedOpen)
        void error
      }
    }, [props.open])
    useEffect(() => { owner.current?.setHostBusy(props.busy === true) }, [props.busy])
    return null
  }
  let remove: () => void
  try {
    remove = ctx.slots.inject('sidebar.workspaces.directoryFlow', () => ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => {
      const removeSidebar = ctx.slots.register<DirectoryFlowProps>({ name: 'sidebar.workspaces.directoryFlow', id: 'dsh-mobile-directory-picker', priority: -1 }, MobileDirectoryFlow)
      let removeHero: () => void
      try { removeHero = ctx.slots.register<DirectoryFlowProps>({ name: 'conversation.hero.workspace.directoryFlow', id: 'dsh-mobile-directory-picker', priority: -1 }, MobileDirectoryFlow) }
      catch (error) { removeSidebar(); throw error }
      return () => { removeHero(); removeSidebar() }
    }))
  } catch (error) { style.remove(); throw error }
  return async () => {
    disposed = true
    const failures: unknown[] = []
    try { remove() } catch (error) { failures.push(error) }
    for (const owner of [...owners]) {
      try { retire(owner) } catch (error) { failures.push(error) }
    }
    await Promise.allSettled([...pending])
    style.remove()
    failures.push(...cleanupFailures)
    if (failures.length > 0) throw new AggregateError(failures, 'Mobile directory picker disposal failed')
  }
}
