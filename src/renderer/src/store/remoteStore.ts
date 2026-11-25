import { create } from 'zustand'
import { useNavidromeStore, RepeatMode } from './navidromeStore'
import { seekTo } from '@renderer/services/playbackEngine'
import { primeResumePosition } from '@renderer/services/playbackMemory'
import { clearOtherDevices } from '@renderer/services/listeningLog'
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
const SESSION_REFRESH_MS = 5000

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

export type HubServerStatus = Awaited<ReturnType<typeof window.api.hubServer.status>>

export interface RemoteDeviceSummary {
  deviceId: string
  deviceName: string
  platform: string
}

export interface ResumeStateInfo {
  deviceId: string
  deviceName: string
  platform: string
  updatedAt: number
  state: RemoteDeviceState
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
  /** True once the user explicitly picked a device (or started local playback), blocking auto-target. */
  manualSelection: boolean
  /** The hub server's address (empty: the LAN mode, the PC being the hub). */
  serverUrl: string
  serverStatus: HubServerStatus
  /** Latest playback snapshot saved by another device on the hub server. */
  resumeState: ResumeStateInfo | null

  init: () => Promise<void>
  /** Sets (or, empty, removes) the hub server address and switches mode at once. */
  setServerUrl: (url: string) => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  setDeviceName: (name: string) => Promise<void>
  /** Replaces the pairing code: phones paired with the old one are disconnected and must enter the new one. */
  newPairingCode: () => Promise<void>
  selectDevice: (id: string) => void
  /** Spotify Connect-style one-click output switch (hands off active playback when appropriate). */
  switchOutput: (targetId: string) => boolean
  sendCommand: (action: string, payload?: unknown) => void
  /** Pulls playback (song, upNext, playhead, shuffle, repeatMode) from `fromDeviceId` onto this PC. */
  handoffToHere: (fromDeviceId?: string) => boolean
  /** Pushes this PC's current playback to `targetDeviceId` and switches control to it. */
  handoffToDevice: (targetDeviceId: string) => boolean
  /** Resumes playback from `resumeState` onto this PC. */
  applyResume: () => boolean
  /** Dismisses the `resumeState` banner without applying it. */
  dismissResume: () => void
}

let listenersWired = false
let subscribedToPlayback = false
let lastStatePush = 0
let sessionRefreshTimer: ReturnType<typeof setInterval> | null = null

function pickAutoTarget(
  deviceList: RemoteDeviceSummary[],
  devices: Record<string, RemoteDeviceState>,
  selectedDeviceId: string,
  manualSelection: boolean
): string {
  if (manualSelection || useNavidromeStore.getState().isPlaying || selectedDeviceId !== LOCAL_DEVICE_ID) {
    return selectedDeviceId
  }
  const playing = deviceList.find((d) => {
    if (d.deviceId === 'hub') return false
    const st = devices[d.deviceId]
    return !!(st?.isPlaying && st?.song)
  })
  return playing ? playing.deviceId : selectedDeviceId
}

function stopSessionRefresh(): void {
  if (sessionRefreshTimer) {
    clearInterval(sessionRefreshTimer)
    sessionRefreshTimer = null
  }
}

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
      const seconds = Number(typeof payload === 'number' ? payload : payload?.seconds)
      if (!Number.isFinite(seconds) || seconds < 0) break
      seekTo(seconds)
      useNavidromeStore.setState({ currentTime: seconds })
      break
    }
    case 'setVolume': {
      const volume = Number(typeof payload === 'number' ? payload : payload?.volume)
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

export const useRemoteStore = create<RemoteState>((set, get) => {
  const startSessionRefresh = (): void => {
    stopSessionRefresh()
    sessionRefreshTimer = setInterval(() => {
      const st = get()
      if (!st.serverUrl || st.serverStatus.state !== 'connected') {
        stopSessionRefresh()
        return
      }
      void window.api.hubServer.refreshSessions()
      const nav = useNavidromeStore.getState()
      const currentSong = nav.queue[nav.queueIndex] || null
      if (currentSong || nav.isPlaying) {
        void window.api.remote.pushState({ ...currentStatePayload() })
      }
    }, SESSION_REFRESH_MS)
  }

  return {
  enabled: false,
  running: false,
  address: null,
  pairingCode: null,
  error: null,
  deviceName: 'PC',
  deviceList: [],
  devices: {},
  selectedDeviceId: LOCAL_DEVICE_ID,
  manualSelection: false,
  serverUrl: '',
  serverStatus: { state: 'off' },
  resumeState: null,

  init: async () => {
    const [enabled, deviceName, serverUrl] = await Promise.all([
      storage.loadPref<boolean>('remote.enabled'),
      storage.loadPref<string>('remote.deviceName'),
      storage.loadPref<string>('hubServerUrl')
    ])
    set({ enabled: !!enabled, deviceName: deviceName || 'PC', serverUrl: typeof serverUrl === 'string' ? serverUrl : '' })

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
          const disappeared = st.selectedDeviceId !== LOCAL_DEVICE_ID && !knownIds.has(st.selectedDeviceId)
          const baseSelected = disappeared ? LOCAL_DEVICE_ID : st.selectedDeviceId
          const manualSelection = disappeared ? false : st.manualSelection
          const selectedDeviceId = pickAutoTarget(list, devicesState, baseSelected, manualSelection)
          return { deviceList: list, devices: devicesState, selectedDeviceId, manualSelection }
        })
      })
      window.api.remote.onDeviceState((data) => {
        const { deviceId, type: _type, ...state } = data
        set((st) => {
          const devices = { ...st.devices, [deviceId]: state as RemoteDeviceState }
          const selectedDeviceId = pickAutoTarget(st.deviceList, devices, st.selectedDeviceId, st.manualSelection)
          return { devices, selectedDeviceId }
        })
      })
      window.api.remote.onCommand((command) => {
        applyCommandLocally(command.action, command.payload)
      })
      window.api.hubServer.onStatus((serverStatus) => {
        if (!get().serverUrl) {
          stopSessionRefresh()
          return
        }
        const wasConnected = get().serverStatus.state === 'connected'
        const connected = serverStatus.state === 'connected'
        if (connected) startSessionRefresh()
        else stopSessionRefresh()
        set((st) => ({
          serverStatus,
          running: connected,
          ...(!connected || !wasConnected ? { manualSelection: false } : {}),
          // Out of reach, the other devices are unknown: back to this PC.
          ...(connected ? {} : { deviceList: [], devices: {}, selectedDeviceId: LOCAL_DEVICE_ID, resumeState: null }),
          error: st.error
        }))
      })
      window.api.hubServer.onResumeState((payload) => {
        const ownId = get().serverStatus.deviceId
        if (!payload?.state || !(payload.state as { song?: unknown }).song) {
          if (payload?.state === null) set({ resumeState: null })
          return
        }
        if (typeof payload.deviceId !== 'string' || !payload.deviceId) return
        if (ownId && payload.deviceId === ownId) return
        set({
          resumeState: {
            deviceId: payload.deviceId,
            deviceName: typeof payload.deviceName === 'string' && payload.deviceName ? payload.deviceName : 'un autre appareil',
            platform: typeof payload.platform === 'string' ? payload.platform : 'mobile',
            updatedAt: typeof payload.updatedAt === 'number' ? payload.updatedAt : Date.now(),
            state: payload.state as unknown as RemoteDeviceState
          }
        })
      })
    }

    if (!subscribedToPlayback) {
      subscribedToPlayback = true
      const saveResumeIfConnected = (): void => {
        const st = get()
        if (!st.serverUrl || st.serverStatus.state !== 'connected') return
        if (st.selectedDeviceId !== LOCAL_DEVICE_ID) return
        const payload = currentStatePayload()
        if (!payload.song) return
        const snapshot = {
          song: payload.song,
          upNext: payload.upNext ?? [],
          isPlaying: payload.isPlaying,
          currentTime: payload.currentTime,
          duration: payload.duration,
          shuffle: payload.shuffle,
          repeatMode: payload.repeatMode,
          volume: payload.volume
        }
        void window.api.hubServer.saveResume(snapshot)
      }
      useNavidromeStore.subscribe((state, prev) => {
        if (!prev.isPlaying && state.isPlaying) {
          set({ selectedDeviceId: LOCAL_DEVICE_ID, manualSelection: true })
        }
        if (!get().enabled && !get().serverUrl) return
        const song = state.queue[state.queueIndex] || null
        const prevSong = prev.queue[prev.queueIndex] || null
        const songChanged = song?.id !== prevSong?.id
        const paused = prev.isPlaying && !state.isPlaying
        const changed =
          songChanged ||
          state.isPlaying !== prev.isPlaying ||
          state.shuffle !== prev.shuffle ||
          state.repeatMode !== prev.repeatMode ||
          state.volume !== prev.volume
        if ((paused || songChanged) && song) saveResumeIfConnected()
        const now = Date.now()
        if (!changed && now - lastStatePush < 900) return
        lastStatePush = now
        window.api.remote.pushState({ ...currentStatePayload() })
      })
      window.addEventListener('beforeunload', saveResumeIfConnected)
    }

    // With a hub server address, the PC is a device of that server and runs no LAN hub of its own.
    if (get().serverUrl) {
      const signedIn = await storage.loadConnection('navidrome')
      if (signedIn) {
        const res = await window.api.hubServer.connect(get().serverUrl)
        const current = await window.api.hubServer.status()
        const connected = current.state === 'connected'
        set({ error: res.ok ? null : res.error || 'adresse invalide', serverStatus: current, running: connected, manualSelection: false })
        if (connected) {
          startSessionRefresh()
          void window.api.hubServer.getResume()
        } else {
          stopSessionRefresh()
        }
      } else {
        stopSessionRefresh()
        await window.api.hubServer.disconnect()
        set({ running: false, error: null, manualSelection: false })
      }
      set({ pairingCode: null, address: null })
      return
    }
    stopSessionRefresh()
    await window.api.hubServer.disconnect()

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

  setServerUrl: async (url) => {
    const clean = url.trim()
    const previous = get().serverUrl
    await storage.savePref('hubServerUrl', clean)
    if (clean !== previous) clearOtherDevices()
    stopSessionRefresh()
    // Leaving the LAN mode (or coming back to it): the LAN hub is stopped, then init starts whichever mode applies.
    if (clean) await window.api.remote.stop()
    set({
      serverUrl: clean,
      serverStatus: { state: 'off' },
      running: false,
      deviceList: [],
      devices: {},
      selectedDeviceId: LOCAL_DEVICE_ID,
      manualSelection: false,
      resumeState: null
    })
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
    if (id !== LOCAL_DEVICE_ID && useNavidromeStore.getState().isPlaying) {
      // Switching output to a remote device: silence local audio so it doesn't
      // keep playing here while this UI drives the other device instead.
      useNavidromeStore.getState().togglePlay()
    }
    set({ selectedDeviceId: id, manualSelection: true })
  },

  switchOutput: (targetId) => {
    if (targetId === LOCAL_DEVICE_ID) {
      const { deviceList, devices } = get()
      const playing = deviceList.find(
        (d) => d.deviceId !== 'hub' && devices[d.deviceId]?.isPlaying && devices[d.deviceId]?.song
      )
      if (playing) return get().handoffToHere(playing.deviceId)
      get().selectDevice(LOCAL_DEVICE_ID)
      return true
    }
    const nav = useNavidromeStore.getState()
    const currentSong = nav.queue[nav.queueIndex] || null
    if (nav.isPlaying && currentSong) return get().handoffToDevice(targetId)
    get().selectDevice(targetId)
    return true
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
    set({ selectedDeviceId: LOCAL_DEVICE_ID, manualSelection: true })
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
    set({ selectedDeviceId: targetDeviceId, manualSelection: true })
    return true
  },

  applyResume: () => {
    const { resumeState } = get()
    if (!resumeState?.state?.song) return false
    set({ selectedDeviceId: LOCAL_DEVICE_ID, manualSelection: true, resumeState: null })
    applyHandoff(resumeState.state)
    return true
  },

  dismissResume: () => set({ resumeState: null })
  }
})
