import { create } from 'zustand'
import { md5 } from 'js-md5'
import { useNavidromeStore, RepeatMode } from './navidromeStore'
import { seekTo } from '@renderer/services/playbackEngine'
import { storage } from '@renderer/services/storage'

/**
 * LAN remote control ("pick an output device and drive it from another",
 * Spotify-Connect style, scoped to a home network). This desktop app always
 * plays the hub - see src/main/remoteHub.ts for why only it can accept
 * incoming connections - so "enabling" it just starts that local server.
 * LOCAL_DEVICE_ID names this device from its own point of view; every other
 * id (phones) is whatever they announce themselves as.
 */
export const LOCAL_DEVICE_ID = 'local'

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
  repeatMode: RepeatMode
  volume: number
}

export interface RemoteDeviceSummary {
  deviceId: string
  deviceName: string
  platform: string
}

interface RemoteState {
  enabled: boolean
  running: boolean
  address: string | null
  deviceName: string
  deviceList: RemoteDeviceSummary[]
  devices: Record<string, RemoteDeviceState>
  selectedDeviceId: string

  init: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  setDeviceName: (name: string) => Promise<void>
  selectDevice: (id: string) => void
  sendCommand: (action: string, payload?: unknown) => void
}

let listenersWired = false
let subscribedToPlayback = false
let lastStatePush = 0

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
      s.setRepeatMode(payload.mode)
      break
  }
}

async function computeAccountHash(): Promise<string | null> {
  const conn = await storage.loadConnection('navidrome')
  if (!conn) return null
  return md5(`${conn.url}|${conn.username}`)
}

export const useRemoteStore = create<RemoteState>((set, get) => ({
  enabled: false,
  running: false,
  address: null,
  deviceName: 'PC',
  deviceList: [],
  devices: {},
  selectedDeviceId: LOCAL_DEVICE_ID,

  init: async () => {
    const [enabled, deviceName] = await Promise.all([
      storage.loadPref<boolean>('remote.enabled'),
      storage.loadPref<string>('remote.deviceName')
    ])
    set({ enabled: !!enabled, deviceName: deviceName || 'PC' })

    if (!listenersWired) {
      listenersWired = true
      window.api.remote.onDeviceListChanged((devices) => {
        const list = devices as RemoteDeviceSummary[]
        const knownIds = new Set(list.map((d) => d.deviceId))
        set((st) => {
          const devicesState = { ...st.devices }
          for (const id of Object.keys(devicesState)) {
            if (!knownIds.has(id)) delete devicesState[id]
          }
          const selectedDeviceId =
            st.selectedDeviceId === LOCAL_DEVICE_ID || knownIds.has(st.selectedDeviceId)
              ? st.selectedDeviceId
              : LOCAL_DEVICE_ID
          return { deviceList: list, devices: devicesState, selectedDeviceId }
        })
      })
      window.api.remote.onDeviceState((data) => {
        const { deviceId, type: _type, ...state } = data
        set((st) => ({ devices: { ...st.devices, [deviceId]: state as RemoteDeviceState } }))
      })
      window.api.remote.onCommand((command) => {
        applyCommandLocally(command.action, command.payload)
      })
    }

    if (!subscribedToPlayback) {
      subscribedToPlayback = true
      useNavidromeStore.subscribe((state, prev) => {
        if (!get().enabled) return
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
        window.api.remote.pushState({
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
        })
      })
    }

    const accountHash = get().enabled ? await computeAccountHash() : null
    if (accountHash) {
      const res = await window.api.remote.start({ accountHash, deviceName: get().deviceName })
      if (res.ok) set({ running: true, address: res.address })
    } else {
      // Covers both "disabled" and "enabled but logged out of Navidrome": a
      // hub left running after logout would still pair phones against the
      // account hash from the previous session.
      await window.api.remote.stop()
      set({ running: false })
    }
  },

  setEnabled: async (enabled) => {
    await storage.savePref('remote.enabled', enabled)
    set({ enabled })
    await get().init()
  },

  setDeviceName: async (name) => {
    await storage.savePref('remote.deviceName', name)
    set({ deviceName: name })
    if (get().running) {
      const accountHash = await computeAccountHash()
      if (accountHash) await window.api.remote.start({ accountHash, deviceName: name })
    }
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
    const { selectedDeviceId } = get()
    if (selectedDeviceId === LOCAL_DEVICE_ID) {
      applyCommandLocally(action, payload)
      return
    }
    window.api.remote.sendCommand(selectedDeviceId, { type: 'command', targetId: selectedDeviceId, action, payload })
  }
}))
