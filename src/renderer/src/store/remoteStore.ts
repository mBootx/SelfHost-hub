import { create } from 'zustand'
import { useNavidromeStore, RepeatMode } from './navidromeStore'
import { seekTo } from '@renderer/services/playbackEngine'
import { primeResumePosition } from '@renderer/services/playbackMemory'
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
  upNext?: RemoteSongInfo[]
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
  /** The code that pairs a phone with this PC ("ABCDE-FGHJK"), while the hub is running. */
  pairingCode: string | null
  /** Why the hub could not start (the port taken by another program, say). */
  error: string | null
  deviceName: string
  deviceList: RemoteDeviceSummary[]
  devices: Record<string, RemoteDeviceState>
  selectedDeviceId: string

  init: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  setDeviceName: (name: string) => Promise<void>
  /** Replaces the pairing code: phones paired with the old one are disconnected and must enter the new one. */
  newPairingCode: () => Promise<void>
  selectDevice: (id: string) => void
  sendCommand: (action: string, payload?: unknown) => void
  /** Pulls playback (song, upNext, playhead, shuffle, repeatMode) from `fromDeviceId` onto this PC. */
  handoffToHere: (fromDeviceId?: string) => boolean
  /** Pushes this PC's current playback to `targetDeviceId` and switches control to it. */
  handoffToDevice: (targetDeviceId: string) => boolean
}

let listenersWired = false
let subscribedToPlayback = false
let lastStatePush = 0

function currentStatePayload(): RemoteDeviceState {
  const state = useNavidromeStore.getState()
  const song = state.queue[state.queueIndex] || null
  const upNext = state.queue.slice(state.queueIndex + 1, state.queueIndex + 11).map((s) => ({
    id: s.id,
    title: s.title,
    artist: s.artist,
    album: s.album,
    albumId: s.albumId,
    coverArt: s.coverArt,
    duration: s.duration
  }))
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
    volume: state.volume,
    ...(upNext.length > 0 ? { upNext } : {})
  }
}

function applyHandoff(payload: any): void {
  if (!payload?.song?.id) return
  const s = useNavidromeStore.getState()
  const toSong = (item: any) => ({
    id: String(item.id),
    title: String(item.title || 'Sans titre'),
    artist: String(item.artist || 'Artiste inconnu'),
    album: item.album ? String(item.album) : undefined,
    albumId: item.albumId ? String(item.albumId) : undefined,
    coverArt: item.coverArt ? String(item.coverArt) : undefined,
    duration: Number.isFinite(Number(item.duration)) ? Number(item.duration) : 0
  })
  const songs = [toSong(payload.song), ...(Array.isArray(payload.upNext) ? payload.upNext.filter((x: any) => x?.id).map(toSong) : [])]
  const seconds = Number(payload.currentTime)
  const resumeAt = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  s.playQueue(songs, 0)
  if (payload.repeatMode === 'off' || payload.repeatMode === 'all' || payload.repeatMode === 'one') {
    s.setRepeatMode(payload.repeatMode)
  }
  if (typeof payload.shuffle === 'boolean' && useNavidromeStore.getState().shuffle !== payload.shuffle) {
    useNavidromeStore.getState().toggleShuffle()
  }
  if (resumeAt > 0) {
    useNavidromeStore.setState({ currentTime: resumeAt })
    primeResumePosition(songs[0].id, resumeAt)
    seekTo(resumeAt)
  }
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
      if (payload?.mode === 'off' || payload?.mode === 'all' || payload?.mode === 'one') s.setRepeatMode(payload.mode)
      break
    case 'handoff':
      applyHandoff(payload)
      break
  }
}

export const useRemoteStore = create<RemoteState>((set, get) => ({
  enabled: false,
  running: false,
  address: null,
  pairingCode: null,
  error: null,
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
        window.api.remote.pushState({ ...currentStatePayload() })
      })
    }

    // The hub only makes sense with a player to drive: off, or logged out of Navidrome, it is stopped.
    const loggedIn = get().enabled ? await storage.loadConnection('navidrome') : null
    if (loggedIn) {
      const res = await window.api.remote.start({ deviceName: get().deviceName })
      if (res.ok) set({ running: true, error: null, address: res.address, pairingCode: await window.api.remote.pairingCode() })
      else set({ running: false, error: res.error || 'erreur inconnue' })
    } else {
      await window.api.remote.stop()
      set({ running: false, pairingCode: null, error: null })
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
    if (get().running) await window.api.remote.start({ deviceName: name })
  },

  newPairingCode: async () => {
    set({ pairingCode: await window.api.remote.newPairingCode() })
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
  },

  handoffToHere: (fromDeviceId) => {
    const { selectedDeviceId, devices } = get()
    const sourceId =
      fromDeviceId ||
      (selectedDeviceId !== LOCAL_DEVICE_ID ? selectedDeviceId : Object.keys(devices).find((id) => id !== 'hub' && devices[id]?.song))
    const remoteState = sourceId ? devices[sourceId] : null
    if (!sourceId || !remoteState?.song) return false
    window.api.remote.sendCommand(sourceId, { type: 'command', targetId: sourceId, action: 'pause' })
    set({ selectedDeviceId: LOCAL_DEVICE_ID })
    applyHandoff(remoteState)
    return true
  },

  handoffToDevice: (targetDeviceId) => {
    if (!targetDeviceId || targetDeviceId === LOCAL_DEVICE_ID) return false
    const payload = currentStatePayload()
    if (!payload.song) {
      get().selectDevice(targetDeviceId)
      return false
    }
    if (useNavidromeStore.getState().isPlaying) useNavidromeStore.getState().togglePlay()
    window.api.remote.sendCommand(targetDeviceId, { type: 'command', targetId: targetDeviceId, action: 'handoff', payload })
    set({ selectedDeviceId: targetDeviceId })
    return true
  }
}))
