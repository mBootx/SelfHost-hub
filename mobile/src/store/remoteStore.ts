import { create, StoreApi } from 'zustand'
import { md5 } from 'js-md5'
import * as Device from 'expo-device'
import { useNavidromeStore, RepeatMode } from './navidromeStore'
import { seekTo } from '@/services/playbackEngine'
import { storage } from '@/services/storage'
import {
  RemoteHubClient,
  RemoteDeviceState,
  RemoteDeviceSummary,
  discoverHub,
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
 */
export const LOCAL_DEVICE_ID = 'local'

export type RemoteStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

interface RemoteControlState {
  enabled: boolean
  status: RemoteStatus
  error: string | null
  client: RemoteHubClient | null
  deviceId: string
  deviceName: string
  deviceList: RemoteDeviceSummary[]
  devices: Record<string, RemoteDeviceState>
  selectedDeviceId: string

  init: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  setDeviceName: (name: string) => Promise<void>
  autoConnect: () => Promise<void>
  connectManual: (ip: string) => Promise<boolean>
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

function applyCommandLocally(action: string, payload: any): void {
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
    case 'seek':
      seekTo(payload.seconds)
      useNavidromeStore.setState({ currentTime: payload.seconds })
      break
    case 'setVolume':
      s.setVolume(payload.volume)
      break
    case 'toggleShuffle':
      s.toggleShuffle()
      break
    case 'setRepeatMode':
      s.setRepeatMode(payload.mode as RepeatMode)
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

async function computeAccountHash(): Promise<string | null> {
  const conn = await storage.loadConnection('navidrome')
  if (!conn) return null
  return md5(`${conn.url}|${conn.username}`)
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

export const useRemoteStore = create<RemoteControlState>((set, get) => ({
  enabled: false,
  status: 'disconnected',
  error: null,
  client: null,
  deviceId: '',
  deviceName: '',
  deviceList: [],
  devices: {},
  selectedDeviceId: LOCAL_DEVICE_ID,

  init: async () => {
    let deviceId = await storage.loadPref<string>('remote.deviceId')
    if (!deviceId) {
      deviceId = generateDeviceId()
      await storage.savePref('remote.deviceId', deviceId)
    }
    const [enabled, deviceName] = await Promise.all([
      storage.loadPref<boolean>('remote.enabled'),
      storage.loadPref<string>('remote.deviceName')
    ])
    set({ deviceId, deviceName: deviceName || Device.modelName || 'Téléphone', enabled: !!enabled })

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
    const accountHash = await computeAccountHash()
    if (!accountHash) return
    set({ status: 'connecting', error: null })

    const lastIp = await storage.loadPref<string>('remote.lastHubIp')
    if (lastIp && (await get().connectManual(lastIp))) return

    const ip = await discoverHub(accountHash)
    if (!ip) {
      set({ status: 'error', error: 'PC introuvable sur le réseau (même Wi-Fi requis)' })
      return
    }
    await get().connectManual(ip)
  },

  connectManual: async (ip) => {
    const accountHash = await computeAccountHash()
    if (!accountHash) {
      set({ status: 'error', error: "Connectez-vous d'abord à Navidrome" })
      return false
    }
    set({ status: 'connecting', error: null })
    try {
      const client = new RemoteHubClient()
      await client.connect(ip, REMOTE_CONTROL_PORT, get().deviceId, get().deviceName, accountHash)
      if (!get().enabled) {
        // The user turned remote control off while this handshake was still in
        // flight - don't resurrect a connection they just asked to drop.
        client.close()
        return false
      }
      wireClient(client, set, get)
      await storage.savePref('remote.lastHubIp', ip)
      set({ client, status: 'connected', error: null })
      client.sendState(currentStatePayload())
      return true
    } catch (err: any) {
      set({ status: 'error', error: err?.message || 'Connexion impossible', client: null })
      return false
    }
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
}))
