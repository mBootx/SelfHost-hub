import { AppState } from 'react-native'
import { create } from 'zustand'
import { storage } from '@/services/storage'
import { flushListening, useListeningStore } from '@/services/listeningLog'
import { dueWeek, latestWeek, periodOf, type Period } from '@/services/wrapped'

const SHOWN_KEY = 'wrapped.lastShown'
/** How often an open app looks whether it is Monday 10:00 yet. */
const CHECK_EVERY_MS = 60_000

interface WrappedState {
  /** The period on screen, or null when the Wrapped is closed. */
  period: Period | null
  /** The periods a bar of the chart was tapped in, the last one on top: "back" returns to it. */
  trail: Period[]
  /** The week on screen (its Monday, yyyy-mm-dd) when a week is shown, else null. */
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
  /** Goes to another period (a tab, the arrows, a picked span): the way back is forgotten. */
  showPeriod: (period: Period) => void
  /** Opens a bar of the chart (a day of the week, a month of the year); back returns here. */
  drill: (period: Period) => void
  back: () => void
  close: () => void
}

const onScreen = (period: Period | null): Pick<WrappedState, 'period' | 'week'> => ({ period, week: period?.kind === 'week' ? period.start : null })

export const useWrappedStore = create<WrappedState>((set, get) => ({
  period: null,
  trail: [],
  week: null,
  lastShown: null,
  dueOnOpen: null,
  ready: false,

  check: () => {
    const { ready, period, lastShown } = get()
    if (!ready || period || !useListeningStore.getState().loaded) return
    flushListening()
    const due = dueWeek(useListeningStore.getState().weeks, Date.now(), lastShown)
    if (due) set({ ...onScreen(periodOf('week', due)), trail: [], dueOnOpen: due })
  },

  open: () => {
    flushListening()
    const weeks = useListeningStore.getState().weeks
    const now = Date.now()
    set({ ...onScreen(periodOf('week', latestWeek(weeks, now))), trail: [], dueOnOpen: dueWeek(weeks, now, get().lastShown) })
  },

  show: (week) => set({ ...onScreen(periodOf('week', week)), trail: [] }),

  showPeriod: (period) => {
    flushListening()
    set({ ...onScreen(period), trail: [] })
  },

  drill: (period) => {
    const current = get().period
    set({ ...onScreen(period), trail: current ? [...get().trail, current] : [] })
  },

  back: () => {
    const trail = get().trail
    if (trail.length === 0) return
    set({ ...onScreen(trail[trail.length - 1]), trail: trail.slice(0, -1) })
  },

  close: () => {
    const { dueOnOpen, lastShown } = get()
    if (dueOnOpen && (!lastShown || dueOnOpen > lastShown)) {
      storage.savePref(SHOWN_KEY, dueOnOpen).catch(() => {})
      set({ lastShown: dueOnOpen })
    }
    set({ ...onScreen(null), trail: [], dueOnOpen: null })
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
