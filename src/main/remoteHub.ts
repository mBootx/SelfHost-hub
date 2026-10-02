import { WebSocket, WebSocketServer } from 'ws'
import { networkInterfaces } from 'os'
import { createServer, Server } from 'http'
import type { BrowserWindow } from 'electron'
import { AttemptLimiter, formatCode, generateCode, isPrivateAddress, newHubId, newNonce, proofMatches } from './pairing'

/**
 * LAN-only "output device" hub, modelled on Spotify Connect but scoped to what
 * a single self-hosted setup actually needs: this desktop app is the only side
 * that can accept incoming connections (a Node process can trivially run a
 * TCP/WebSocket server; a phone cannot without extra native modules), so it
 * plays the hub, and every phone connects to it as a client. Both directions of
 * control ride the same persistent socket - the hub relays a client's commands
 * to another client (or applies them locally), and phones can just as well
 * command the hub.
 *
 * A phone is let in by a pairing code (see pairing.ts): the hub sends a fresh
 * challenge to every connection and only accepts a hello that answers it with a
 * keyed hash of the code. The code is typed once on the phone; it never travels
 * and is never in the address the hub gives out for discovery. Only addresses of
 * the home network are served at all, and an address that keeps guessing wrong
 * is ignored for a while.
 */

export const REMOTE_CONTROL_PORT = 51823
const HUB_DEVICE_ID = 'hub'
/** A connection that hasn't answered the challenge by then is dropped. */
const HELLO_TIMEOUT_MS = 10_000
const MAX_MESSAGE_BYTES = 64 * 1024
/** What a phone may ask a player to do; anything else is ignored. */
const COMMANDS = new Set(['toggle', 'play', 'pause', 'next', 'prev', 'seek', 'setVolume', 'toggleShuffle', 'setRepeatMode'])

export interface Pairing {
  /** Names this PC to phones that were paired with it (not a secret). */
  hubId: string
  /** The secret, ten characters of pairing.ts's alphabet. */
  code: string
}

/** Where the pairing is kept between runs; the app keeps it encrypted. */
export interface PairingStore {
  load(): Pairing | null
  save(pairing: Pairing): void
}

interface ClientEntry {
  id: string
  name: string
  platform: string
  socket: WebSocket
  lastState: Record<string, unknown> | null
}

interface DeviceSummary {
  deviceId: string
  deviceName: string
  platform: string
}

const clients = new Map<string, ClientEntry>()
let wss: WebSocketServer | null = null
let httpServer: Server | null = null
let win: BrowserWindow | null = null
let pairing: Pairing | null = null
let limiter = new AttemptLimiter()
let localDeviceName = 'PC'
/** The port actually listened on (what was asked for, unless that was 0). */
let boundPort: number | null = null
let localState: Record<string, unknown> | null = null

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function broadcast(message: unknown, exceptId?: string): void {
  const json = JSON.stringify(message)
  for (const [id, c] of clients) {
    if (id !== exceptId && c.socket.readyState === WebSocket.OPEN) c.socket.send(json)
  }
}

function deviceList(): DeviceSummary[] {
  const list: DeviceSummary[] = [{ deviceId: HUB_DEVICE_ID, deviceName: localDeviceName, platform: 'desktop' }]
  for (const c of clients.values()) list.push({ deviceId: c.id, deviceName: c.name, platform: c.platform })
  return list
}

function notifyDeviceListChanged(): void {
  const devices = deviceList()
  broadcast({ type: 'devices', devices })
  win?.webContents.send('remote:deviceListChanged', devices)
}

export function localLanAddress(): string | null {
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return null
}

export function isRunning(): boolean {
  return !!wss
}

export function currentDeviceList(): DeviceSummary[] {
  return deviceList()
}

/** The pairing as it is now, made and saved the first time it is asked for. */
function currentPairing(store: PairingStore): Pairing {
  if (!pairing) {
    pairing = store.load()
    if (!pairing || !pairing.hubId || pairing.code.length === 0) {
      pairing = { hubId: newHubId(), code: generateCode() }
      store.save(pairing)
    }
  }
  return pairing
}

/** The code to type on a phone, as "ABCDE-FGHJK". */
export function getPairingCode(store: PairingStore): string {
  return formatCode(currentPairing(store).code)
}

/** A new code: the old one stops working and every paired phone is disconnected and must be paired again. */
export function regeneratePairingCode(store: PairingStore): string {
  const current = currentPairing(store)
  pairing = { hubId: current.hubId, code: generateCode() }
  store.save(pairing)
  for (const c of [...clients.values()]) c.socket.close()
  return formatCode(pairing.code)
}

export async function startHub(opts: {
  window: BrowserWindow
  deviceName: string
  store: PairingStore
  /** Only for tests. */
  port?: number
}): Promise<{ ok: true; address: string | null; port: number } | { ok: false; error: string }> {
  win = opts.window
  localDeviceName = opts.deviceName
  const port = opts.port ?? REMOTE_CONTROL_PORT

  if (wss) return { ok: true, address: localLanAddress(), port: boundPort ?? port }
  currentPairing(opts.store) // made and saved now if this is the first run
  limiter = new AttemptLimiter()

  // A plain http.Server alongside the WS upgrade handler, rather than letting
  // `ws` spin up its own: phones need a fast, ordinary GET to find this hub by
  // scanning the subnet (see mobile's discoverHub), and ws's own bare server
  // answers any non-upgrade request with 426 instead of a usable response.
  const server = createServer((req, res) => {
    if (!isPrivateAddress(req.socket.remoteAddress)) {
      res.writeHead(403)
      res.end()
      return
    }
    if (req.method === 'GET' && req.url === '/selfhosthub/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ app: 'selfhost-hub', hubId: currentPairing(opts.store).hubId, deviceName: localDeviceName }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  const listenResult = await new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
    server.once('error', (err) => resolve({ ok: false, error: err.message }))
    server.listen(port, () => resolve({ ok: true }))
  })
  if (!listenResult.ok) return listenResult

  httpServer = server
  const address = server.address()
  boundPort = typeof address === 'object' && address ? address.port : port
  wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES })

  wss.on('connection', (socket, request) => {
    const address = request.socket.remoteAddress ?? ''
    if (!isPrivateAddress(address)) {
      socket.close()
      return
    }
    if (limiter.isBlocked(address)) {
      send(socket, { type: 'welcome', accepted: false, reason: 'too-many-attempts' })
      socket.close()
      return
    }

    // Every connection is asked to prove it knows the code before it is told anything.
    const nonce = newNonce()
    let clientId: string | null = null
    const hello = setTimeout(() => {
      if (!clientId) socket.close()
    }, HELLO_TIMEOUT_MS)
    send(socket, { type: 'challenge', nonce, hubId: currentPairing(opts.store).hubId, hubDeviceName: localDeviceName })

    socket.on('message', (raw) => {
      let msg: Record<string, any>
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return

      if (msg.type === 'hello') {
        if (clientId) return
        const deviceId = typeof msg.deviceId === 'string' ? msg.deviceId : ''
        if (!deviceId || deviceId.length > 100 || !proofMatches(currentPairing(opts.store).code, nonce, deviceId, msg.proof)) {
          // An older app version sends no proof at all: tell it plainly. Only a proof is a guess at the code.
          const guessed = typeof msg.proof === 'string'
          if (guessed) limiter.recordFailure(address)
          send(socket, { type: 'welcome', accepted: false, reason: guessed ? 'bad-code' : 'update-required' })
          socket.close()
          return
        }
        limiter.recordSuccess(address)
        clearTimeout(hello)
        clientId = deviceId
        clients.get(clientId)?.socket.close()
        clients.set(clientId, {
          id: clientId,
          name: String(msg.deviceName ?? 'Appareil').slice(0, 60),
          platform: msg.platform === 'desktop' ? 'desktop' : 'mobile',
          socket,
          lastState: null
        })
        send(socket, { type: 'welcome', accepted: true, hubDeviceId: HUB_DEVICE_ID, hubDeviceName: localDeviceName })
        if (localState) send(socket, { type: 'state', deviceId: HUB_DEVICE_ID, ...localState })
        for (const c of clients.values()) {
          if (c.id !== clientId && c.lastState) send(socket, { type: 'state', deviceId: c.id, ...c.lastState })
        }
        notifyDeviceListChanged()
        return
      }

      if (!clientId) return // everything past this point requires a completed hello

      if (msg.type === 'state') {
        const entry = clients.get(clientId)
        if (entry) entry.lastState = msg
        const relayed = { ...msg, deviceId: clientId }
        broadcast(relayed, clientId)
        win?.webContents.send('remote:deviceState', relayed)
        return
      }

      if (msg.type === 'command') {
        if (typeof msg.action !== 'string' || !COMMANDS.has(msg.action)) return
        const targetId = String(msg.targetId)
        if (targetId === HUB_DEVICE_ID) {
          win?.webContents.send('remote:command', msg)
        } else {
          const target = clients.get(targetId)
          if (target) send(target.socket, msg)
        }
      }
    })

    socket.on('close', () => {
      clearTimeout(hello)
      // A phone that reconnected under the same id has a newer socket in the table: leave that one.
      if (clientId && clients.get(clientId)?.socket === socket) {
        clients.delete(clientId)
        notifyDeviceListChanged()
      }
    })

    // No further handling needed: 'close' always follows and does the cleanup.
    socket.on('error', () => {})
  })

  return { ok: true, address: localLanAddress(), port: boundPort }
}

export function stopHub(): void {
  for (const c of clients.values()) c.socket.close()
  clients.clear()
  wss?.close()
  wss = null
  httpServer?.close()
  httpServer = null
  boundPort = null
  localState = null
  pairing = null
}

export function pushLocalState(state: Record<string, unknown>): void {
  localState = state
  broadcast({ type: 'state', deviceId: HUB_DEVICE_ID, ...state })
}

export function sendToDevice(targetId: string, command: unknown): void {
  if (targetId === HUB_DEVICE_ID) {
    win?.webContents.send('remote:command', command)
    return
  }
  const target = clients.get(targetId)
  if (target) send(target.socket, command)
}
