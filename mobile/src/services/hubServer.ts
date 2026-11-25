import { fetchWithTimeout } from '@/services/http'
import { storage } from '@/services/storage'
import type { RemoteDeviceState, RemoteDeviceSummary } from '@/services/remoteControl'

/**
 * Client side of the SelfHost Hub server (docs/server-protocol.md, v2): remote control and the shared listening data
 * go through a server at home instead of the PC being the hub. Devices sign in with their Navidrome account: the
 * password never leaves the phone, only md5(password + the server's nonce) does (the Subsonic token scheme).
 */

export const PROTOCOL_VERSION = 2
/** A connection that has not been welcomed after this long is given up (the server drops it at 10 s too). */
const HANDSHAKE_TIMEOUT_MS = 10_000
const HEALTH_TIMEOUT_MS = 5_000
/** Waits between tries to get a lost connection back; the last one repeats. */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/** After "too many attempts" the address is blocked for 10 minutes: no use trying sooner. */
const BLOCKED_RETRY_MS = 5 * 60_000
/** The WebSocket close code of a connection replaced by a newer one of the same device. */
const CLOSE_REPLACED = 4000

export function reconnectDelay(attempt: number): number {
  return RECONNECT_DELAYS_MS[Math.min(Math.max(0, attempt), RECONNECT_DELAYS_MS.length - 1)]
}

// --- Addresses ---

/** What was typed, as a base URL: trimmed, `http://` when no scheme was given, no trailing slash. Empty stays empty. */
export function normalizeServerUrl(input: string): string {
  let url = (input ?? '').trim()
  if (!url) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`
  return url.replace(/\/+$/, '')
}

/** Whether a normalised address is one that can be dialled: http or https, with a host. */
export function isValidServerUrl(base: string): boolean {
  return /^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i.test(base)
}

/** The WebSocket address of a server: http becomes ws, https becomes wss, and `/ws` is added. */
export function serverWsUrl(base: string): string {
  return `${normalizeServerUrl(base).replace(/^http/i, 'ws')}/ws`
}

export type HealthResult = { ok: true; name: string; version: string } | { ok: false; error: string }

/** Asks `GET {base}/api/health` (5 s at most) and says which server answered, or why none did. */
export async function checkHealth(base: string): Promise<HealthResult> {
  const url = normalizeServerUrl(base)
  if (!isValidServerUrl(url)) return { ok: false, error: 'Adresse invalide' }
  try {
    const res = await fetchWithTimeout(`${url}/api/health`, {}, HEALTH_TIMEOUT_MS)
    if (!res.ok) return { ok: false, error: `Le serveur a répondu ${res.status}` }
    const data = await res.json()
    if (data?.app !== 'selfhost-hub-server') return { ok: false, error: "Ce n'est pas un serveur SelfHost Hub" }
    return { ok: true, name: typeof data.name === 'string' ? data.name : '', version: typeof data.version === 'string' ? data.version : '' }
  } catch (err: any) {
    return { ok: false, error: err?.name === 'AbortError' ? 'Le serveur ne répond pas (délai dépassé)' : 'Serveur injoignable' }
  }
}

// --- Refusals ---

const REFUSALS: Record<string, string> = {
  'bad-auth': 'Identifiants Navidrome refusés',
  'navidrome-unreachable': 'Le serveur ne parvient pas à joindre Navidrome',
  'update-required': "Mettez l'application à jour",
  'too-many-attempts': "Trop d'essais : réessayez dans 10 minutes",
  'bad-hello': 'Demande de connexion invalide',
  'no-login': "Connectez-vous d'abord à Navidrome"
}

/** The French message for a reason the server gave for refusing (or `no-login`, when this phone has no Navidrome login). */
export function refusalMessage(reason: string): string {
  return REFUSALS[reason] ?? 'Connexion refusée par le serveur'
}

// --- Device id ---

function generateDeviceId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `device-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** This phone's id: the one remote control already kept (it must never change), else a new one, kept. */
export async function loadOrCreateDeviceId(): Promise<string> {
  const saved = await storage.loadPref<string>('remote.deviceId')
  if (saved) return saved
  const id = generateDeviceId()
  await storage.savePref('remote.deviceId', id)
  return id
}

// --- The connection ---

export type HubServerStatus = 'connecting' | 'connected' | 'refused' | 'stopped'

export interface HubServerInfo {
  /** The Navidrome user the server signed this phone in as. */
  user?: string
  serverName?: string
  serverVersion?: string
  /** For `refused`: the server's reason, and the French message for it. */
  reason?: string
  message?: string
}

export interface HubServerAuth {
  user: string
  token: string
}

export interface HubServerOptions {
  baseUrl: string
  deviceId: string
  deviceName: string
  /** The user and token for this challenge (md5(password + nonce)), or null when there is no Navidrome login. */
  getAuth: (nonce: string) => HubServerAuth | null
}

export interface ServerCommand {
  targetId: string
  fromId?: string
  action: string
  payload?: any
}

type StateMessage = { deviceId: string } & RemoteDeviceState

export class HubServerClient {
  status: HubServerStatus = 'stopped'
  info: HubServerInfo = {}

  private options: HubServerOptions
  private socket: WebSocket | null = null
  private generation = 0
  private attempt = 0
  private stopped = true
  private welcomed = false
  private refusal: string | null = null
  private serverName: string | undefined
  private serverVersion: string | undefined
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null

  private deviceHandlers: Array<(devices: RemoteDeviceSummary[]) => void> = []
  private stateHandlers: Array<(state: StateMessage) => void> = []
  private commandHandlers: Array<(command: ServerCommand) => void> = []
  private messageHandlers: Array<(message: Record<string, any>) => void> = []
  private statusHandlers: Array<(status: HubServerStatus, info: HubServerInfo) => void> = []

  constructor(options: HubServerOptions) {
    this.options = options
  }

  /** Dials the server, and again whenever the connection is lost, until stop(). */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    this.open()
  }

  /** Gives up the connection for good. */
  stop(): void {
    this.stopped = true
    this.generation++
    this.clearTimers()
    const socket = this.socket
    this.socket = null
    this.welcomed = false
    try {
      socket?.close()
    } catch {
      // already closed
    }
    this.setStatus('stopped', {})
  }

  /** Tries now instead of at the next backoff step (the network is back, the Navidrome login arrived). No-op when connected. */
  retryNow(force = false): void {
    if (this.stopped || this.status === 'connected') return
    if (this.status === 'connecting' && this.socket) return
    // A refusal that trying again cannot change (wrong password, old app) is not repeated by every network blip:
    // each wrong sign-in counts towards the server's block. `force` is for when something did change.
    const reason = this.info.reason
    if (!force && this.status === 'refused' && reason !== 'navidrome-unreachable') return
    this.attempt = 0
    this.open()
  }

  get connected(): boolean {
    return this.status === 'connected' && this.welcomed
  }

  onDevices(cb: (devices: RemoteDeviceSummary[]) => void): () => void {
    return subscribe(this.deviceHandlers, cb)
  }
  onState(cb: (state: StateMessage) => void): () => void {
    return subscribe(this.stateHandlers, cb)
  }
  onCommand(cb: (command: ServerCommand) => void): () => void {
    return subscribe(this.commandHandlers, cb)
  }
  /** Every other message once signed in: `listening.*`, `error`, whatever a newer server adds. */
  onMessage(cb: (message: Record<string, any>) => void): () => void {
    return subscribe(this.messageHandlers, cb)
  }
  onStatus(cb: (status: HubServerStatus, info: HubServerInfo) => void): () => void {
    return subscribe(this.statusHandlers, cb)
  }

  /** Sends one frame; false when there is no signed-in connection to send it on. */
  send(message: unknown): boolean {
    if (!this.welcomed || !this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    try {
      this.socket.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  sendState(state: RemoteDeviceState): void {
    this.send({ type: 'state', ...state })
  }

  sendCommand(targetId: string, action: string, payload?: unknown): void {
    this.send({ type: 'command', targetId, action, payload })
  }

  /** Same as stop(): lets the client stand in for the LAN one where a connection is closed. */
  close(): void {
    this.stop()
  }

  // --- Internals ---

  private setStatus(status: HubServerStatus, info?: HubServerInfo): void {
    this.status = status
    if (info) this.info = info
    for (const cb of [...this.statusHandlers]) cb(status, this.info)
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.retryTimer = null
    this.handshakeTimer = null
  }

  private open(): void {
    if (this.stopped) return
    this.clearTimers()
    const stale = this.socket
    const generation = ++this.generation
    this.socket = null
    try {
      stale?.close()
    } catch {
      // already closed
    }
    this.welcomed = false
    this.refusal = null
    this.setStatus('connecting', { serverName: this.serverName, serverVersion: this.serverVersion })

    let ws: WebSocket
    try {
      ws = new WebSocket(serverWsUrl(this.options.baseUrl))
    } catch {
      this.scheduleRetry()
      return
    }
    this.socket = ws
    this.handshakeTimer = setTimeout(() => {
      if (generation === this.generation && !this.welcomed) {
        try {
          ws.close()
        } catch {
          // already closed
        }
        // A socket that never opens may never report its closing: the retry does not wait for it.
        this.generation++
        this.socket = null
        this.scheduleRetry()
      }
    }, HANDSHAKE_TIMEOUT_MS)

    ws.onmessage = (event) => {
      if (generation === this.generation) this.handle(ws, event.data)
    }
    ws.onerror = () => {
      // onclose follows
    }
    ws.onclose = (event) => {
      if (generation === this.generation) this.closed(event?.code)
    }
  }

  private scheduleRetry(delay?: number): void {
    if (this.stopped) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const wait = delay ?? reconnectDelay(this.attempt++)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, wait)
  }

  private closed(code: number | undefined): void {
    this.socket = null
    this.welcomed = false
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
    if (this.stopped) return

    if (code === CLOSE_REPLACED) {
      // Another connection of this very device took over: fighting it would make the two replace each other for ever.
      this.setStatus('refused', { ...this.info, reason: 'replaced', message: 'Connexion remplacée par une autre session de cet appareil' })
      return
    }
    if (this.refusal) {
      const reason = this.refusal
      this.refusal = null
      // Only a Navidrome the server could not reach, or a block that ends, can get better by itself.
      if (reason === 'navidrome-unreachable') this.scheduleRetry()
      else if (reason === 'too-many-attempts') this.scheduleRetry(BLOCKED_RETRY_MS)
      return
    }
    this.setStatus('connecting', { serverName: this.serverName, serverVersion: this.serverVersion })
    this.scheduleRetry()
  }

  private refuse(ws: WebSocket, reason: string): void {
    this.refusal = reason
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
    this.setStatus('refused', { serverName: this.serverName, serverVersion: this.serverVersion, reason, message: refusalMessage(reason) })
    try {
      ws.close()
    } catch {
      // the server closes it anyway
    }
  }

  private handle(ws: WebSocket, data: unknown): void {
    let msg: Record<string, any>
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return

    if (msg.type === 'challenge') {
      if (this.welcomed || typeof msg.nonce !== 'string') return
      this.serverName = typeof msg.serverName === 'string' ? msg.serverName : undefined
      this.serverVersion = typeof msg.serverVersion === 'string' ? msg.serverVersion : undefined
      const auth = this.options.getAuth(msg.nonce)
      if (!auth) {
        this.refuse(ws, 'no-login')
        return
      }
      ws.send(
        JSON.stringify({
          type: 'hello',
          v: PROTOCOL_VERSION,
          deviceId: this.options.deviceId,
          deviceName: this.options.deviceName,
          platform: 'mobile',
          user: auth.user,
          token: auth.token
        })
      )
      return
    }

    if (msg.type === 'welcome') {
      if (this.welcomed) return
      if (msg.accepted === true) {
        this.welcomed = true
        this.attempt = 0
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
        this.handshakeTimer = null
        this.setStatus('connected', {
          user: typeof msg.user === 'string' ? msg.user : undefined,
          serverName: this.serverName,
          serverVersion: typeof msg.serverVersion === 'string' ? msg.serverVersion : this.serverVersion
        })
      } else {
        this.refuse(ws, String(msg.reason ?? ''))
      }
      return
    }

    // Nothing else counts before the server said yes.
    if (!this.welcomed) return

    if (msg.type === 'devices') {
      const list = Array.isArray(msg.devices) ? msg.devices : []
      const devices: RemoteDeviceSummary[] = []
      for (const d of list) {
        if (!d || typeof d.deviceId !== 'string' || d.deviceId.length === 0) continue
        devices.push({
          deviceId: d.deviceId,
          deviceName: typeof d.deviceName === 'string' && d.deviceName ? d.deviceName : 'Appareil',
          platform: typeof d.platform === 'string' ? d.platform : 'mobile'
        })
      }
      for (const cb of [...this.deviceHandlers]) cb(devices)
    } else if (msg.type === 'state') {
      if (typeof msg.deviceId === 'string') for (const cb of [...this.stateHandlers]) cb(msg as StateMessage)
    } else if (msg.type === 'command') {
      if (typeof msg.action === 'string') {
        const command: ServerCommand = { targetId: String(msg.targetId ?? ''), fromId: typeof msg.fromId === 'string' ? msg.fromId : undefined, action: msg.action, payload: msg.payload }
        for (const cb of [...this.commandHandlers]) cb(command)
      }
    } else {
      for (const cb of [...this.messageHandlers]) cb(msg)
    }
  }
}

function subscribe<T>(list: T[], cb: T): () => void {
  list.push(cb)
  return () => {
    const at = list.indexOf(cb)
    if (at >= 0) list.splice(at, 1)
  }
}
