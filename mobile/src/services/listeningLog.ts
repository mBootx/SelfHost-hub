import { AppState } from 'react-native'
import { create } from 'zustand'
import { countsAsPlay, MAX_TICK_S } from '@/services/scrobbler'
import { storage } from '@/services/storage'
import { addListening, addPlay, Ledger, mergeLedgers, prune, sanitizeLedger, weekKey, WeekLog } from '@/services/wrapped'
import { useNavidromeStore } from '@/store/navidromeStore'

/**
 * Writes down what is listened to on this phone, week by week, for the weekly Wrapped (services/wrapped.ts). The
 * time is what was actually heard: the player's progress while it plays, without pauses or seeks, the same ticks the
 * scrobbler counts. It stays on this phone (Navidrome keeps no history of plays to read back).
 *
 * Saved after every 30 seconds heard and at each change of song, not on a timer: timers don't run with the screen
 * off, the player's progress does. Each week is its own entry (and a list of them), and only the weeks that changed
 * are written: half a year of weeks in one entry could pass the size Android's storage can read back.
 */
const INDEX_KEY = 'listening.weeks'
const weekEntry = (week: string): string => `listening.week.${week}`
/** Heard seconds not yet saved, at most: what an app killed in the background can lose. */
const SAVE_EVERY_S = 30

interface ListeningState {
  /** The weeks as last saved: what the Wrapped and Settings show (the current week lags by up to 30 s). */
  weeks: Ledger
  loaded: boolean
}

export const useListeningStore = create<ListeningState>(() => ({ weeks: {}, loaded: false }))

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
/** The list of weeks as last saved. */
let savedIndex = ''

const copy = (week: WeekLog): WeekLog => JSON.parse(JSON.stringify(week)) as WeekLog

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

  useListeningStore.setState((s) => {
    const weeks = { ...s.weeks, ...updates }
    for (const key of removed) delete weeks[key]
    return { weeks }
  })
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

async function loadSaved(): Promise<Ledger> {
  const index = await storage.loadPref<unknown>(INDEX_KEY).catch(() => null)
  const keys = Array.isArray(index) ? index.filter((key): key is string => typeof key === 'string') : []
  savedIndex = [...keys].sort().join(',')
  const weeks = await Promise.all(keys.map((key) => storage.loadPref<unknown>(weekEntry(key)).catch(() => null)))
  return sanitizeLedger(Object.fromEntries(keys.map((key, i) => [key, weeks[i]])))
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
      useListeningStore.setState({ weeks: Object.fromEntries(Object.entries(ledger).map(([key, week]) => [key, copy(week)])), loaded: true })
      save()
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
