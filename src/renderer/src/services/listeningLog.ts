import { countsAsPlay, MAX_TICK_S } from '@renderer/services/scrobbler'
import { storage } from '@renderer/services/storage'
import { addListening, addPlay, Ledger, mergeLedgers, prune, sanitizeLedger, weekKey, WeekLog } from '@renderer/services/wrapped'
import { useNavidromeStore } from '@renderer/store/navidromeStore'

/**
 * Writes down what is listened to on this PC, week by week (see wrapped.ts), and uploads it to the hub server when
 * one is configured and connected. The time is what was actually heard: the player's progress while it plays,
 * without pauses or seeks (the same ticks the scrobbler counts). Local time.
 *
 * Each week is its own pref (and a list of them), only the weeks that changed are written. The weeks changed since
 * the last server acknowledgement are "dirty" and persisted too; they go out in batches of 8, at most every 60 s
 * and when the window is hidden or closed. The PC pulls nothing (no Wrapped screen): `listening.changed` is ignored.
 */
const INDEX_KEY = 'listening.index'
const DIRTY_KEY = 'listening.dirty'
const weekEntry = (week: string): string => `listening.w.${week}`
/** Heard seconds not yet saved, at most. */
const SAVE_EVERY_S = 30
const BATCH = 8
const PUSH_EVERY_MS = 60_000

interface CurrentSong {
  id: string
  listened: number
  counted: boolean
}

let started = false
let ledger: Ledger = {}
let loaded = false
let current: CurrentSong | null = null
let unsaved = 0
/** The weeks changed since the last save. */
const changed = new Set<string>()
let savedIndex = ''
/** The weeks the server has not acknowledged, and how many times each changed (to not clear one changed in flight). */
const dirty = new Set<string>()
const revisions = new Map<string, number>()
let connected = false
let pushing = false
let lastPush = 0
let pushTimer: ReturnType<typeof setTimeout> | null = null

const copy = (week: WeekLog): WeekLog => JSON.parse(JSON.stringify(week)) as WeekLog

function saveDirty(): void {
  storage.savePref(DIRTY_KEY, [...dirty]).catch(() => {})
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

  for (const [key, week] of Object.entries(updates)) {
    storage.savePref(weekEntry(key), week).catch(() => {})
    dirty.add(key)
    revisions.set(key, (revisions.get(key) ?? 0) + 1)
  }
  for (const key of removed) {
    storage.removePref(weekEntry(key)).catch(() => {})
    dirty.delete(key)
    revisions.delete(key)
  }
  if (Object.keys(updates).length > 0 || removed.length > 0) saveDirty()
  if (indexText !== savedIndex) {
    savedIndex = indexText
    storage.savePref(INDEX_KEY, index).catch(() => {})
  }
  scheduleSync()
}

async function loadSaved(): Promise<Ledger> {
  const index = await storage.loadPref<unknown>(INDEX_KEY).catch(() => null)
  const keys = Array.isArray(index) ? index.filter((key): key is string => typeof key === 'string') : []
  savedIndex = [...keys].sort().join(',')
  const weeks = await Promise.all(keys.map((key) => storage.loadPref<unknown>(weekEntry(key)).catch(() => null)))
  const savedDirty = await storage.loadPref<unknown>(DIRTY_KEY).catch(() => null)
  if (Array.isArray(savedDirty)) {
    for (const key of savedDirty) if (typeof key === 'string' && keys.includes(key)) dirty.add(key)
  }
  return sanitizeLedger(Object.fromEntries(keys.map((key, i) => [key, weeks[i]])))
}

/** Uploads the dirty weeks, 8 per message, one message at a time. */
async function syncNow(): Promise<void> {
  if (!connected || !loaded || pushing || dirty.size === 0) return
  pushing = true
  lastPush = Date.now()
  try {
    save() // what was heard since the last save goes out too
    while (connected && dirty.size > 0) {
      // A dirty week that is no longer in the ledger (pruned) has nothing to send.
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
        // A week that changed while it was in flight stays dirty and goes out next time.
        if ((revisions.get(key) ?? 0) === sent.get(key)) dirty.delete(key)
      }
      saveDirty()
      if (!progress) break // not acknowledged (connection lost, week refused): try again later
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

/** Saves now what was heard since the last save and sends it (the window is being hidden or closed). */
export function flushListening(): void {
  save()
  if (connected && dirty.size > 0) {
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = null
    void syncNow()
  }
}

export function startListeningLog(): void {
  if (started) return
  started = true

  loadSaved()
    .catch(() => ({}) as Ledger)
    .then((saved) => {
      // What was heard while it loaded goes on top of what was saved (those weeks are already marked changed).
      ledger = mergeLedgers(saved, ledger)
      loaded = true
      save()
      scheduleSync(true)
    })

  const onStatus = (status: { state: string }): void => {
    const was = connected
    connected = status.state === 'connected'
    // After a (re)connection: what is dirty goes out at once.
    if (connected && !was) scheduleSync(true)
  }
  window.api.hubServer.onStatus(onStatus)
  window.api.hubServer.status().then(onStatus).catch(() => {})

  window.addEventListener('beforeunload', flushListening)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushListening()
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
}
