import { AppState } from 'react-native'
import { create } from 'zustand'
import { countsAsPlay, MAX_TICK_S } from '@/services/scrobbler'
import { storage } from '@/services/storage'
import { addListening, addPlay, Ledger, mergedView, mergeLedgers, prune, sanitizeLedger, weekKey, WeekLog } from '@/services/wrapped'
import { useNavidromeStore } from '@/store/navidromeStore'

/**
 * Writes down what is listened to on this phone, week by week, for the weekly Wrapped (services/wrapped.ts). The
 * time is what was actually heard: the player's progress while it plays, without pauses or seeks, the same ticks the
 * scrobbler counts. It stays on this phone (Navidrome keeps no history of plays to read back), unless a hub server is
 * set (docs/server-protocol.md): then services/listeningSync.ts uploads the weeks that changed and downloads the other
 * devices' weeks, which are kept here apart from this phone's own and added to them in what the Wrapped shows.
 *
 * Saved after every 30 seconds heard and at each change of song, not on a timer: timers don't run with the screen
 * off, the player's progress does. Each week is its own entry (and a list of them), and only the weeks that changed
 * are written: half a year of weeks in one entry could pass the size Android's storage can read back.
 */
const INDEX_KEY = 'listening.weeks'
const weekEntry = (week: string): string => `listening.week.${week}`
/** The weeks that changed since the server last acknowledged them. */
const DIRTY_KEY = 'listening.dirty'
/** The other devices: { deviceId: { deviceName, platform, weeks: [week keys] } }, their weeks being entries of their own. */
const OTHERS_KEY = 'listening.others'
const otherEntry = (deviceId: string, week: string): string => `listening.other.${deviceId}.${week}`
/** The highest server revision pulled. */
const REV_KEY = 'listening.rev'
/** Heard seconds not yet saved, at most: what an app killed in the background can lose. */
const SAVE_EVERY_S = 30

/** A device whose listening this phone downloaded. */
export interface OtherDevice {
  deviceName: string
  platform: string
  weeks: Ledger
}

export interface OtherDeviceInfo {
  deviceId: string
  deviceName: string
  platform: string
}

interface ListeningState {
  /**
   * The weeks as last saved, this phone's and every other device's added together: what the Wrapped and Settings show
   * (the current week lags by up to 30 s). Without a server it is this phone's alone.
   */
  weeks: Ledger
  loaded: boolean
  /** The other devices whose listening is in `weeks`. */
  devices: OtherDeviceInfo[]
  /** How many weeks wait to be uploaded. */
  dirty: number
}

export const useListeningStore = create<ListeningState>(() => ({ weeks: {}, loaded: false, devices: [], dirty: 0 }))

interface CurrentSong {
  id: string
  listened: number
  counted: boolean
}

let started = false
/** This phone's own listening, live. */
let ledger: Ledger = {}
/** This phone's own weeks as last saved (copies, never changed after being made). */
let ownView: Ledger = {}
let others: Record<string, OtherDevice> = {}
let rev = 0
let loaded = false
let current: CurrentSong | null = null
let unsaved = 0
/** The weeks changed since the last save. */
const changed = new Set<string>()
/** The list of weeks as last saved. */
let savedIndex = ''
/** The weeks to upload, each with the number of the change that made it so: an upload only clears the change it sent. */
const dirty = new Map<string, number>()
let dirtyClock = 0
let loadWaiters: Array<() => void> = []

const copy = (week: WeekLog): WeekLog => JSON.parse(JSON.stringify(week)) as WeekLog

function markDirty(key: string): void {
  dirty.set(key, ++dirtyClock)
}

function saveDirty(): void {
  storage.savePref(DIRTY_KEY, [...dirty.keys()]).catch(() => {})
}

function deviceInfos(): OtherDeviceInfo[] {
  return Object.entries(others)
    .map(([deviceId, device]) => ({ deviceId, deviceName: device.deviceName, platform: device.platform }))
    .sort((a, b) => a.deviceName.localeCompare(b.deviceName, 'fr'))
}

/** What the screens show: this phone's weeks, with the other devices' added when there are any. */
function publish(): void {
  const list = Object.values(others)
  const weeks = list.length === 0 ? { ...ownView } : mergedView(ownView, list.map((device) => device.weeks))
  useListeningStore.setState({ weeks, devices: deviceInfos(), dirty: dirty.size })
}

/** Saves the weeks that changed and shows them to the screens. */
function save(): void {
  if (!loaded) return
  unsaved = 0
  const removed = prune(ledger, Date.now())
  const updates: Ledger = {}
  for (const key of changed) {
    // A copy: the ledger keeps changing under the screens between two saves.
    if (ledger[key]) updates[key] = copy(ledger[key])
  }
  changed.clear()
  const index = Object.keys(ledger).sort()
  const indexText = index.join(',')
  if (Object.keys(updates).length === 0 && removed.length === 0 && indexText === savedIndex) return

  Object.assign(ownView, updates)
  for (const key of removed) {
    delete ownView[key]
    dirty.delete(key)
  }
  for (const key of Object.keys(updates)) markDirty(key)
  publish()
  saveDirty()
  for (const [key, week] of Object.entries(updates)) storage.savePref(weekEntry(key), week).catch(() => {})
  for (const key of removed) storage.removePref(weekEntry(key)).catch(() => {})
  if (indexText !== savedIndex) {
    savedIndex = indexText
    storage.savePref(INDEX_KEY, index).catch(() => {})
  }
}

/** Saves now what was heard since the last save (the Wrapped is being opened, the app goes to the background). */
export function flushListening(): void {
  save()
}

interface Saved {
  own: Ledger
  others: Record<string, OtherDevice>
  dirty: string[]
  rev: number
}

async function loadOthers(): Promise<Record<string, OtherDevice>> {
  const index = await storage.loadPref<unknown>(OTHERS_KEY).catch(() => null)
  const result: Record<string, OtherDevice> = {}
  if (!index || typeof index !== 'object') return result
  await Promise.all(
    Object.entries(index as Record<string, any>).map(async ([deviceId, info]) => {
      const keys: string[] = Array.isArray(info?.weeks) ? info.weeks.filter((key: unknown): key is string => typeof key === 'string') : []
      const logs = await Promise.all(keys.map((key) => storage.loadPref<unknown>(otherEntry(deviceId, key)).catch(() => null)))
      const weeks = sanitizeLedger(Object.fromEntries(keys.map((key, i) => [key, logs[i]])))
      if (Object.keys(weeks).length === 0) return
      result[deviceId] = {
        deviceName: typeof info?.deviceName === 'string' ? info.deviceName : 'Appareil',
        platform: typeof info?.platform === 'string' ? info.platform : 'mobile',
        weeks
      }
    })
  )
  return result
}

async function loadSaved(): Promise<Saved> {
  const index = await storage.loadPref<unknown>(INDEX_KEY).catch(() => null)
  const keys = Array.isArray(index) ? index.filter((key): key is string => typeof key === 'string') : []
  savedIndex = [...keys].sort().join(',')
  const weeks = await Promise.all(keys.map((key) => storage.loadPref<unknown>(weekEntry(key)).catch(() => null)))
  const [savedOthers, savedDirty, savedRev] = await Promise.all([
    loadOthers().catch(() => ({}) as Record<string, OtherDevice>),
    storage.loadPref<unknown>(DIRTY_KEY).catch(() => null),
    storage.loadPref<unknown>(REV_KEY).catch(() => null)
  ])
  return {
    own: sanitizeLedger(Object.fromEntries(keys.map((key, i) => [key, weeks[i]]))),
    others: savedOthers,
    dirty: Array.isArray(savedDirty) ? savedDirty.filter((key): key is string => typeof key === 'string') : [],
    rev: typeof savedRev === 'number' && Number.isFinite(savedRev) && savedRev > 0 ? savedRev : 0
  }
}

// --- What the sync reads and writes (services/listeningSync.ts) ---

/** Resolves once what was saved has been read back (at once if it already has). */
export function whenListeningLoaded(): Promise<void> {
  if (loaded) return Promise.resolve()
  return new Promise((resolve) => loadWaiters.push(resolve))
}

/** The highest server revision pulled so far. */
export function getListeningRev(): number {
  return rev
}

export function setListeningRev(value: number): void {
  if (!Number.isFinite(value) || value === rev) return
  rev = value
  storage.savePref(REV_KEY, rev).catch(() => {})
}

/**
 * Up to `max` of the weeks to upload, the most recent first, and the number of the change each is at: give both back
 * to ackDirtyWeeks once the server has them.
 */
export function takeDirtyWeeks(max: number): { weeks: Ledger; versions: Record<string, number> } {
  const keys = [...dirty.keys()].filter((key) => ownView[key]).sort().reverse().slice(0, max)
  const weeks: Ledger = {}
  const versions: Record<string, number> = {}
  for (const key of keys) {
    weeks[key] = ownView[key]
    versions[key] = dirty.get(key) as number
  }
  return { weeks, versions }
}

/** The server has these weeks: they are no longer to upload, unless they changed again since they were taken. */
export function ackDirtyWeeks(keys: string[], versions: Record<string, number>): number {
  let cleared = 0
  for (const key of keys) {
    if (dirty.has(key) && dirty.get(key) === versions[key]) {
      dirty.delete(key)
      cleared++
    }
  }
  if (cleared > 0) {
    saveDirty()
    useListeningStore.setState({ dirty: dirty.size })
  }
  return cleared
}

/**
 * Adds weeks of other devices, as the server's `listening.data` entries give them: each is checked, kept apart from
 * the others, pruned like this phone's own, and saved. Returns whether anything was kept.
 */
export function applyOtherEntries(entries: unknown): boolean {
  if (!loaded || !Array.isArray(entries)) return false
  const touched = new Map<string, Set<string>>()
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue
    const { deviceId, deviceName, platform, week, log } = raw as Record<string, unknown>
    if (typeof deviceId !== 'string' || deviceId.length === 0 || typeof week !== 'string') continue
    const clean = sanitizeLedger({ [week]: log })[week]
    if (!clean) continue
    const device = (others[deviceId] ??= { deviceName: 'Appareil', platform: 'mobile', weeks: {} })
    if (typeof deviceName === 'string' && deviceName) device.deviceName = deviceName
    if (typeof platform === 'string' && platform) device.platform = platform
    device.weeks[week] = clean
    if (!touched.has(deviceId)) touched.set(deviceId, new Set())
    touched.get(deviceId)!.add(week)
  }
  if (touched.size === 0) return false

  const now = Date.now()
  for (const [deviceId, weeks] of touched) {
    const device = others[deviceId]
    for (const key of prune(device.weeks, now)) {
      weeks.add(key)
    }
    for (const key of weeks) {
      if (device.weeks[key]) storage.savePref(otherEntry(deviceId, key), device.weeks[key]).catch(() => {})
      else storage.removePref(otherEntry(deviceId, key)).catch(() => {})
    }
    if (Object.keys(device.weeks).length === 0) delete others[deviceId]
  }
  saveOthersIndex()
  publish()
  return true
}

function saveOthersIndex(): void {
  const index: Record<string, { deviceName: string; platform: string; weeks: string[] }> = {}
  for (const [deviceId, device] of Object.entries(others)) {
    index[deviceId] = { deviceName: device.deviceName, platform: device.platform, weeks: Object.keys(device.weeks) }
  }
  storage.savePref(OTHERS_KEY, index).catch(() => {})
}

/**
 * Forgets the other devices (the server was removed or changed), and marks every week of this phone to upload to the
 * next server. This phone's own listening is untouched.
 */
export function clearOtherDevices(): void {
  for (const [deviceId, device] of Object.entries(others)) {
    for (const key of Object.keys(device.weeks)) storage.removePref(otherEntry(deviceId, key)).catch(() => {})
  }
  others = {}
  storage.removePref(OTHERS_KEY).catch(() => {})
  rev = 0
  storage.removePref(REV_KEY).catch(() => {})
  if (loaded) {
    for (const key of Object.keys(ownView)) markDirty(key)
    saveDirty()
    publish()
  }
}

export function startListeningLog(): void {
  if (started) return
  started = true

  loadSaved()
    .catch(() => ({ own: {}, others: {}, dirty: [], rev: 0 }) as Saved)
    .then((saved) => {
      // What was heard while it loaded goes on top of what was saved (those weeks are already marked changed).
      ledger = mergeLedgers(saved.own, ledger)
      ownView = Object.fromEntries(Object.entries(ledger).map(([key, week]) => [key, copy(week)]))
      others = saved.others
      for (const device of Object.values(others)) prune(device.weeks, Date.now())
      rev = saved.rev
      for (const key of saved.dirty) if (ownView[key]) markDirty(key)
      loaded = true
      publish()
      useListeningStore.setState({ loaded: true })
      save()
      const waiters = loadWaiters
      loadWaiters = []
      for (const resolve of waiters) resolve()
    })

  useNavidromeStore.subscribe((s, prev) => {
    const song = s.queue[s.queueIndex]
    if (song?.id !== current?.id) {
      // Another song: what was heard of the last one is kept at once.
      if (current) save()
      current = song ? { id: song.id, listened: 0, counted: false } : null
    }
    if (!song || !current) return

    // Repeat-one, or "previous" restarting a song already counted: a new play.
    if (current.counted && s.currentTime < 2 && prev.currentTime > s.currentTime + 10) {
      current = { id: song.id, listened: 0, counted: false }
      return
    }

    const sameSong = prev.queue[prev.queueIndex]?.id === song.id
    const delta = s.currentTime - prev.currentTime
    if (!s.isPlaying || !sameSong || delta <= 0 || delta > MAX_TICK_S) return

    const now = Date.now()
    current.listened += delta
    addListening(ledger, song, delta, now)
    changed.add(weekKey(now))
    unsaved += delta
    if (!current.counted && countsAsPlay(current.listened, song.duration || s.duration)) {
      current.counted = true
      addPlay(ledger, song, now)
      save()
    } else if (unsaved >= SAVE_EVERY_S) {
      save()
    }
  })

  AppState.addEventListener('change', (next) => {
    if (next === 'background') save()
  })
}
