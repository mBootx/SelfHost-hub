import { create } from 'zustand'
import SelfHostNative, { WatchMessage } from '../../modules/selfhost-native'
import { describeError, logEvent } from '@/services/diagnostics'
import { parsePlayMedia, runPlayMedia } from '@/services/playMedia'
import type { RemoteDeviceState, RemoteDeviceSummary } from '@/services/remoteControl'
import { useNavidromeStore } from '@/store/navidromeStore'
import { applyCommandLocally, currentStatePayload, LOCAL_DEVICE_ID, RemoteStatus, useRemoteStore } from '@/store/remoteStore'

/**
 * The live link with a Wear OS watch. The watch never talks to the PC: this phone is the only thing that does (the
 * hub link of store/remoteStore.ts, unchanged). The watch asks this phone, over the Wear OS data layer (the phone and
 * watch's own encrypted link, delivered only to the app of the same package signed with the same key):
 *
 * - it sends a request for the state, answered with a snapshot: this phone's player and the players the hub lists;
 * - it sends commands, which are applied here (this phone's player) or forwarded to the hub (another player);
 * - this phone pushes a fresh snapshot whenever something worth showing changes, so the watch needn't ask.
 *
 * Nothing here relies on a timer: React Native stops its JS timers while the app is off screen, which is when a
 * watch is used most. Everything runs on events (a message from the watch, a change of the stores).
 *
 * The messages are read by wear/core/.../LinkProtocol.kt; tests/watchlink.test.js and wear's LinkCodec tests check
 * against shared sample files, and wear's RealPhoneIntegrationTest runs this very file against the watch's code.
 */

export const LINK_VERSION = 1
export const LINK_PATHS = {
  request: '/selfhost/link/request',
  snapshot: '/selfhost/link/snapshot',
  command: '/selfhost/link/command'
} as const

/** What the watch calls this phone's own player (the phone's real hub id is kept out of the list it sees). */
export const PHONE_ID = LOCAL_DEVICE_ID
const HUB_DEVICE_ID = 'hub'

/** How far a position may be from where the last snapshot says it should be by now before a new one is sent. */
const DRIFT_SECONDS = 2
/** Nobody listening (no watch, or none with the app): stay quiet this long, unless the watch speaks first. */
const NO_WATCH_PAUSE_MS = 2 * 60_000
const ERROR_PAUSE_MS = 30_000
/** The shortest time between two tries to get the link to the PC back because the watch asked. */
const RECONNECT_PAUSE_MS = 90_000
const MAX_DEVICES = 20

export type PcState = 'connected' | 'connecting' | 'disconnected' | 'off' | 'unpaired' | 'error'

/** What the watch is told: the players, and how this phone stands with the PC. Times are in seconds. */
export interface WatchSnapshot {
  v: 1
  phone: string
  pc: { state: PcState; name?: string; message?: string }
  devices: RemoteDeviceSummary[]
  states: Record<string, RemoteDeviceState>
}

export interface SnapshotInput {
  phoneName: string
  enabled: boolean
  paired: boolean
  status: RemoteStatus
  error: string | null
  /** This phone's id at the hub, which the hub also lists among the devices. */
  ownId: string
  deviceList: RemoteDeviceSummary[]
  remoteStates: Record<string, RemoteDeviceState>
  local: RemoteDeviceState
}

const text = (value: unknown, max = 200): string => (typeof value === 'string' ? value.slice(0, max) : '')
const optionalText = (value: unknown, max = 200): string | undefined => (typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined)
const number = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/** Only the fields the watch reads, each checked: the state of another device is whatever that device sent. */
function cleanState(state: RemoteDeviceState): RemoteDeviceState {
  const song = state.song
  const album = optionalText(song?.album)
  const albumId = optionalText(song?.albumId)
  const coverArt = optionalText(song?.coverArt)
  return {
    song:
      song && typeof song.id === 'string' && song.id.length > 0
        ? {
            id: text(song.id),
            title: text(song.title),
            artist: text(song.artist),
            ...(album ? { album } : {}),
            ...(albumId ? { albumId } : {}),
            ...(coverArt ? { coverArt } : {}),
            duration: number(song.duration)
          }
        : null,
    isPlaying: state.isPlaying === true,
    currentTime: Math.max(0, number(state.currentTime)),
    duration: Math.max(0, number(state.duration)),
    shuffle: state.shuffle === true,
    repeatMode: state.repeatMode === 'all' || state.repeatMode === 'one' ? state.repeatMode : 'off',
    volume: Math.min(1, Math.max(0, number(state.volume, 1)))
  }
}

function pcOf(input: SnapshotInput): WatchSnapshot['pc'] {
  if (!input.enabled) return { state: 'off' }
  if (!input.paired) return { state: 'unpaired' }
  if (input.status === 'connected') {
    const hub = input.deviceList.find((d) => d.deviceId === HUB_DEVICE_ID)
    return hub ? { state: 'connected', name: text(hub.deviceName, 60) } : { state: 'connected' }
  }
  if (input.status === 'connecting') return { state: 'connecting' }
  if (input.status === 'error') {
    const message = optionalText(input.error, 120)
    return message ? { state: 'error', message } : { state: 'error' }
  }
  return { state: 'disconnected' }
}

/**
 * The players as the watch sees them. This phone is always the first, under the id "local"; the others are what the
 * hub lists, without this phone's own entry (the hub lists every connected device, the one asking included).
 */
export function buildSnapshot(input: SnapshotInput): WatchSnapshot {
  const phoneName = text(input.phoneName, 60) || 'Téléphone'
  const devices: RemoteDeviceSummary[] = [{ deviceId: PHONE_ID, deviceName: phoneName, platform: 'mobile' }]
  const states: Record<string, RemoteDeviceState> = { [PHONE_ID]: cleanState(input.local) }
  const others = input.deviceList.filter((d) => typeof d.deviceId === 'string' && d.deviceId.length > 0 && d.deviceId !== input.ownId && d.deviceId !== PHONE_ID)
  for (const device of others.slice(0, MAX_DEVICES)) {
    devices.push({ deviceId: text(device.deviceId, 100), deviceName: text(device.deviceName, 60) || 'Appareil', platform: device.platform === 'desktop' ? 'desktop' : 'mobile' })
    const state = input.remoteStates[device.deviceId]
    if (state) states[device.deviceId] = cleanState(state)
  }
  return { v: LINK_VERSION, phone: phoneName, pc: pcOf(input), devices, states }
}

/** The snapshot with every position zeroed: two snapshots with the same text differ only in where the songs are. */
export function snapshotSignature(snapshot: WatchSnapshot): string {
  const states: Record<string, RemoteDeviceState> = {}
  for (const [id, state] of Object.entries(snapshot.states)) states[id] = { ...state, currentTime: 0 }
  return JSON.stringify({ ...snapshot, states })
}

interface Pushed {
  at: number
  snapshot: WatchSnapshot
  signature: string
}

/**
 * Whether `next` tells the watch nothing it doesn't already know: same players, same songs, same settings, and every
 * position where the watch (which moves it along by itself while a song plays) has it by now, give or take a moment.
 */
export function unchangedForWatch(previous: Pushed | null, next: WatchSnapshot, signature: string, now: number): boolean {
  if (!previous || previous.signature !== signature) return false
  for (const [id, state] of Object.entries(next.states)) {
    const before = previous.snapshot.states[id]
    if (!before) return false
    let expected = before.currentTime + (before.isPlaying ? Math.max(0, now - previous.at) / 1000 : 0)
    if (before.duration > 0) expected = Math.min(expected, before.duration)
    if (Math.abs(state.currentTime - expected) > DRIFT_SECONDS) return false
  }
  return true
}

// --- What the watch asks of this phone ---

export const WATCH_ACTIONS = ['toggle', 'play', 'pause', 'next', 'prev', 'seek', 'setVolume', 'toggleShuffle', 'setRepeatMode', 'playMedia'] as const
export type WatchAction = (typeof WATCH_ACTIONS)[number]

export interface WatchCommand {
  /** "local" for this phone's player, otherwise a device the hub lists. */
  targetId: string
  action: WatchAction
  payload?: Record<string, unknown>
}

/** The payload of an action, checked; null when it is not what the action needs. */
function cleanPayload(action: WatchAction, payload: unknown): Record<string, unknown> | undefined | null {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null
  switch (action) {
    case 'seek':
      return body && typeof body.seconds === 'number' && Number.isFinite(body.seconds) && body.seconds >= 0 && body.seconds <= 86_400 ? { seconds: body.seconds } : null
    case 'setVolume':
      return body && typeof body.volume === 'number' && Number.isFinite(body.volume) ? { volume: Math.min(1, Math.max(0, body.volume)) } : null
    case 'setRepeatMode':
      return body && (body.mode === 'off' || body.mode === 'all' || body.mode === 'one') ? { mode: body.mode } : null
    case 'playMedia':
      return body
    default:
      return undefined
  }
}

/** A command from the watch, or null when it is anything else: it comes off a radio link. */
export function parseWatchCommand(json: string): WatchCommand | null {
  if (typeof json !== 'string' || json.length > 4096) return null
  let message: any
  try {
    message = JSON.parse(json)
  } catch {
    return null
  }
  if (!message || typeof message !== 'object' || message.v !== LINK_VERSION) return null
  if (typeof message.targetId !== 'string' || message.targetId.length === 0 || message.targetId.length > 100) return null
  if (typeof message.action !== 'string' || !(WATCH_ACTIONS as readonly string[]).includes(message.action)) return null
  const action = message.action as WatchAction
  const payload = cleanPayload(action, message.payload)
  if (payload === null) return null
  return payload === undefined ? { targetId: message.targetId, action } : { targetId: message.targetId, action, payload }
}

export type CommandOutcome = 'phone' | 'forwarded' | 'media' | 'pc-offline' | 'unknown-player' | 'nothing-to-play'

async function playOnPhone(payload: unknown): Promise<boolean> {
  const request = parsePlayMedia(payload)
  const player = useNavidromeStore.getState()
  if (!request || !player.client) return false
  try {
    return await runPlayMedia(request, player.client, player)
  } catch (err) {
    logEvent('watch', `Lecture demandée par la montre impossible : ${describeError(err)}`, 'warn')
    return false
  }
}

/**
 * Does what the watch asked. Something to play always plays on this phone (the PC cannot be asked to play an album).
 * The rest goes to this phone's own player, or to the hub for another player, if the hub lists it and is connected.
 */
export function applyWatchCommand(command: WatchCommand): CommandOutcome {
  if (command.action === 'playMedia') {
    void playOnPhone(command.payload)
    return 'media'
  }
  const remote = useRemoteStore.getState()
  if (command.targetId === PHONE_ID || (remote.deviceId && command.targetId === remote.deviceId)) {
    applyCommandLocally(command.action, command.payload)
    return 'phone'
  }
  if (remote.status !== 'connected' || !remote.client) return 'pc-offline'
  if (!remote.deviceList.some((d) => d.deviceId === command.targetId)) return 'unknown-player'
  remote.client.sendCommand(command.targetId, command.action, command.payload)
  return 'forwarded'
}

// --- Keeping the watch informed ---

/** What the Montre setting says about the link. */
export const useWatchLinkStatus = create<{ lastContactAt: number | null; lastPushAt: number | null; watches: number | null; error: string | null }>(() => ({
  lastContactAt: null,
  lastPushAt: null,
  watches: null,
  error: null
}))

let started = false
let stops: Array<() => void> = []
let inFlight = false
let again = false
let againForced = false
let lastPushed: Pushed | null = null
let quietUntil = 0
let lastErrorLogAt = 0
let lastReconnectAt = 0

function currentSnapshot(): WatchSnapshot {
  const remote = useRemoteStore.getState()
  return buildSnapshot({
    phoneName: remote.deviceName,
    enabled: remote.enabled,
    paired: remote.pairing !== null,
    status: remote.status,
    error: remote.error,
    ownId: remote.deviceId,
    deviceList: remote.deviceList,
    remoteStates: remote.devices,
    local: currentStatePayload()
  })
}

/**
 * Sends the watches a snapshot, unless it tells them nothing new. `force` is for answering the watch's request,
 * which wants the snapshot whatever was sent before. One send is in flight at a time; whatever changed meanwhile goes
 * out in the next, so a burst of changes (the volume being dragged) becomes a few messages, not hundreds.
 */
async function push(force: boolean): Promise<void> {
  const native = SelfHostNative
  if (!native?.sendToWatch) return
  const now = Date.now()
  if (!force && now < quietUntil) return
  const snapshot = currentSnapshot()
  const signature = snapshotSignature(snapshot)
  if (!force && unchangedForWatch(lastPushed, snapshot, signature, now)) return
  if (inFlight) {
    again = true
    againForced = againForced || force
    return
  }
  inFlight = true
  try {
    const count = await native.sendToWatch(LINK_PATHS.snapshot, JSON.stringify(snapshot))
    useWatchLinkStatus.setState({ lastPushAt: Date.now(), watches: count, error: null })
    if (count > 0) {
      lastPushed = { at: now, snapshot, signature }
      quietUntil = 0
    } else {
      lastPushed = null
      quietUntil = Date.now() + NO_WATCH_PAUSE_MS
    }
  } catch (err) {
    lastPushed = null
    quietUntil = Date.now() + ERROR_PAUSE_MS
    useWatchLinkStatus.setState({ error: describeError(err) })
    // Said once in a while, not at every change of the player, and only to someone who has a watch (a phone without
    // Google's services, or without any watch, would otherwise fill its diagnostics with a message about nothing).
    if (useWatchLinkStatus.getState().lastContactAt !== null && Date.now() - lastErrorLogAt > 10 * 60_000) {
      lastErrorLogAt = Date.now()
      logEvent('watch', `Envoi à la montre impossible : ${describeError(err)}`, 'warn')
    }
  } finally {
    inFlight = false
    if (again) {
      const forced = againForced
      again = false
      againForced = false
      void push(forced)
    }
  }
}

/**
 * The watch asks while the link to the PC is down: this phone tries to get it back (what opening the app does), at most
 * once in a while, so that a PC that is off is not looked for on the network every time the watch wakes up.
 */
function reconnectPc(): void {
  const remote = useRemoteStore.getState()
  if (!remote.enabled || !remote.pairing) return
  if (remote.status !== 'disconnected' && remote.status !== 'error') return
  const now = Date.now()
  if (now - lastReconnectAt < RECONNECT_PAUSE_MS) return
  lastReconnectAt = now
  remote.autoConnect().catch(() => {})
}

/** A message from the watch: a request for the state, or a command. */
export function handleWatchMessage(message: WatchMessage): void {
  const firstContact = useWatchLinkStatus.getState().lastContactAt === null
  useWatchLinkStatus.setState({ lastContactAt: Date.now() })
  // A watch is there after all: stop being quiet.
  quietUntil = 0
  if (firstContact) logEvent('watch', 'La montre est en contact avec le téléphone')

  if (message.path === LINK_PATHS.request) {
    reconnectPc()
    void push(true)
    return
  }
  if (message.path !== LINK_PATHS.command) return
  const command = parseWatchCommand(message.data)
  if (!command) {
    logEvent('watch', 'Commande de la montre illisible', 'warn')
    return
  }
  const outcome = applyWatchCommand(command)
  if (outcome === 'pc-offline' || outcome === 'unknown-player') {
    logEvent('watch', `Commande « ${command.action} » pour ${command.targetId} impossible : ${outcome === 'pc-offline' ? 'le PC n’est pas connecté' : 'appareil inconnu'}`, 'warn')
    // The watch has already shown the effect it expected; tell it how things really are.
    void push(true)
  }
}

/** At app start: answers the watch, and tells it when the players change. */
export function startWatchLink(): void {
  if (started) return
  const native = SelfHostNative
  if (!native?.sendToWatch || !native.addListener) return
  let listener: { remove: () => void }
  try {
    listener = native.addListener('onWatchMessage', (message) => handleWatchMessage(message))
  } catch {
    // an older build without the watch link
    return
  }
  started = true
  const nudge = (): void => void push(false)
  stops = [() => listener.remove(), useNavidromeStore.subscribe(nudge), useRemoteStore.subscribe(nudge)]
  nudge()
}

/** Stops listening and forgets what was sent, so that starting again is like a fresh app start. */
export function stopWatchLink(): void {
  for (const stop of stops) stop()
  stops = []
  started = false
  inFlight = false
  again = false
  againForced = false
  lastPushed = null
  quietUntil = 0
  lastErrorLogAt = 0
  lastReconnectAt = 0
}
