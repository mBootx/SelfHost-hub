import { AppState } from 'react-native'
import { create } from 'zustand'
import { storage } from '@/services/storage'
import { flushListening, useListeningStore } from '@/services/listeningLog'
import { dueWeek, latestWeek } from '@/services/wrapped'

const SHOWN_KEY = 'wrapped.lastShown'
/** How often an open app looks whether it is Monday 10:00 yet. */
const CHECK_EVERY_MS = 60_000

interface WrappedState {
  /** The week on screen (its Monday, yyyy-mm-dd), or null when the Wrapped is closed. */
  week: string | null
  /** The week whose Wrapped was last shown by itself (or seen while it was due). */
  lastShown: string | null
  /** The week that was due when it opened: it counts as seen once closed. */
  dueOnOpen: string | null
  ready: boolean
  /** Opens it by itself when it is due: from Monday 10:00, for the week just ended, once. */
  check: () => void
  /** Opens it from Settings, on the last week that ended (or the one under way if that one is empty). */
  open: () => void
  /** Goes to another week. */
  show: (week: string) => void
  close: () => void
}

export const useWrappedStore = create<WrappedState>((set, get) => ({
  week: null,
  lastShown: null,
  dueOnOpen: null,
  ready: false,

  check: () => {
    const { ready, week, lastShown } = get()
    if (!ready || week || !useListeningStore.getState().loaded) return
    flushListening()
    const due = dueWeek(useListeningStore.getState().weeks, Date.now(), lastShown)
    if (due) set({ week: due, dueOnOpen: due })
  },

  open: () => {
    flushListening()
    const weeks = useListeningStore.getState().weeks
    const now = Date.now()
    set({ week: latestWeek(weeks, now), dueOnOpen: dueWeek(weeks, now, get().lastShown) })
  },

  show: (week) => set({ week }),

  close: () => {
    const { dueOnOpen, lastShown } = get()
    if (dueOnOpen && (!lastShown || dueOnOpen > lastShown)) {
      storage.savePref(SHOWN_KEY, dueOnOpen).catch(() => {})
      set({ lastShown: dueOnOpen })
    }
    set({ week: null, dueOnOpen: null })
  }
}))

let started = false

/**
 * Pops the Wrapped up when it is due: looked at once the listening is loaded, whenever the app comes back to the
 * front, and every minute while it is open (Monday 10:00 can come while it is on screen).
 */
export function startWrappedSchedule(): void {
  if (started) return
  started = true
  storage
    .loadPref<string>(SHOWN_KEY)
    .catch(() => null)
    .then((lastShown) => {
      useWrappedStore.setState({ lastShown: typeof lastShown === 'string' ? lastShown : null, ready: true })
      useWrappedStore.getState().check()
    })
  useListeningStore.subscribe((s, prev) => {
    if (s.loaded && !prev.loaded) useWrappedStore.getState().check()
  })
  AppState.addEventListener('change', (next) => {
    if (next === 'active') useWrappedStore.getState().check()
  })
  setInterval(() => {
    if (AppState.currentState === 'active') useWrappedStore.getState().check()
  }, CHECK_EVERY_MS)
}
