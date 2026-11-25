import { WebSocket } from 'ws'
import { createHash, randomUUID } from 'crypto'
import { hostname } from 'os'
import type { BrowserWindow } from 'electron'

/**
 * Client of the hub server (docs/server-protocol.md, v2). When a server address is set, the PC is a device like
 * the others: it signs in with the Navidrome account, receives the commands addressed to it, publishes its player
 * state, sees the account's other devices, and uploads its listening weeks. The LAN hub (remoteHub.ts) is not
 * started in that mode.
 *
 * The password never leaves the machine: it is read here (from the encrypted store) only to compute
 * md5(password + nonce) for each connection, and is never logged or sent to the renderer.
 */

/** The id the renderer uses for "this PC" in the device list (the same as the LAN hub's), so the UI is unchanged. */
const SELF_ID = 'hub'
const HELLO_TIMEOUT_MS = 10_000
const ACK_TIMEOUT_MS = 20_000
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000]
const MAX_PAYLOAD = 20 * 1024 * 1024
const COMMANDS = new Set(['toggle', 'play', 'pause', 'next', 'prev', 'seek', 'setVolume', 'toggleShuffle', 'setRepeatMode', 'playMedia'])
/** Refusals that retrying would not change until the person acts. */
const FATAL_REASONS = new Set(['bad-auth', 'update-required', 'bad-hello', 'no-credentials', 'replaced', 'incompatible'])

export interface HubServerStatus {
  state: 'off' | 'connecting' | 'connected' | 'refused' | 'error'
  user?: string
  serverName?: string
  reason?: string
  deviceId?: string
}

export interface HubProxyInfo {
  baseUrl: string
  apiToken: string
  downtifyEnabled: boolean
}

export interface ListeningPullEntry {
  deviceId: string
  deviceName: string
  platform: string
  week: string
  log: unknown
  rev: number
}

export interface ListeningPullResult {
  rev: number
  entries: ListeningPullEntry[]
  more: boolean
}

export interface HubServerDeps {
  getWindow: () => BrowserWindow | null
  /** A persistent value in the app's plain settings. */
  storeGet: (key: string) => unknown
  storeSet: (key: string, value: unknown) => void
  /** The Navidrome account, or null when nobody is signed in. */
  getCredentials: () => { user: string; password: string } | null
}

interface PendingPush {
  weeks: string[]
  resolve: (acked: string[]) => void
  timer: ReturnType<typeof setTimeout>
}

interface PendingPull {
  resolve: (result: ListeningPullResult | null) => void
  timer: ReturnType<typeof setTimeout>
}

let deps: HubServerDeps | null = null
let baseUrl = ''
let socket: WebSocket | null = null
let status: HubServerStatus = { state: 'off' }
let attempt = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null
let helloTimer: ReturnType<typeof setTimeout> | null = null
let lastState: Record<string, unknown> | null = null
let pending: PendingPush[] = []
let pendingPulls: PendingPull[] = []
let selfDeviceId = ''
let apiToken = ''
let features: string[] = []

export function initHubServer(d: HubServerDeps): void {
  deps = d
}

/** `https://hub.example.tld/` or `192.168.1.10:51823` as a base URL without trailing slash, or null if unusable. */
export function normalizeBase(input: string): string | null {
  let text = input.trim()
  if (!text) return null
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

function deviceId(): string {
  if (selfDeviceId) return selfDeviceId
  const saved = deps?.storeGet('hubServer.deviceId')
  if (typeof saved === 'string' && saved.length > 0) {
    selfDeviceId = saved
  } else {
    selfDeviceId = randomUUID()
    deps?.storeSet('hubServer.deviceId', selfDeviceId)
  }
  return selfDeviceId
}

function setStatus(next: HubServerStatus): void {
  status = next
  deps?.getWindow()?.webContents.send('hubServer:status', status)
}

export function getStatus(): HubServerStatus {
  return status
}

export function isActive(): boolean {
  return baseUrl !== ''
}

export function isConnected(): boolean {
  return status.state === 'connected'
}

function sendFrame(message: unknown): boolean {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message))
    return true
  }
  return false
}

function failPending(): void {
  const list = pending
  pending = []
  for (const p of list) {
    clearTimeout(p.timer)
    p.resolve([])
  }
  const pulls = pendingPulls
  pendingPulls = []
  for (const p of pulls) {
    clearTimeout(p.timer)
    p.resolve(null)
  }
}

function clearTimers(): void {
  if (retryTimer) clearTimeout(retryTimer)
  if (helloTimer) clearTimeout(helloTimer)
  retryTimer = null
  helloTimer = null
}

function wsUrl(base: string): string {
  return `${base.replace(/^http/i, 'ws')}/ws`
}

function scheduleReconnect(): void {
  if (!baseUrl || retryTimer) return
  const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
  attempt++
  retryTimer = setTimeout(() => {
    retryTimer = null
    open()
  }, delay)
}

function open(): void {
  if (!baseUrl) return
  clearTimers()
  apiToken = ''
  features = []
  const base = baseUrl
  let ws: WebSocket
  try {
    ws = new WebSocket(wsUrl(base), { maxPayload: MAX_PAYLOAD, handshakeTimeout: HELLO_TIMEOUT_MS })
  } catch {
    setStatus({ state: 'error', reason: 'invalid-address' })
    return
  }
  socket = ws
  setStatus({ state: 'connecting' })
  let signedIn = false
  // The reason this connection ended, when the server told us (a refusal or a replacement).
  let refusal: string | null = null

  helloTimer = setTimeout(() => {
    if (!signedIn) ws.terminate()
  }, HELLO_TIMEOUT_MS)

  ws.on('message', (raw) => {
    let msg: Record<string, any>
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return
    const win = deps?.getWindow()

    switch (msg.type) {
      case 'challenge': {
        const creds = deps?.getCredentials()
        if (!creds || typeof msg.nonce !== 'string') {
          refusal = creds ? 'incompatible' : 'no-credentials'
          ws.close()
          return
        }
        const token = createHash('md5')
          .update(creds.password + msg.nonce)
          .digest('hex')
        sendFrame({
          type: 'hello',
          v: 2,
          deviceId: deviceId(),
          deviceName: hostname(),
          platform: 'desktop',
          user: creds.user,
          token
        })
        status = { ...status, serverName: typeof msg.serverName === 'string' ? msg.serverName : undefined }
        return
      }
      case 'welcome': {
        if (msg.accepted === true) {
          signedIn = true
          attempt = 0
          if (helloTimer) clearTimeout(helloTimer)
          helloTimer = null
          apiToken = typeof msg.apiToken === 'string' ? msg.apiToken : ''
          features = Array.isArray(msg.features)
            ? (msg.features as unknown[]).filter((f): f is string => typeof f === 'string')
            : []
          setStatus({
            state: 'connected',
            user: typeof msg.user === 'string' ? msg.user : undefined,
            serverName: status.serverName,
            deviceId: deviceId()
          })
          if (lastState) sendFrame({ type: 'state', ...lastState })
        } else {
          refusal = typeof msg.reason === 'string' ? msg.reason : 'bad-hello'
        }
        return
      }
      case 'devices': {
        if (!Array.isArray(msg.devices)) return
        const me = deviceId()
        const list = (msg.devices as Array<Record<string, unknown>>)
          .filter((d) => d && typeof d.deviceId === 'string')
          .map((d) => (d.deviceId === me ? { ...d, deviceId: SELF_ID } : d))
        win?.webContents.send('remote:deviceListChanged', list)
        return
      }
      case 'state': {
        if (typeof msg.deviceId !== 'string' || msg.deviceId === deviceId()) return
        win?.webContents.send('remote:deviceState', msg)
        return
      }
      case 'command': {
        if (typeof msg.action !== 'string' || !COMMANDS.has(msg.action)) return
        if (msg.targetId !== undefined && msg.targetId !== deviceId()) return
        win?.webContents.send('remote:command', { action: msg.action, payload: msg.payload, fromId: msg.fromId })
        return
      }
      case 'listening.ack': {
        const acked = Array.isArray(msg.weeks) ? (msg.weeks as unknown[]).filter((w): w is string => typeof w === 'string') : []
        const first = pending.shift()
        if (first) {
          clearTimeout(first.timer)
          // The ack answers the whole push: a week the server left out was refused (too large or a bad key),
          // and resending it would only be refused again. Report every sent week as done so none stays
          // dirty forever.
          const refused = first.weeks.filter((w) => !acked.includes(w))
          if (refused.length > 0) console.warn('[hub-server] weeks refused by the server:', refused.join(', '))
          first.resolve(first.weeks)
        }
        return
      }
      case 'listening.data': {
        const first = pendingPulls.shift()
        if (first) {
          clearTimeout(first.timer)
          const rev = typeof msg.rev === 'number' && Number.isFinite(msg.rev) ? msg.rev : 0
          const entries = Array.isArray(msg.entries) ? (msg.entries as ListeningPullEntry[]) : []
          const more = msg.more === true
          first.resolve({ rev, entries, more })
        }
        return
      }
      case 'listening.changed': {
        win?.webContents.send('hubServer:listeningChanged', { rev: typeof msg.rev === 'number' ? msg.rev : 0 })
        return
      }
      case 'resume.state': {
        win?.webContents.send('hubServer:resumeState', msg)
        return
      }
      case 'error':
        console.warn('[hub-server] error from server:', msg.code)
        return
      default:
        return
    }
  })

  ws.on('close', (code) => {
    if (helloTimer) clearTimeout(helloTimer)
    helloTimer = null
    if (socket === ws) {
      socket = null
      apiToken = ''
      features = []
    }
    failPending()
    // Replaced by a newer connection of the same device: do not fight it.
    if (code === 4000) refusal = 'replaced'
    // The address was changed or removed meanwhile: this connection is none of our business any more.
    if (baseUrl !== base) return
    if (refusal) {
      setStatus({ state: 'refused', reason: refusal, serverName: status.serverName })
      if (!FATAL_REASONS.has(refusal)) scheduleReconnect()
      return
    }
    setStatus({ state: 'error', serverName: status.serverName })
    scheduleReconnect()
  })

  // 'close' always follows: it does the cleanup and the retry.
  ws.on('error', () => {})
}

/** Starts (or restarts, for another address or after a refusal) the connection. */
export function connect(url: string): { ok: boolean; error?: string } {
  const base = normalizeBase(url)
  if (!base) return { ok: false, error: 'Adresse du serveur invalide' }
  if (base === baseUrl && (status.state === 'connected' || status.state === 'connecting')) return { ok: true }
  disconnect()
  baseUrl = base
  attempt = 0
  open()
  return { ok: true }
}

export function disconnect(): void {
  baseUrl = ''
  apiToken = ''
  features = []
  clearTimers()
  failPending()
  const ws = socket
  socket = null
  if (ws) {
    try {
      ws.close()
    } catch {
      // already closing
    }
  }
  if (status.state !== 'off') setStatus({ state: 'off' })
}

export function getProxyInfo(): HubProxyInfo | null {
  if (!isConnected() || !baseUrl || !apiToken) return null
  return {
    baseUrl,
    apiToken,
    downtifyEnabled: features.includes('downtify')
  }
}

export function saveResume(state: Record<string, unknown>): boolean {
  if (!isConnected()) return false
  return sendFrame({ type: 'resume.save', state })
}

export function getResume(): boolean {
  if (!isConnected()) return false
  return sendFrame({ type: 'resume.get' })
}

export function refreshSessions(): boolean {
  if (!isConnected()) return false
  return sendFrame({ type: 'sessions.refresh' })
}

/** The player state of this PC, sent now and again after every reconnection. */
export function pushState(state: Record<string, unknown>): void {
  lastState = state
  sendFrame({ type: 'state', ...state })
}

export function sendCommand(targetId: string, command: unknown): void {
  const c = (command ?? {}) as Record<string, unknown>
  const action = typeof c.action === 'string' ? c.action : ''
  if (!COMMANDS.has(action)) return
  if (targetId === SELF_ID) {
    deps?.getWindow()?.webContents.send('remote:command', { action, payload: c.payload })
    return
  }
  sendFrame({ type: 'command', targetId, action, payload: c.payload })
}

/** Uploads some weeks (8 at most); resolves with the weeks the server acknowledged (none if not connected). */
export function pushListening(weeks: Record<string, unknown>): Promise<string[]> {
  const keys = Object.keys(weeks)
  if (keys.length === 0 || keys.length > 8 || !isConnected()) return Promise.resolve([])
  return new Promise<string[]>((resolve) => {
    const entry: PendingPush = {
      weeks: keys,
      resolve,
      timer: setTimeout(() => {
        pending = pending.filter((p) => p !== entry)
        resolve([])
      }, ACK_TIMEOUT_MS)
    }
    pending.push(entry)
    if (!sendFrame({ type: 'listening.push', weeks })) {
      clearTimeout(entry.timer)
      pending = pending.filter((p) => p !== entry)
      resolve([])
    }
  })
}

/** Downloads other devices' listening weeks since `since`; resolves with null if disconnected or timed out. */
export function pullListening(since: number): Promise<ListeningPullResult | null> {
  if (!isConnected()) return Promise.resolve(null)
  return new Promise<ListeningPullResult | null>((resolve) => {
    const entry: PendingPull = {
      resolve,
      timer: setTimeout(() => {
        pendingPulls = pendingPulls.filter((p) => p !== entry)
        resolve(null)
      }, ACK_TIMEOUT_MS)
    }
    pendingPulls.push(entry)
    if (!sendFrame({ type: 'listening.pull', since })) {
      clearTimeout(entry.timer)
      pendingPulls = pendingPulls.filter((p) => p !== entry)
      resolve(null)
    }
  })
}
