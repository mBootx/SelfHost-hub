import { WebSocket, WebSocketServer } from 'ws'
import { networkInterfaces } from 'os'
import { createServer, Server } from 'http'
import type { BrowserWindow } from 'electron'

/**
 * LAN-only "output device" hub, modelled on Spotify Connect but scoped to what
 * a single self-hosted setup actually needs: this desktop app is the only side
 * that can accept incoming connections (a Node process can trivially run a
 * TCP/WebSocket server; a phone cannot without extra native modules), so it
 * plays the hub, and every phone connects to it as a client. Both directions of
 * control ride the same persistent socket - the hub relays a client's commands
 * to another client (or applies them locally), and phones can just as well
 * command the hub. No pairing beyond an account hash: since this never leaves
 * the LAN and is for one person's own devices, that's enough to keep a
 * different app instance on the same WiFi from showing up by accident.
 */

export const REMOTE_CONTROL_PORT = 51823
const HUB_DEVICE_ID = 'hub'

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
let accountHash = ''
let localDeviceName = 'PC'
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

export async function startHub(opts: {
  window: BrowserWindow
  accountHash: string
  deviceName: string
}): Promise<{ ok: true; address: string | null; port: number } | { ok: false; error: string }> {
  win = opts.window
  accountHash = opts.accountHash
  localDeviceName = opts.deviceName

  if (wss) return { ok: true, address: localLanAddress(), port: REMOTE_CONTROL_PORT }

  // A plain http.Server alongside the WS upgrade handler, rather than letting
  // `ws` spin up its own: phones need a fast, ordinary GET to find this hub by
  // scanning the subnet (see mobile's discoverHub), and ws's own bare server
  // answers any non-upgrade request with 426 instead of a usable response.
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/selfhosthub/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ app: 'selfhost-hub', accountHash, deviceName: localDeviceName }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  const listenResult = await new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
    server.once('error', (err) => resolve({ ok: false, error: err.message }))
    server.listen(REMOTE_CONTROL_PORT, () => resolve({ ok: true }))
  })
  if (!listenResult.ok) return listenResult

  httpServer = server
  wss = new WebSocketServer({ server })

  wss.on('connection', (socket) => {
    let clientId: string | null = null

    socket.on('message', (raw) => {
      let msg: Record<string, any>
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }

      if (msg.type === 'hello') {
        if (msg.accountHash !== accountHash) {
          send(socket, { type: 'welcome', accepted: false, reason: 'account-mismatch' })
          socket.close()
          return
        }
        clientId = String(msg.deviceId)
        clients.set(clientId, { id: clientId, name: msg.deviceName, platform: msg.platform, socket, lastState: null })
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
      if (clientId && clients.delete(clientId)) notifyDeviceListChanged()
    })

    // No further handling needed: 'close' always follows and does the cleanup.
    socket.on('error', () => {})
  })

  return { ok: true, address: localLanAddress(), port: REMOTE_CONTROL_PORT }
}

export function stopHub(): void {
  for (const c of clients.values()) c.socket.close()
  clients.clear()
  wss?.close()
  wss = null
  httpServer?.close()
  httpServer = null
  localState = null
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
