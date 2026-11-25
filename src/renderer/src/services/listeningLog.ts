import { create } from 'zustand'
import { countsAsPlay, MAX_TICK_S } from '@renderer/services/scrobbler'
import { storage } from '@renderer/services/storage'
import { addListening, addPlay, Ledger, mergedView, mergeLedgers, prune, sanitizeLedger, weekKey, WeekLog } from '@renderer/services/wrapped'
import { useNavidromeStore } from '@renderer/store/navidromeStore'

/**
 * Writes down what is listened to on this PC, week by week (see wrapped.ts), and syncs with the hub server when one
 * is configured and connected: uploads this PC's changed weeks in batches of 8 and pulls the other devices' weeks
 * (persisted under `listening.others` + `listening.rev`). `useListeningStore` / `useMergedLedger()` exposes the
 * combined view of this PC plus every other synced device.
 */
const INDEX_KEY = 'listening.index'
const DIRTY_KEY = 'listening.dirty'
const weekEntry = (week: string): string => `listening.w.${week}`
const OTHERS_KEY = 'listening.others'
const otherEntry = (deviceId: string, week: string): string => `listening.other.${deviceId}.${week}`
const REV_KEY = 'listening.rev'

/** Heard seconds not yet saved, at most. */
const SAVE_EVERY_S = 30
const BATCH = 8
const PUSH_EVERY_MS = 60_000
const MAX_PULL_PAGES = 200

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
  /** Combined ledger of this PC and every other synced device. */
  weeks: Ledger
  loaded: boolean
  /** Other devices whose listening is merged into `weeks`. */
  devices: OtherDeviceInfo[]
  dirty: number
}

export const useListeningStore = create<ListeningState>(() => ({ weeks: {}, loaded: false, devices: [], dirty: 0 }))

/** Reactive hook returning the merged ledger (local + remote devices). */
export function useMergedLedger(): Ledger {
  return useListeningStore((s) => s.weeks)
}

interface CurrentSong {
  id: string
  listened: number
  counted: boolean
}

let started = false
let ledger: Ledger = {}
let ownView: Ledger = {}
let others: Record<string, OtherDevice> = {}
let rev = 0
let loaded = false
let current: CurrentSong | null = null
let unsaved = 0
const changed = new Set<string>()
let savedIndex = ''
const dirty = new Set<string>()
const revisions = new Map<string, number>()
let connected = false
let pushing = false
let pulling = false
let pullAgain = false
let lastPush = 0
let pushTimer: ReturnType<typeof setTimeout> | null = null

const copy = (week: WeekLog): WeekLog => JSON.parse(JSON.stringify(week)) as WeekLog

function saveDirty(): void {
  storage.savePref(DIRTY_KEY, [...dirty]).catch(() => {})
}

function setListeningRev(value: number): void {
  if (!Number.isFinite(value) || value === rev) return
  rev = value
  storage.savePref(REV_KEY, rev).catch(() => {})
}

function deviceInfos(): OtherDeviceInfo[] {
  return Object.entries(others)
    .map(([deviceId, device]) => ({ deviceId, deviceName: device.deviceName, platform: device.platform }))
    .sort((a, b) => a.deviceName.localeCompare(b.deviceName, 'fr'))
}

function publish(): void {
  const list = Object.values(others)
  const weeks = list.length === 0 ? { ...ownView } : mergedView(ownView, list.map((device) => device.weeks))
  useListeningStore.setState({ weeks, devices: deviceInfos(), dirty: dirty.size })
}

function saveOthersIndex(): void {
  const index: Record<string, { deviceName: string; platform: string; weeks: string[] }> = {}
  for (const [deviceId, device] of Object.entries(others)) {
    index[deviceId] = { deviceName: device.deviceName, platform: device.platform, weeks: Object.keys(device.weeks) }
  }
  storage.savePref(OTHERS_KEY, index).catch(() => {})
}

/** Saves the weeks that changed. */
function save(): void {
  if (!loaded) return
  unsaved = 0
  const removed = prune(ledger, Date.now())
  const updates: Ledger = {}
  for (const key of changed) {
    if (ledger[key]) updates[key] = copy(ledger[key])
  }
  changed.clear()
  const index = Object.keys(ledger).sort()
  const indexText = index.join(',')
  if (Object.keys(updates).length === 0 && removed.length === 0 && indexText === savedIndex) return

  Object.assign(ownView, updates)
  for (const [key, week] of Object.entries(updates)) {
    storage.savePref(weekEntry(key), week).catch(() => {})
    dirty.add(key)
    revisions.set(key, (revisions.get(key) ?? 0) + 1)
  }
  for (const key of removed) {
    delete ownView[key]
    storage.removePref(weekEntry(key)).catch(() => {})
    dirty.delete(key)
    revisions.delete(key)
  }
  publish()
  if (Object.keys(updates).length > 0 || removed.length > 0) saveDirty()
  if (indexText !== savedIndex) {
    savedIndex = indexText
    storage.savePref(INDEX_KEY, index).catch(() => {})
  }
  scheduleSync()
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

async function loadSaved(): Promise<{ own: Ledger; others: Record<string, OtherDevice>; rev: number }> {
  const index = await storage.loadPref<unknown>(INDEX_KEY).catch(() => null)
  const keys = Array.isArray(index) ? index.filter((key): key is string => typeof key === 'string') : []
  savedIndex = [...keys].sort().join(',')
  const [weeks, savedOthers, savedDirty, savedRev] = await Promise.all([
    Promise.all(keys.map((key) => storage.loadPref<unknown>(weekEntry(key)).catch(() => null))),
    loadOthers().catch(() => ({}) as Record<string, OtherDevice>),
    storage.loadPref<unknown>(DIRTY_KEY).catch(() => null),
    storage.loadPref<unknown>(REV_KEY).catch(() => null)
  ])
  if (Array.isArray(savedDirty)) {
    for (const key of savedDirty) if (typeof key === 'string' && keys.includes(key)) dirty.add(key)
  }
  return {
    own: sanitizeLedger(Object.fromEntries(keys.map((key, i) => [key, weeks[i]]))),
    others: savedOthers,
    rev: typeof savedRev === 'number' && Number.isFinite(savedRev) && savedRev > 0 ? savedRev : 0
  }
}

function applyOtherEntries(entries: unknown): boolean {
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

/** Downloads other devices' weeks since the last revision, page by page. */
async function pullAll(): Promise<void> {
  if (!connected || !loaded) return
  if (pulling) {
    pullAgain = true
    return
  }
  pulling = true
  try {
    do {
      pullAgain = false
      let since = rev
      for (let page = 0; page < MAX_PULL_PAGES; page++) {
        if (!connected) break
        const data = await window.api.hubServer.pullListening(since)
        if (!data) break
        const entries = Array.isArray(data.entries) ? data.entries : []
        applyOtherEntries(entries)
        const lastRev = entries.length > 0 ? entries[entries.length - 1]?.rev : undefined
        if (data.more === true && typeof lastRev === 'number' && lastRev > since) {
          since = lastRev
          setListeningRev(since)
          continue
        }
        if (typeof data.rev === 'number' && data.rev > since) setListeningRev(data.rev)
        break
      }
    } while (pullAgain && connected)
  } catch {
    // Retry on next listening.changed or reconnect.
  } finally {
    pulling = false
  }
}

/** Uploads the dirty weeks, 8 per message, one message at a time. */
async function syncNow(): Promise<void> {
  if (!connected || !loaded || pushing || dirty.size === 0) return
  pushing = true
  lastPush = Date.now()
  try {
    save()
    while (connected && dirty.size > 0) {
      for (const key of [...dirty]) if (!ledger[key]) dirty.delete(key)
      const keys = [...dirty].slice(0, BATCH)
      if (keys.length === 0) break
      const weeks: Record<string, WeekLog> = {}
      const sent = new Map<string, number>()
      for (const key of keys) {
        weeks[key] = copy(ledger[key])
        sent.set(key, revisions.get(key) ?? 0)
      }
      const acked = await window.api.hubServer.pushListening(weeks)
      let progress = false
      for (const key of acked) {
        if (!sent.has(key)) continue
        progress = true
        if ((revisions.get(key) ?? 0) === sent.get(key)) dirty.delete(key)
      }
      saveDirty()
      useListeningStore.setState({ dirty: dirty.size })
      if (!progress) break
    }
  } catch {
    // The connection will say when it is back.
  } finally {
    pushing = false
    if (dirty.size > 0 && connected) scheduleSync()
  }
}

/** Pushes at most every 60 s: now if the last push is old enough, else when it is. */
function scheduleSync(force = false): void {
  if (!connected || dirty.size === 0) return
  if (pushTimer && !force) return
  if (pushTimer) clearTimeout(pushTimer)
  const wait = force ? 0 : Math.max(0, PUSH_EVERY_MS - (Date.now() - lastPush))
  pushTimer = setTimeout(() => {
    pushTimer = null
    void syncNow()
  }, wait)
}

/** Saves now what was heard since the last save and sends it (opening Wrapped, hiding or closing the window). */
export function flushListening(): void {
  save()
  if (connected && dirty.size > 0) {
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = null
    void syncNow()
  }
}

/** Forgets other devices when the hub server changes or is removed, and marks own weeks to upload to the next server. */
export function clearOtherDevices(): void {
  for (const [deviceId, device] of Object.entries(others)) {
    for (const key of Object.keys(device.weeks)) storage.removePref(otherEntry(deviceId, key)).catch(() => {})
  }
  others = {}
  storage.removePref(OTHERS_KEY).catch(() => {})
  rev = 0
  storage.removePref(REV_KEY).catch(() => {})
  if (loaded) {
    for (const key of Object.keys(ownView)) {
      dirty.add(key)
      revisions.set(key, (revisions.get(key) ?? 0) + 1)
    }
    saveDirty()
    publish()
  }
}

export function startListeningLog(): void {
  if (started) return
  started = true

  loadSaved()
    .catch(() => ({ own: {}, others: {}, rev: 0 }))
    .then((saved) => {
      ledger = mergeLedgers(saved.own, ledger)
      ownView = Object.fromEntries(Object.entries(ledger).map(([key, week]) => [key, copy(week)]))
      others = saved.others
      for (const device of Object.values(others)) prune(device.weeks, Date.now())
      rev = saved.rev
      loaded = true
      publish()
      useListeningStore.setState({ loaded: true })
      save()
      if (connected) {
        scheduleSync(true)
        void pullAll()
      }
    })

  const onStatus = (status: { state: string }): void => {
    const was = connected
    connected = status.state === 'connected'
    if (connected && !was) {
      scheduleSync(true)
      void pullAll()
    }
  }
  window.api.hubServer.onStatus(onStatus)
  window.api.hubServer.onListeningChanged(() => {
    if (connected) void pullAll()
  })
  window.api.hubServer.status().then(onStatus).catch(() => {})

  window.addEventListener('beforeunload', flushListening)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushListening()
  })

  useNavidromeStore.subscribe((s, prev) => {
    const song = s.queue[s.queueIndex]
    if (song?.id !== current?.id) {
      if (current) save()
      current = song ? { id: song.id, listened: 0, counted: false } : null
    }
    if (!song || !current) return

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
}
