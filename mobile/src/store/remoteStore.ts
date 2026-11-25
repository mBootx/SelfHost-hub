import { create, StoreApi } from 'zustand'
import * as Device from 'expo-device'
import { describeError, logEvent } from '@/services/diagnostics'
import { useNavidromeStore, RepeatMode } from './navidromeStore'
import { engine, seekTo } from '@/services/playbackEngine'
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
import { HubServerClient, isValidServerUrl, loadOrCreateDeviceId, normalizeServerUrl } from '@/services/hubServer'
import { attachListeningSync } from '@/services/listeningSync'
import { clearOtherDevices } from '@/services/listeningLog'

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
 *
 * With a hub server address set (`serverUrl`, docs/server-protocol.md) none of that applies: the phone connects to the
 * server with its Navidrome account, the PC is a device like any other in the list (there is no "hub" device), and the
 * rest of the app sees the same shape either way (devices, states, sendCommand).
 */
export const LOCAL_DEVICE_ID = 'local'

const NEEDS_PAIRING = "Appairez ce téléphone avec le PC : saisissez le code affiché dans les réglages de l'application PC"

export type RemoteStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/** The PC this phone was paired with: which one (not a secret) and the code that proves it (a secret). */
export interface Pairing {
  hubId: string
  code: string
}

/** What the rest of the app needs of a connection, LAN hub or server alike. */
export interface RemoteLink {
  sendCommand: (targetId: string, action: string, payload?: unknown) => void
  sendState: (state: RemoteDeviceState) => void
  close: () => void
}

interface RemoteControlState {
  enabled: boolean
  status: RemoteStatus
  error: string | null
  client: RemoteLink | null
  deviceId: string
  deviceName: string
  pairing: Pairing | null
  /** The hub server's address, normalised; empty means the LAN mode with the PC as hub. */
  serverUrl: string
  /** The Navidrome user the server signed this phone in as, while connected to a server. */
  serverUser: string | null
  serverName: string | null
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
  /**
   * Sets (or, with an empty address, removes) the hub server and connects to it. False when the address cannot be
   * dialled. Turns remote control on when a server is set.
   */
  setServerUrl: (url: string) => Promise<boolean>
  disconnect: () => void
  selectDevice: (id: string) => void
  sendCommand: (action: string, payload?: unknown) => void
}

let subscribedToPlayback = false
let lastStatePush = 0
/** A link to the PC that dropped is looked for again after this long (the PC restarting, the Wi-Fi switching). */
const RECONNECT_DELAY_MS = 3000

/** The listening sync of the current server connection, if there is one. */
let detachListeningSync: (() => void) | null = null

function stopServerLink(): void {
  detachListeningSync?.()
  detachListeningSync = null
}

/** The user and token the server asks for: Navidrome's own Subsonic token (md5(password + salt)) with the server's nonce as salt. */
function navidromeAuth(nonce: string): { user: string; token: string } | null {
  const client = useNavidromeStore.getState().client
  if (!client) return null
  const login = client.sharedLogin(nonce)
  return { user: login.username, token: login.token }
}

/** Plays what another device asked for. Anything out of range or of an unknown kind is ignored. */
export function applyCommandLocally(action: string, payload: any): void {
  const s = useNavidromeStore.getState()
  switch (action) {
    // Play and pause act on the player at once, as a press on the Now Bar does (the engine then tells the store): they
    // no longer wait for the screen's effects to carry the store's change to the player.
    case 'toggle':
      setPlaying(!s.isPlaying)
      break
    case 'play':
      setPlaying(true)
      break
    case 'pause':
      setPlaying(false)
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

/** Plays or pauses this phone's player, for a watch or a PC; nothing to play, nothing happens. */
function setPlaying(playing: boolean): void {
  if (useNavidromeStore.getState().queue.length === 0) return
  // Even when the store already says so: the player is put right if it ever drifted from the store.
  engine.remotePlayState(playing)
  // The engine tells the store through the player's handlers; without them (no player mounted) the store is set here.
  if (useNavidromeStore.getState().isPlaying !== playing) useNavidromeStore.setState({ isPlaying: playing })
}

/** What this phone's own player is doing, in the shape the hub (and the watch, through watchLink) reads. */
export function currentStatePayload(): RemoteDeviceState {
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

type SetState = StoreApi<RemoteControlState>['setState']
type GetState = StoreApi<RemoteControlState>['getState']

/** A new list of devices: the states and the selection of those that left are dropped. */
function applyDeviceList(devices: RemoteDeviceSummary[], set: SetState, get: GetState): void {
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
}

function wireClient(client: RemoteHubClient, set: SetState, get: GetState): void {
  client.onDevices((devices) => applyDeviceList(devices, set, get))
  client.onState((state) => {
    const { deviceId, ...rest } = state
    set({ devices: { ...get().devices, [deviceId]: rest as RemoteDeviceState } })
  })
  client.onCommand((command) => applyCommandLocally(command.action, command.payload))
  client.onClose(() => {
    // A connection replaced since (turned off and on, paired again) closing late must not undo the new one.
    if (get().client !== client) return
    set({ status: 'disconnected', client: null, deviceList: [], devices: {}, selectedDeviceId: LOCAL_DEVICE_ID })
    logEvent('remote', 'Liaison avec le PC perdue')
    // It dropped on its own (the PC restarted, the Wi-Fi changed): it is looked for again once, a moment later.
    setTimeout(() => {
      const { enabled, pairing, status } = get()
      if (enabled && pairing && status === 'disconnected') get().autoConnect().catch(() => {})
    }, RECONNECT_DELAY_MS)
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

  /** Connects to the hub server (its address is `serverUrl`), replacing whatever link there was. */
  function connectServer(): void {
    stopServerLink()
    const previous = get().client
    set({ client: null })
    previous?.close()

    const { serverUrl, deviceId, deviceName } = get()
    const client = new HubServerClient({ baseUrl: serverUrl, deviceId, deviceName, getAuth: navidromeAuth })
    client.onDevices((devices) => {
      if (get().client !== client) return
      // The server lists every device of the account, this phone included.
      applyDeviceList(
        devices.filter((d) => d.deviceId !== get().deviceId),
        set,
        get
      )
    })
    client.onState((state) => {
      if (get().client !== client) return
      const { deviceId: from, ...rest } = state as { deviceId: string } & RemoteDeviceState & { type?: string }
      delete rest.type
      set({ devices: { ...get().devices, [from]: rest as RemoteDeviceState } })
    })
    client.onCommand((command) => {
      if (get().client === client) applyCommandLocally(command.action, command.payload)
    })
    client.onStatus((status, info) => {
      // A connection replaced since (turned off and on, another server) reporting late must not undo the new one.
      if (get().client !== client) return
      if (status === 'connected') {
        set({ status: 'connected', error: null, serverUser: info.user ?? null, serverName: info.serverName ?? null })
        logEvent('remote', `Connecté au serveur${info.user ? ` (${info.user})` : ''}`)
        client.sendState(currentStatePayload())
        return
      }
      const gone = { deviceList: [], devices: {}, selectedDeviceId: LOCAL_DEVICE_ID, serverUser: null }
      if (status === 'refused') {
        set({ ...gone, status: 'error', error: info.message ?? 'Connexion refusée par le serveur' })
        logEvent('remote', `Serveur : ${info.message ?? 'connexion refusée'}`, 'warn')
      } else if (status === 'connecting') {
        set({ ...gone, status: 'connecting', error: null })
      } else {
        set({ ...gone, status: 'disconnected', error: null })
      }
    })
    detachListeningSync = attachListeningSync(client)
    set({ client, status: 'connecting', error: null, deviceList: [], devices: {}, selectedDeviceId: LOCAL_DEVICE_ID, serverUser: null })
    client.start()
  }

  return {
    enabled: false,
    status: 'disconnected',
    error: null,
    client: null,
    deviceId: '',
    deviceName: '',
    pairing: null,
    serverUrl: '',
    serverUser: null,
    serverName: null,
    deviceList: [],
    devices: {},
    selectedDeviceId: LOCAL_DEVICE_ID,

    init: async () => {
      const deviceId = await loadOrCreateDeviceId()
      const [enabled, deviceName, pairing, serverUrl] = await Promise.all([
        storage.loadPref<boolean>('remote.enabled'),
        storage.loadPref<string>('remote.deviceName'),
        loadPairing(),
        storage.loadPref<string>('remote.serverUrl')
      ])
      set({
        deviceId,
        deviceName: deviceName || Device.modelName || 'Téléphone',
        enabled: !!enabled,
        pairing,
        serverUrl: normalizeServerUrl(serverUrl ?? '')
      })

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
        // The Navidrome login arrives (or changes) after the server refused for lack of one: no waiting for the next try.
        useNavidromeStore.subscribe((state, prev) => {
          const { client } = get()
          if (state.client && state.client !== prev.client && client instanceof HubServerClient) client.retryNow(true)
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
      if (get().serverUrl) {
        // Server mode: the connection retries by itself; this only hurries it up (or starts it).
        const { client } = get()
        if (client instanceof HubServerClient) client.retryNow()
        else connectServer()
        return
      }
      if (get().status === 'connecting' || get().status === 'connected') return
      const { pairing } = get()
      if (!pairing) {
        set({ status: 'error', error: NEEDS_PAIRING })
        return
      }
      set({ status: 'connecting', error: null })

      const lastIp = await storage.loadPref<string>('remote.lastHubIp')
      if (lastIp && (await get().connectManual(lastIp))) return
      // Turned off while the last address was tried.
      if (!get().enabled) return
      // Still looking: the failed try at the last address is not the outcome.
      set({ status: 'connecting', error: null })

      const [hub] = await discoverHubs({ hubId: pairing.hubId })
      if (!get().enabled) return
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

    setServerUrl: async (input) => {
      const url = normalizeServerUrl(input)
      if (url && !isValidServerUrl(url)) return false
      const previous = get().serverUrl
      get().disconnect()
      await storage.savePref('remote.serverUrl', url)
      // Another server (or none) does not know the revisions and devices of the last: they are forgotten, and every week
      // of this phone is to be uploaded again.
      if (url !== previous) clearOtherDevices()
      set({ serverUrl: url, serverUser: null, serverName: null, error: null })
      if (url) {
        await storage.savePref('remote.enabled', true)
        set({ enabled: true })
        connectServer()
      } else if (get().enabled) {
        await get().autoConnect()
      }
      return true
    },

    disconnect: () => {
      const { client } = get()
      stopServerLink()
      set({ client: null, status: 'disconnected', deviceList: [], devices: {}, selectedDeviceId: LOCAL_DEVICE_ID, error: null, serverUser: null })
      client?.close()
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
