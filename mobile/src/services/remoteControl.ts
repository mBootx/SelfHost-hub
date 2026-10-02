import * as Network from 'expo-network'
import { sha256 } from 'js-sha256'
import { fetchWithTimeout } from './http'

/**
 * Client side of the LAN remote-control hub (see the desktop app's
 * src/main/remoteHub.ts for the protocol and why the PC is always the hub: a
 * phone has no way to accept incoming connections without extra native
 * modules, but the built-in WebSocket client works out of the box).
 */

export const REMOTE_CONTROL_PORT = 51823

/**
 * The pairing code the PC shows (see its src/main/pairing.ts): ten characters of this alphabet. The phone never
 * sends it; it answers the PC's challenge with a keyed hash of it.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 10

/** What was typed, reduced to the code's alphabet: case, spaces and dashes don't matter. */
export function normalizeCode(input: string): string {
  return [...input.toUpperCase()].filter((ch) => CODE_ALPHABET.includes(ch)).join('')
}

/** The answer to the PC's challenge: HMAC-SHA256 keyed with the code over the nonce and this phone's id. */
export function proofFor(code: string, nonce: string, deviceId: string): string {
  return sha256.hmac(code, `${nonce}|${deviceId}`)
}

const REJECTIONS: Record<string, string> = {
  'bad-code': "Code d'appairage incorrect",
  'too-many-attempts': "Trop d'essais : réessayez dans quelques minutes",
  'update-required': "Mettez l'application du PC à jour"
}

/** Why a PC turned the phone away. */
export class HubRejected extends Error {
  reason: string
  constructor(reason: string) {
    super(REJECTIONS[reason] ?? 'Connexion refusée')
    this.reason = reason
  }
}

export interface HubInfo {
  ip: string
  /** Names the PC to phones paired with it (the PC makes it once and shows no secret with it). */
  hubId: string
  deviceName: string
}

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
 * Scans this phone's own /24 subnet for hubs answering on REMOTE_CONTROL_PORT. A plain parallel HTTP probe
 * rather than mDNS: mDNS on Android needs a native module (a real risk under the New Architecture this app
 * already runs), while fetch() needs nothing extra and finishes in well under a second thanks to the
 * concurrency below. With `hubId` it stops at the PC that was paired; without, it lists every hub it finds.
 */
export async function discoverHubs(options: { hubId?: string; port?: number } = {}): Promise<HubInfo[]> {
  const port = options.port ?? REMOTE_CONTROL_PORT
  const ip = await Network.getIpAddressAsync().catch(() => null)
  if (!ip || ip === '0.0.0.0') return []
  const parts = ip.split('.')
  if (parts.length !== 4) return []
  const base = parts.slice(0, 3).join('.')
  const candidates = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`).filter((c) => c !== ip)

  const CONCURRENCY = 40
  let cursor = 0
  const found: HubInfo[] = []

  async function worker(): Promise<void> {
    while (cursor < candidates.length && !(options.hubId && found.length > 0)) {
      const candidate = candidates[cursor++]
      try {
        const res = await fetchWithTimeout(`http://${candidate}:${port}/selfhosthub/ping`, {}, 400)
        if (!res.ok) continue
        const data = await res.json()
        if (data?.app !== 'selfhost-hub' || typeof data?.hubId !== 'string') continue
        if (options.hubId && data.hubId !== options.hubId) continue
        found.push({ ip: candidate, hubId: data.hubId, deviceName: String(data.deviceName ?? 'PC') })
      } catch {
        // unreachable host or nothing listening there - expected for almost the whole subnet
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  // Probes run side by side, so a few may answer before the first is noticed: one PC is wanted, one is returned.
  return options.hubId ? found.slice(0, 1) : found
}

export class RemoteHubClient {
  private socket: WebSocket | null = null
  private deviceHandlers: Array<(devices: RemoteDeviceSummary[]) => void> = []
  private stateHandlers: Array<(state: StateMessage) => void> = []
  private commandHandlers: Array<(command: CommandMessage) => void> = []
  private closeHandlers: Array<() => void> = []

  /**
   * Opens the connection and answers the PC's challenge with a proof made from the pairing code; resolves once
   * the PC lets the phone in, and says which PC it is (`hubId`) so a pairing can be kept for it.
   */
  connect(
    ip: string,
    port: number,
    deviceId: string,
    deviceName: string,
    code: string
  ): Promise<{ hubDeviceId: string; hubDeviceName: string; hubId: string }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${ip}:${port}`)
      let settled = false
      let hubId = ''
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        ws.close()
        reject(new Error('Connexion expirée'))
      }, 5000)


      ws.onmessage = (event) => {
        let msg: Record<string, any>
        try {
          msg = JSON.parse(String(event.data))
        } catch {
          return
        }

        if (msg.type === 'challenge') {
          if (typeof msg.nonce !== 'string') return
          hubId = String(msg.hubId ?? '')
          ws.send(JSON.stringify({ type: 'hello', deviceId, deviceName, platform: 'mobile', proof: proofFor(code, msg.nonce, deviceId) }))
          return
        }
        if (msg.type === 'welcome') {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (msg.accepted) {
            this.socket = ws
            resolve({ hubDeviceId: msg.hubDeviceId, hubDeviceName: msg.hubDeviceName, hubId })
          } else {
            ws.close()
            reject(new HubRejected(String(msg.reason ?? '')))
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
