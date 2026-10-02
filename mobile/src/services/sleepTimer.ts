import { AppState } from 'react-native'
import { create } from 'zustand'
import SelfHostNative from '../../modules/selfhost-native'
import { logEvent } from '@/services/diagnostics'
import { engine } from '@/services/playbackEngine'
import { useNavidromeStore } from '@/store/navidromeStore'

/** Choices offered, in minutes. "At the end of this track" is the other one. */
export const SLEEP_PRESETS_MINUTES = [15, 30, 45, 60, 90]

/** The music fades out over this long before it stops. */
export const SLEEP_FADE_MS = 10_000

export type SleepMode = 'off' | 'timer' | 'track'

interface SleepState {
  mode: SleepMode
  /** When a timer stops the music (ms since the epoch). */
  endsAt: number | null
  /** Stops the music in `minutes`, fading out at the end. Replaces any timer or "after this track" set before. */
  startTimer: (minutes: number) => void
  /** Stops the music when the track playing now ends. */
  stopAfterTrack: () => void
  cancel: () => void
  /** The timer did its job, or the track ended: back to off, without touching playback. */
  finished: () => void
}

let fallback: ReturnType<typeof setTimeout> | null = null

function clearFallback(): void {
  if (fallback) clearTimeout(fallback)
  fallback = null
}

/** What is left on a timer, "1 h 05" / "23 min" / "moins d'une minute". */
export function describeRemaining(ms: number): string {
  const minutes = Math.ceil(ms / 60_000)
  if (minutes <= 0) return "moins d'une minute"
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${String(minutes % 60).padStart(2, '0')}`
}

export const useSleepTimerStore = create<SleepState>((set, get) => ({
  mode: 'off',
  endsAt: null,

  startTimer: (minutes) => {
    get().cancel()
    const durationMs = Math.max(1, Math.round(minutes * 60_000))
    let native = false
    try {
      native = SelfHostNative?.startSleepTimer?.(engine.decks[0], engine.decks[1], durationMs, Math.min(SLEEP_FADE_MS, durationMs)) === true
    } catch {
      native = false
    }
    if (!native) {
      // A build without the native timer: this one stops with the screen off, but is better than none.
      fallback = setTimeout(() => {
        useNavidromeStore.setState({ isPlaying: false })
        get().finished()
      }, durationMs)
    }
    set({ mode: 'timer', endsAt: Date.now() + durationMs })
    logEvent('music', `Minuterie de sommeil : ${minutes} min`)
  },

  stopAfterTrack: () => {
    get().cancel()
    engine.setStopAfterTrack(true)
    set({ mode: 'track', endsAt: null })
    logEvent('music', 'Minuterie de sommeil : à la fin du titre')
  },

  cancel: () => {
    clearFallback()
    try {
      SelfHostNative?.cancelSleepTimer?.()
    } catch {
      // nothing running
    }
    engine.setStopAfterTrack(false)
    if (get().mode !== 'off') set({ mode: 'off', endsAt: null })
  },

  finished: () => {
    clearFallback()
    if (get().mode !== 'off') set({ mode: 'off', endsAt: null })
  }
}))

let started = false

/** At app start: hears the native timer finish, and notices on return that one has run out while the app was away. */
export function initSleepTimer(): void {
  if (started) return
  started = true
  try {
    SelfHostNative?.addListener?.('onSleepTimerEnded', () => {
      logEvent('music', 'Minuterie de sommeil terminée : lecture arrêtée')
      useSleepTimerStore.getState().finished()
    })
  } catch {
    // an older build without the event: the check on return below still clears the display
  }
  AppState.addEventListener('change', (next) => {
    if (next !== 'active') return
    const { mode, endsAt, finished } = useSleepTimerStore.getState()
    if (mode === 'timer' && endsAt !== null && Date.now() > endsAt + 1000) finished()
  })
}
