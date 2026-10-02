import { create, StoreApi } from 'zustand'
import * as Device from 'expo-device'
import { describeError, logEvent } from '@/services/diagnostics'
import { useNavidromeStore, RepeatMode } from './navidromeStore'
import { seekTo } from '@/services/playbackEngine'
import { storage } from '@/services/storage'
import {
  RemoteHubClient,
  RemoteDeviceState,
  RemoteDeviceSummary,
  HubRejected,
  CODE_LENGTH,
  discoverHubs,
  normalizeCode,
  REMOTE_CONTROL_PORT
} from '@/services/remoteControl'

/**
 * LAN remote control ("pick an output device and drive it from another",
 * Spotify-Connect style). The desktop app is always the hub - a phone has no
 * way to accept incoming connections without extra native modules, but it can
 * dial out just fine with the platform's built-in WebSocket client - so this
 * store only ever connects TO a PC, never listens itself. LOCAL_DEVICE_ID
 * names this phone from its own point of view; every other id (the hub, or
 * another phone) is whatever it announced itself as.
 *
 * A phone is paired with its PC once, by typing the code the PC shows. The
 * code is kept in the secure store and only ever used to answer the PC's
 * challenge, never sent.
 */
export const LOCAL_DEVICE_ID = 'local'

const NEEDS_PAIRING = "Appairez ce téléphone avec le PC : saisissez le code affiché dans les réglages de l'application PC"

export type RemoteStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/** The PC this phone was paired with: which one (not a secret) and the code that proves it (a secret). */
export interface Pairing {
  hubId: string
  code: string
}

interface RemoteControlState {
  enabled: boolean
  status: RemoteStatus
  error: string | null
  client: RemoteHubClient | null
  deviceId: string
  deviceName: string
  pairing: Pairing | null
  deviceList: RemoteDeviceSummary[]
  devices: Record<string, RemoteDeviceState>
  selectedDeviceId: string

  init: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  setDeviceName: (name: string) => Promise<void>
  autoConnect: () => Promise<void>
  /** Connects to the paired PC at a given address (when finding it on the network fails). */
  connectManual: (ip: string) => Promise<boolean>
  /** Pairs with the PC showing this code - found on the network, or at `ip` - and connects to it. */
  pair: (code: string, ip?: string) => Promise<boolean>
  unpair: () => Promise<void>
  disconnect: () => void
  selectDevice: (id: string) => void
  sendCommand: (action: string, payload?: unknown) => void
}

let subscribedToPlayback = false
let lastStatePush = 0

function generateDeviceId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `device-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Plays what another device asked for. Anything out of range or of an unknown kind is ignored. */
export function applyCommandLocally(action: string, payload: any): void {
  const s = useNavidromeStore.getState()
  switch (action) {
    case 'toggle':
      s.togglePlay()
      break
    case 'play':
      if (!s.isPlaying) s.togglePlay()
      break
    case 'pause':
      if (s.isPlaying) s.togglePlay()
      break
    case 'next':
      s.next()
      break
    case 'prev':
      s.prev()
      break
    case 'seek': {
      const seconds = Number(payload?.seconds)
      if (!Number.isFinite(seconds) || seconds < 0) break
      seekTo(seconds)
      useNavidromeStore.setState({ currentTime: seconds })
      break
    }
    case 'setVolume': {
      const volume = Number(payload?.volume)
      if (!Number.isFinite(volume)) break
      s.setVolume(Math.min(1, Math.max(0, volume)))
      break
    }
    case 'toggleShuffle':
      s.toggleShuffle()
      break
    case 'setRepeatMode':
      if (payload?.mode === 'off' || payload?.mode === 'all' || payload?.mode === 'one') s.setRepeatMode(payload.mode as RepeatMode)
      break
  }
}

function currentStatePayload(): RemoteDeviceState {
  const state = useNavidromeStore.getState()
  const song = state.queue[state.queueIndex] || null
  return {
    song: song
      ? {
          id: song.id,
          title: song.title,
          artist: song.artist,
          album: song.album,
          albumId: song.albumId,
          coverArt: song.coverArt,
          duration: song.duration
        }
      : null,
    isPlaying: state.isPlaying,
    currentTime: state.currentTime,
    duration: state.duration,
    shuffle: state.shuffle,
    repeatMode: state.repeatMode,
    volume: state.volume
  }
}

async function loadPairing(): Promise<Pairing | null> {
  try {
    const raw = await storage.loadSecret('remote', 'pairing')
    const saved = raw ? (JSON.parse(raw) as Pairing) : null
    return saved && typeof saved.hubId === 'string' && typeof saved.code === 'string' ? saved : null
  } catch {
    return null
  }
}

function wireClient(
  client: RemoteHubClient,
  set: StoreApi<RemoteControlState>['setState'],
  get: StoreApi<RemoteControlState>['getState']
): void {
  client.onDevices((devices) => {
    const knownIds = new Set(devices.map((d) => d.deviceId))
    const nextDevices = { ...get().devices }
    for (const id of Object.keys(nextDevices)) {
      if (!knownIds.has(id)) delete nextDevices[id]
    }
    const selectedDeviceId =
      get().selectedDeviceId === LOCAL_DEVICE_ID || knownIds.has(get().selectedDeviceId)
        ? get().selectedDeviceId
        : LOCAL_DEVICE_ID
    set({ deviceList: devices, devices: nextDevices, selectedDeviceId })
  })
  client.onState((state) => {
    const { deviceId, ...rest } = state
    set({ devices: { ...get().devices, [deviceId]: rest as RemoteDeviceState } })
  })
  client.onCommand((command) => applyCommandLocally(command.action, command.payload))
  client.onClose(() => {
    set({ status: 'disconnected', client: null, deviceList: [], devices: {}, selectedDeviceId: LOCAL_DEVICE_ID })
  })
}

export const useRemoteStore = create<RemoteControlState>((set, get) => {
  /**
   * Dials a PC and answers its challenge with `code`. With `expectedHubId` any other PC is refused. Resolves
   * to the PC that accepted (and wires the connection in), or to null when remote control was turned off
   * while the handshake was still in flight; rejects with the reason otherwise.
   */
  async function dial(ip: string, code: string, expectedHubId?: string): Promise<{ hubId: string } | null> {
    const client = new RemoteHubClient()
    const hub = await client.connect(ip, REMOTE_CONTROL_PORT, get().deviceId, get().deviceName, code)
    if (expectedHubId && hub.hubId !== expectedHubId) {
      client.close()
      throw new Error("Ce n'est pas le PC avec lequel ce téléphone est appairé")
    }
    if (!get().enabled) {
      // The user turned remote control off while this handshake was still in
      // flight - don't resurrect a connection they just asked to drop.
      client.close()
      return null
    }
    wireClient(client, set, get)
    await storage.savePref('remote.lastHubIp', ip)
    set({ client, status: 'connected', error: null })
    logEvent('remote', `Connecté au PC (${ip})`)
    client.sendState(currentStatePayload())
    return { hubId: hub.hubId }
  }

  return {
    enabled: false,
    status: 'disconnected',
    error: null,
    client: null,
    deviceId: '',
    deviceName: '',
    pairing: null,
    deviceList: [],
    devices: {},
    selectedDeviceId: LOCAL_DEVICE_ID,

    init: async () => {
      let deviceId = await storage.loadPref<string>('remote.deviceId')
      if (!deviceId) {
        deviceId = generateDeviceId()
        await storage.savePref('remote.deviceId', deviceId)
      }
      const [enabled, deviceName, pairing] = await Promise.all([
        storage.loadPref<boolean>('remote.enabled'),
        storage.loadPref<string>('remote.deviceName'),
        loadPairing()
      ])
      set({ deviceId, deviceName: deviceName || Device.modelName || 'Téléphone', enabled: !!enabled, pairing })

      if (!subscribedToPlayback) {
        subscribedToPlayback = true
        useNavidromeStore.subscribe((state, prev) => {
          const { client, enabled: on } = get()
          if (!on || !client) return
          const song = state.queue[state.queueIndex] || null
          const prevSong = prev.queue[prev.queueIndex] || null
          const changed =
            song?.id !== prevSong?.id ||
            state.isPlaying !== prev.isPlaying ||
            state.shuffle !== prev.shuffle ||
            state.repeatMode !== prev.repeatMode ||
            state.volume !== prev.volume
          const now = Date.now()
          if (!changed && now - lastStatePush < 900) return
          lastStatePush = now
          client.sendState(currentStatePayload())
        })
      }

      if (get().enabled) await get().autoConnect()
    },

    setEnabled: async (enabled) => {
      await storage.savePref('remote.enabled', enabled)
      set({ enabled })
      if (enabled) await get().autoConnect()
      else get().disconnect()
    },

    setDeviceName: async (name) => {
      await storage.savePref('remote.deviceName', name)
      set({ deviceName: name })
    },

    autoConnect: async () => {
      if (get().status === 'connecting' || get().status === 'connected') return
      const { pairing } = get()
      if (!pairing) {
        set({ status: 'error', error: NEEDS_PAIRING })
        return
      }
      set({ status: 'connecting', error: null })

      const lastIp = await storage.loadPref<string>('remote.lastHubIp')
      if (lastIp && (await get().connectManual(lastIp))) return

      const [hub] = await discoverHubs({ hubId: pairing.hubId })
      if (!hub) {
        set({ status: 'error', error: 'PC introuvable sur le réseau (même Wi-Fi requis)' })
        return
      }
      await get().connectManual(hub.ip)
    },

    connectManual: async (ip) => {
      const { pairing } = get()
      if (!pairing) {
        set({ status: 'error', error: NEEDS_PAIRING })
        return false
      }
      set({ status: 'connecting', error: null })
      try {
        return (await dial(ip, pairing.code, pairing.hubId)) !== null
      } catch (err: any) {
        logEvent('remote', `Connexion au PC impossible : ${describeError(err)}`, 'warn')
        set({ status: 'error', error: err?.message || 'Connexion impossible', client: null })
        return false
      }
    },

    pair: async (input, ip) => {
      const code = normalizeCode(input)
      if (code.length !== CODE_LENGTH) {
        set({ status: 'error', error: `Le code compte ${CODE_LENGTH} caractères (lettres et chiffres)` })
        return false
      }
      set({ status: 'connecting', error: null })
      // Every PC found is tried: the code is not sent, so a PC that isn't the right one learns nothing from it.
      const hubs = ip ? [{ ip }] : await discoverHubs()
      if (hubs.length === 0) {
        set({ status: 'error', error: 'PC introuvable sur le réseau (même Wi-Fi requis)' })
        return false
      }
      let failure = "Code d'appairage incorrect"
      for (const hub of hubs) {
        try {
          const accepted = await dial(hub.ip, code)
          if (!accepted) return false
          const pairing: Pairing = { hubId: accepted.hubId, code }
          await storage.saveSecret('remote', 'pairing', JSON.stringify(pairing))
          set({ pairing })
          logEvent('remote', 'Téléphone appairé avec le PC')
          return true
        } catch (err: any) {
          failure = err?.message || failure
          // Told to stop guessing: the other PCs, if any, would not be told differently.
          if (err instanceof HubRejected && err.reason === 'too-many-attempts') break
        }
      }
      set({ status: 'error', error: failure, client: null })
      return false
    },

    unpair: async () => {
      get().disconnect()
      await storage.clearSecret('remote', 'pairing')
      await storage.savePref('remote.lastHubIp', '')
      set({ pairing: null })
    },

    disconnect: () => {
      get().client?.close()
      set({ client: null, status: 'disconnected', deviceList: [], devices: {}, selectedDeviceId: LOCAL_DEVICE_ID, error: null })
    },

    selectDevice: (id) => {
      if (id === get().selectedDeviceId) return
      if (id !== LOCAL_DEVICE_ID && useNavidromeStore.getState().isPlaying) {
        // Switching output to a remote device: silence local audio so it doesn't
        // keep playing here while this UI drives the other device instead.
        useNavidromeStore.getState().togglePlay()
      }
      set({ selectedDeviceId: id })
    },

    sendCommand: (action, payload) => {
      const { selectedDeviceId, client } = get()
      if (selectedDeviceId === LOCAL_DEVICE_ID) {
        applyCommandLocally(action, payload)
        return
      }
      client?.sendCommand(selectedDeviceId, action, payload)
    }
  }
})
