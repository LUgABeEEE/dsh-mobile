/** Experimental iroh remote transport as a first-class remote provider.
 *
 * The sidecar is distributed by this plugin itself: an explicit install
 * downloads a pinned release into the plugin private directory (an installed
 * companion copy is reused without downloading during the transition). The
 * controller owns exactly one sidecar child process plus one dedicated
 * loopback gateway, and status flows through the same coordinator, control
 * routes and task-event fan-out as every other remote provider. Enabling the
 * channel never downloads anything; only the install button may fetch bytes.
 * `ready` therefore means the sidecar is connected and the gateway serves
 * its loopback socket.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { restrictPrivateDirectory } from './private-file.js'
import type { MobileAccessControlState, MobileAccessControlStore } from './control.js'
import type { MobileAccessGateway } from './gateway.js'
import type { IrohComponentManager } from './iroh-component.js'
import { decodeIrohEvent, encodeIrohCommand, validateIrohProxyTarget, type IrohSidecarEvent } from './iroh-sidecar.js'
import { DEFAULT_IROH_LOCAL_PORT, irohOrigin } from './iroh-origin.js'
import { encodePairingDescriptor, MAX_PAIRING_LIFETIME_MS, type IrohPairingDescriptor } from './iroh-pairing.js'
import { settleRemoteResources, terminateRemoteProcess, type RemoteProviderController, type RemoteProviderStatus } from './remote.js'

const READY_TIMEOUT_MS = 45_000
const IDENTITY_TIMEOUT_MS = 15_000
const PAIRING_TIMEOUT_MS = 15_000
const MAX_LINE_BYTES = 16 * 1024
/** Gateway pairing windows default to five minutes; the descriptor caps at ten. */
const MAX_PAIRING_WINDOW_MS = 300_000
const MIN_PAIRING_WINDOW_MS = 10_000

/** Product-facing states for the experimental iroh transport. */
export type IrohState = 'off' | 'unavailable' | 'starting' | 'connecting' | 'ready' | 'error'

/** Safe iroh state returned only through the loopback DSH control route. */
export interface IrohStatus extends RemoteProviderStatus {
  readonly state: IrohState
}

/** Inputs for one iroh sidecar process and dedicated DSH gateway. */
export interface IrohControllerOptions {
  readonly store: MobileAccessControlStore
  readonly component: IrohComponentManager
  /** Private directory owning the sidecar `--data-dir`. */
  readonly dataDirectory: string
  readonly createGateway: (endpointId: string) => Promise<MobileAccessGateway>
  /** Read the pairing CA DER plus the fingerprint the gateway advertises. */
  readonly resolvePairingCa?: () => Promise<{ der: Buffer; fingerprint: string }>
  readonly onStatus?: (status: IrohStatus) => void
  readonly launchSidecar?: (executable: string, args: readonly string[]) => ChildProcessWithoutNullStreams
  readonly resolveIdentity?: (executable: string, dataDir: string) => Promise<string>
  readonly readyTimeoutMs?: number
  readonly pairingTimeoutMs?: number
}

/** Short-lived pairing material minted for one QR code. */
export interface IrohPairingResult {
  readonly descriptor: IrohPairingDescriptor
  /** Canonical JSON payload rendered into the QR code. */
  readonly encoded: string
  /** Six-digit sidecar code for manual confirmation. */
  readonly code: string
  readonly expiresAt: number
}

function publicStatus(status: IrohStatus): IrohStatus {
  return Object.freeze({ ...status })
}

async function defaultResolveIdentity(executable: string, dataDir: string): Promise<string> {
  const child = spawn(executable, ['--lang', 'en', 'id', '--data-dir', dataDir], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = Buffer.alloc(0)
  const result = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill()
      reject(new Error('iroh_identity_timeout'))
    }, IDENTITY_TIMEOUT_MS)
    deadline.unref?.()
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > 128) {
        child.kill()
        reject(new Error('iroh_identity_output_too_large'))
        return
      }
      output = Buffer.concat([output, chunk])
    })
    child.stderr?.resume()
    child.once('error', () => {
      clearTimeout(deadline)
      reject(new Error('iroh_identity_failed'))
    })
    child.once('close', code => {
      clearTimeout(deadline)
      let id = ''
      try { id = new TextDecoder('utf-8', { fatal: true }).decode(output).trim() } catch { reject(new Error('iroh_identity_invalid')); return }
      if (code !== 0 || !/^[0-9a-f]{64}$/u.test(id)) reject(new Error('iroh_identity_invalid'))
      else resolve(id)
    })
  })
  return result
}

export class IrohController implements RemoteProviderController {
  private enabled = false
  private initialized = false
  private disposed = false
  private generation = 0
  private queue: Promise<void> = Promise.resolve()
  private latest: IrohStatus = publicStatus({ enabled: false, state: 'off' })
  private gatewayValue: MobileAccessGateway | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private endpointId: string | undefined

  constructor(private readonly options: IrohControllerOptions) {
    if (typeof options.dataDirectory !== 'string' || options.dataDirectory === '') throw new Error('iroh data directory invalid')
    if (typeof options.createGateway !== 'function') throw new Error('iroh gateway factory invalid')
  }

  async initialize(initialState?: MobileAccessControlState): Promise<void> {
    const state = initialState ?? await this.options.store.load()
    this.enabled = state.enabled
    this.initialized = true
    if (this.enabled) await this.start()
    else this.publish({ enabled: false, state: 'off' })
  }

  /** Return the active iroh-backed DSH gateway. */
  gateway(): MobileAccessGateway | undefined {
    return this.gatewayValue
  }

  /** Return state safe for the desktop control UI. */
  status(): IrohStatus {
    return this.latest
  }

  async setEnabled(enabled: boolean): Promise<IrohStatus> {
    if (!this.initialized || this.disposed) throw new Error('iroh controller is unavailable')
    await this.enqueue(async () => {
      if (this.enabled === enabled && (enabled === false || this.child !== undefined)) return
      await this.options.store.save({ version: 1, enabled })
      this.enabled = enabled
      if (!enabled) await this.stop()
      if (enabled) await this.start()
      else this.publish({ enabled: false, state: 'off' })
    })
    return this.status()
  }

  /** Restart iroh while retaining its sidecar identity and devices. */
  async reconnect(): Promise<IrohStatus> {
    if (!this.initialized || this.disposed) throw new Error('iroh controller is unavailable')
    await this.enqueue(async () => {
      if (!this.enabled) {
        await this.options.store.save({ version: 1, enabled: true })
        this.enabled = true
      }
      await this.stop()
      await this.start()
    })
    return this.status()
  }

  /** Disable iroh without deleting its sidecar identity or companion files. */
  async reset(): Promise<IrohStatus> {
    if (!this.initialized || this.disposed) throw new Error('iroh controller is unavailable')
    await this.enqueue(async () => {
      await this.options.store.save({ version: 1, enabled: false })
      this.enabled = false
      await this.stop()
      this.publish({ enabled: false, state: 'off' })
    })
    return this.status()
  }

  /**
   * Mint one short-lived pairing descriptor for a QR code.
   *
   * Requires a live channel: the sidecar issues its six-digit code while the
   * gateway opens a one-time pairing window, and the descriptor binds both to
   * the pinned CA. Opening again replaces both windows without returning the
   * replaced secrets. The Phase 2 phone redeems the gateway token through the
   * ordinary pair endpoint over the iroh transport.
   */
  async beginPairing(): Promise<IrohPairingResult> {
    if (!this.initialized || this.disposed) throw new Error('iroh controller is unavailable')
    return this.enqueue(async () => {
      const generation = this.generation
      const child = this.child
      const gateway = this.gatewayValue
      const endpointId = this.endpointId
      if (!this.enabled || child === undefined || gateway === undefined || endpointId === undefined) {
        throw new Error('iroh_not_ready')
      }
      // The sidecar emits one pairing window on its own at startup when no
      // devices are paired yet, and every completed pairing leaves its own
      // terminal events behind. Drain anything already buffered so the code
      // below always redeems a window this call minted; otherwise the panel
      // would render a stale code the sidecar has already replaced.
      let buffered: unknown
      do { buffered = child.stdout.read() } while (buffered !== null)
      try {
        child.stdin.write(encodeIrohCommand({ version: 1, type: 'pairing-begin' }))
      } catch {
        throw new Error('iroh_not_ready')
      }
      const pairing = await this.waitForPairingCode(child, this.options.pairingTimeoutMs ?? PAIRING_TIMEOUT_MS)
      if (generation !== this.generation || !this.enabled || this.child !== child || this.gatewayValue !== gateway) {
        throw new Error('iroh_not_ready')
      }
      if (pairing === undefined) throw new Error('iroh_pairing_failed')
      const ttlMs = Math.min(Math.max(pairing.expiresInSec * 1000, MIN_PAIRING_WINDOW_MS), MAX_PAIRING_WINDOW_MS)
      const opened = await gateway.access.openPairing(ttlMs).catch((error: unknown) => {
        throw new Error('iroh_pairing_failed', { cause: error })
      })
      const expiresAt = Math.min(Date.now() + pairing.expiresInSec * 1000, opened.expiresAt)
      if (expiresAt - Date.now() > MAX_PAIRING_LIFETIME_MS) throw new Error('iroh_pairing_failed')
      const resolvePairingCa = this.options.resolvePairingCa
      if (resolvePairingCa === undefined) throw new Error('iroh_pairing_failed')
      const ca = await resolvePairingCa().catch((error: unknown) => {
        throw new Error('iroh_pairing_failed', { cause: error })
      })
      const descriptor = {
        version: 1 as const,
        type: 'dsh-mobile-iroh-pairing' as const,
        endpointId,
        origin: irohOrigin(endpointId, DEFAULT_IROH_LOCAL_PORT),
        localPort: DEFAULT_IROH_LOCAL_PORT,
        irohCode: pairing.code,
        gatewayToken: opened.token,
        caCertificate: ca.der.toString('base64'),
        instanceId: ca.fingerprint,
        expiresAt,
      }
      const encoded = encodePairingDescriptor(descriptor)
      return { descriptor: JSON.parse(encoded) as IrohPairingDescriptor, encoded, code: pairing.code, expiresAt }
    })
  }

  /** Stop all iroh resources without changing the remembered switch. */
  async close(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.enqueue(() => this.stop())
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private publish(status: IrohStatus): void {
    this.latest = publicStatus(status)
    try { this.options.onStatus?.(this.status()) } catch { /* UI observation cannot own runtime state. */ }
  }

  private async failGeneration(generation: number, errorCode: string, origin?: string): Promise<void> {
    if (generation !== this.generation) return
    await this.stopResources()
    if (generation !== this.generation) return
    this.publish({ enabled: this.enabled, state: 'error', ...(origin === undefined ? {} : { origin }), errorCode })
  }

  private async stop(): Promise<void> {
    this.generation += 1
    await this.stopResources()
  }

  private async stopResources(): Promise<void> {
    const child = this.child
    const gateway = this.gatewayValue
    this.child = undefined
    this.gatewayValue = undefined
    this.endpointId = undefined
    await settleRemoteResources([
      async () => {
        if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
        try { child.stdin.write(encodeIrohCommand({ version: 1, type: 'shutdown' })) } catch { /* fall through to terminate */ }
        await terminateRemoteProcess(child)
      },
      async () => { await gateway?.close() },
    ], 'iroh resource cleanup failed')
  }

  private async start(): Promise<void> {
    const generation = ++this.generation
    let executable: string | undefined
    try {
      // Starting must never download: only the explicit install button may
      // fetch the pinned sidecar.
      const available = await this.options.component.ensureAvailable()
      executable = this.options.component.executable ?? available.storagePath
    } catch {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'iroh_companion_missing' })
      return
    }
    if (generation !== this.generation || !this.enabled) return
    if (executable === undefined) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'iroh_companion_missing' })
      return
    }
    await mkdir(this.options.dataDirectory, { recursive: true, mode: 0o700 }).catch(() => { throw new Error('iroh_data_directory_invalid') })
    // The sidecar verifies the data directory and every ancestor before it
    // trusts any identity material: lock our own leaf up front so an
    // inherited group grant cannot fail the launch opaquely later.
    // Ancestors outside the plugin state stay untouched.
    await restrictPrivateDirectory(this.options.dataDirectory).catch(() => { throw new Error('iroh_data_directory_invalid') })
    if (generation !== this.generation || !this.enabled) return
    let endpointId: string
    try {
      endpointId = await (this.options.resolveIdentity ?? defaultResolveIdentity)(executable, this.options.dataDirectory)
    } catch {
      await this.failGeneration(generation, 'iroh_identity_failed')
      return
    }
    if (generation !== this.generation || !this.enabled) return
    const origin = irohOrigin(endpointId)
    this.publish({ enabled: true, state: 'starting', origin })
    let gateway: MobileAccessGateway
    try {
      gateway = await this.options.createGateway(endpointId)
    } catch {
      await this.failGeneration(generation, 'gateway_start_failed', origin)
      return
    }
    if (generation !== this.generation || !this.enabled) {
      await gateway.close()
      return
    }
    this.gatewayValue = gateway
    let proxyTarget: string
    try {
      proxyTarget = validateIrohProxyTarget(`http://127.0.0.1:${gateway.address().port}/`)
    } catch {
      await this.failGeneration(generation, 'gateway_start_failed', origin)
      return
    }
    if (generation !== this.generation || !this.enabled) return
    let child: ChildProcessWithoutNullStreams
    try {
      const launcher = this.options.launchSidecar
        ?? ((file, args) => spawn(file, [...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }))
      child = launcher(executable, ['--lang', 'en', 'host', '--data-dir', this.options.dataDirectory, '--proxy-target', `127.0.0.1:${gateway.address().port}`])
    } catch {
      await this.failGeneration(generation, 'iroh_launch_failed', origin)
      return
    }
    this.child = child
    // An unexpected exit must surface instead of stranding a stale ready
    // state: every path below re-checks the generation, so orderly stops
    // (which advance it first) stay silent.
    child.once('error', () => { void this.enqueue(() => this.failGeneration(generation, 'iroh_exited', origin)) })
    child.once('close', () => { void this.enqueue(() => this.failGeneration(generation, 'iroh_exited', origin)) })
    child.stdin.on('error', () => { void this.enqueue(() => this.failGeneration(generation, 'iroh_exited', origin)) })
    this.publish({ enabled: true, state: 'connecting', origin })
    try {
      const ready = await this.waitForReady(child, endpointId, this.options.readyTimeoutMs ?? READY_TIMEOUT_MS)
      if (generation !== this.generation || !this.enabled) return
      if (!ready) {
        await this.failGeneration(generation, 'iroh_start_timeout', origin)
        return
      }
      this.endpointId = endpointId
      this.publish({ enabled: true, state: 'ready', origin })
    } catch {
      await this.failGeneration(generation, 'iroh_start_failed', origin)
    }
  }

  private waitForReady(child: ChildProcessWithoutNullStreams, endpointId: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      let pending = Buffer.alloc(0)
      let settled = false
      const finish = (ready: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        child.stdout.off('data', onData)
        resolve(ready)
      }
      const deadline = setTimeout(() => finish(false), timeoutMs)
      deadline.unref?.()
      const onData = (chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (pending.length + buffer.length > 64 * MAX_LINE_BYTES) {
          finish(false)
          return
        }
        pending = Buffer.concat([pending, buffer])
        let index = pending.indexOf(0x0a)
        while (index !== -1) {
          const line = pending.subarray(0, index).toString('utf8')
          pending = pending.subarray(index + 1)
          let event: IrohSidecarEvent
          try { event = decodeIrohEvent(line) } catch { finish(false); return }
          if (event.type === 'ready') {
            finish(event.endpoint_id === endpointId)
            return
          }
          if (event.type === 'error') {
            finish(false)
            return
          }
          index = pending.indexOf(0x0a)
        }
      }
      child.stdout.on('data', onData)
      child.once('error', () => finish(false))
      child.once('close', () => finish(false))
    })
  }

  private waitForPairingCode(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ): Promise<{ code: string; expiresInSec: number } | undefined> {
    return new Promise(resolve => {
      let pending = Buffer.alloc(0)
      let settled = false
      const finish = (pairing: { code: string; expiresInSec: number } | undefined): void => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        child.stdout.off('data', onData)
        resolve(pairing)
      }
      const deadline = setTimeout(() => finish(undefined), timeoutMs)
      deadline.unref?.()
      const onData = (chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (pending.length + buffer.length > 64 * MAX_LINE_BYTES) {
          finish(undefined)
          return
        }
        pending = Buffer.concat([pending, buffer])
        let index = pending.indexOf(0x0a)
        while (index !== -1) {
          const line = pending.subarray(0, index).toString('utf8')
          pending = pending.subarray(index + 1)
          let event: IrohSidecarEvent
          try { event = decodeIrohEvent(line) } catch { finish(undefined); return }
          if (event.type === 'pairing') {
            finish({ code: event.code, expiresInSec: event.expires_in_sec })
            return
          }
          if (event.type === 'error') {
            finish(undefined)
            return
          }
          index = pending.indexOf(0x0a)
        }
      }
      child.stdout.on('data', onData)
      child.once('error', () => finish(undefined))
      child.once('close', () => finish(undefined))
    })
  }
}
