import * as Network from 'expo-network'
import { fetchWithTimeout } from './http'

/**
 * Client side of the LAN remote-control hub (see the desktop app's
 * src/main/remoteHub.ts for the protocol and why the PC is always the hub: a
 * phone has no way to accept incoming connections without extra native
 * modules, but the built-in WebSocket client works out of the box).
 */

export const REMOTE_CONTROL_PORT = 51823

export interface RemoteSongInfo {
  id: string
  title: string
  artist: string
  album?: string
  albumId?: string
  coverArt?: string
  duration: number
}

export interface RemoteDeviceState {
  song: RemoteSongInfo | null
  isPlaying: boolean
  currentTime: number
  duration: number
  shuffle: boolean
  repeatMode: 'off' | 'all' | 'one'
  volume: number
}

export interface RemoteDeviceSummary {
  deviceId: string
  deviceName: string
  platform: string
}

type StateMessage = { deviceId: string } & RemoteDeviceState
type CommandMessage = { targetId: string; action: string; payload?: any }

/**
 * Scans this phone's own /24 subnet for a hub answering on REMOTE_CONTROL_PORT
 * with a matching account hash. A plain parallel HTTP probe rather than mDNS:
 * mDNS on Android needs a native module (a real risk under the New
 * Architecture this app already runs), while fetch() needs nothing extra and
 * finishes in well under a second thanks to the concurrency below.
 */
export async function discoverHub(accountHash: string, port = REMOTE_CONTROL_PORT): Promise<string | null> {
  const ip = await Network.getIpAddressAsync().catch(() => null)
  if (!ip || ip === '0.0.0.0') return null
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const base = parts.slice(0, 3).join('.')
  const candidates = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`).filter((c) => c !== ip)

  const CONCURRENCY = 40
  let cursor = 0
  let found: string | null = null

  async function worker(): Promise<void> {
    while (cursor < candidates.length && !found) {
      const candidate = candidates[cursor++]
      try {
        const res = await fetchWithTimeout(`http://${candidate}:${port}/selfhosthub/ping`, {}, 400)
        if (!res.ok) continue
        const data = await res.json()
        if (data?.app === 'selfhost-hub' && data?.accountHash === accountHash) found = candidate
      } catch {
        // unreachable host or nothing listening there - expected for almost the whole subnet
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  return found
}

export class RemoteHubClient {
  private socket: WebSocket | null = null
  private deviceHandlers: Array<(devices: RemoteDeviceSummary[]) => void> = []
  private stateHandlers: Array<(state: StateMessage) => void> = []
  private commandHandlers: Array<(command: CommandMessage) => void> = []
  private closeHandlers: Array<() => void> = []

  connect(
    ip: string,
    port: number,
    deviceId: string,
    deviceName: string,
    accountHash: string
  ): Promise<{ hubDeviceId: string; hubDeviceName: string }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${ip}:${port}`)
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        ws.close()
        reject(new Error('Connexion expiree'))
      }, 5000)

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'hello', deviceId, deviceName, platform: 'mobile', accountHash }))
      }

      ws.onmessage = (event) => {
        let msg: Record<string, any>
        try {
          msg = JSON.parse(String(event.data))
        } catch {
          return
        }

        if (msg.type === 'welcome') {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (msg.accepted) {
            this.socket = ws
            resolve({ hubDeviceId: msg.hubDeviceId, hubDeviceName: msg.hubDeviceName })
          } else {
            ws.close()
            reject(new Error(msg.reason === 'account-mismatch' ? 'Compte Navidrome different sur le PC' : 'Connexion refusee'))
          }
          return
        }
        if (msg.type === 'devices') this.deviceHandlers.forEach((h) => h(msg.devices))
        else if (msg.type === 'state') this.stateHandlers.forEach((h) => h(msg as StateMessage))
        else if (msg.type === 'command') this.commandHandlers.forEach((h) => h(msg as CommandMessage))
      }

      ws.onerror = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error('Connexion impossible'))
      }

      ws.onclose = () => {
        this.socket = null
        this.closeHandlers.forEach((h) => h())
      }
    })
  }

  onDevices(cb: (devices: RemoteDeviceSummary[]) => void): void {
    this.deviceHandlers.push(cb)
  }
  onState(cb: (state: StateMessage) => void): void {
    this.stateHandlers.push(cb)
  }
  onCommand(cb: (command: CommandMessage) => void): void {
    this.commandHandlers.push(cb)
  }
  onClose(cb: () => void): void {
    this.closeHandlers.push(cb)
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  sendState(state: RemoteDeviceState): void {
    this.send({ type: 'state', ...state })
  }

  sendCommand(targetId: string, action: string, payload?: unknown): void {
    this.send({ type: 'command', targetId, action, payload })
  }

  close(): void {
    this.socket?.close()
    this.socket = null
  }
}
