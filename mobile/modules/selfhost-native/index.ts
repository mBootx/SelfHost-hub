import { requireOptionalNativeModule } from 'expo'
import type { AudioPlayer } from 'expo-audio'

export interface EqualizerBands {
  /** Centre frequency of each band the device offers, in Hz. */
  frequencies: number[]
  minDb: number
  maxDb: number
}

/** A file another app sent through the share sheet, already copied into the app's cache. */
export interface SharedFile {
  uri: string
  name: string
  size: number
  mime: string | null
}

export interface SharedContent {
  files: SharedFile[]
  /** Text sent along (or on its own: a link shared from the browser). */
  text: string | null
  /** Files that could not be read or went past the limit. */
  unreadable: number
}

export interface WakeResult {
  ok: boolean
  error?: string
}

interface SelfHostNative {
  getEqualizerBands(player: AudioPlayer): Promise<EqualizerBands | null>
  setEqualizer(player: AudioPlayer, enabled: boolean, gainsDb: number[]): Promise<boolean>
  /** Wake-on-LAN magic packet, broadcast on the local network. Missing from builds before 2.2.0. */
  sendWakeOnLan?(mac: string, broadcast: string): Promise<WakeResult>
  /** Downloads a cover ahead of time for the lock screen / Now Bar. Missing from older installed builds. */
  prefetchArtwork?(url: string): void
  /**
   * Crossfades two players on the main thread, so it keeps going with the app off screen (JS timers don't).
   * Ramps incoming up to its own level and outgoing down from its own level to silence over durationMs, then pauses outgoing.
   * Returns true once started. Missing from older installed builds.
   */
  startCrossfade?(outgoing: AudioPlayer, incoming: AudioPlayer, durationMs: number, outgoingLevel: number, incomingLevel: number): boolean
  /** Stops a crossfade where it is, leaving the volumes as they are. */
  cancelCrossfade?(): void
  /**
   * Hides the app from the recents screen (and, before Android 13, from screenshots) while the app lock is on.
   * Returns false when there is no activity to apply it to. Missing from older installed builds.
   */
  setPrivacyScreen?(enabled: boolean): boolean
  /** Milliseconds since the phone started (unaffected by date changes) and the phone's boot count. Missing from older builds. */
  getClock?(): { elapsed: number; boot: number }
  /** Whether the phone is plugged in. Missing from older installed builds. */
  isCharging?(): boolean
  /**
   * What other apps sent here through the share sheet, copied into the cache; null when there is nothing.
   * Reading it empties it. Missing from older installed builds.
   */
  consumeSharedContent?(): Promise<SharedContent | null>
  /** Deletes the copies made for shares. Missing from older installed builds. */
  clearSharedContent?(): void
  /**
   * Fades out and pauses whatever is playing in `durationMs` (the last `fadeMs` of it are the fade), on the main
   * thread's clock so it still happens with the screen off. Replaces a timer already running; returns true once
   * started. Missing from older installed builds.
   */
  startSleepTimer?(first: AudioPlayer, second: AudioPlayer, durationMs: number, fadeMs: number): boolean
  /** Cancels the sleep timer; a fade already under way is undone. */
  cancelSleepTimer?(): void
  /**
   * Shows a song on the home-screen widget; an empty title means nothing is playing. Returns false when there is no
   * context to draw it with. Missing from older installed builds.
   */
  updateWidget?(title: string, artist: string, coverUrl: string, playing: boolean): boolean
  /**
   * Told when a share arrives while the app is running, when the sleep timer has finished, and when a button of the
   * home-screen widget is pressed ('toggle', 'next' or 'previous'). Missing from older installed builds.
   */
  addListener?: {
    (event: 'onShareReceived' | 'onSleepTimerEnded', listener: () => void): { remove: () => void }
    (event: 'onWidgetAction', listener: (payload: { action: string }) => void): { remove: () => void }
    (event: 'onWatchMessage', listener: (payload: WatchMessage) => void): { remove: () => void }
  }
  /**
   * The dominant colour of the cover at url ("#rrggbb"), or null if it can't be had. Uses the same cover cache
   * as the Now Bar. Missing from older installed builds.
   */
  getCoverColor?(url: string): Promise<string | null>
  /** The Wear OS watches connected to this phone, and whether each has the SelfHost Hub watch app. Missing from older installed builds. */
  getWatches?(): Promise<WatchInfo[]>
  /**
   * Hands the watch app its setup (the JSON built by services/watchSync.ts). Resolves with one outcome per watch that has
   * the app, once each has answered or after ten seconds; an empty list means no watch has the app.
   */
  sendSetupToWatch?(setupJson: string): Promise<WatchOutcome[]>
  /**
   * Sends one message of the live link (a snapshot of the players, see services/watchLink.ts) to every watch that has the
   * app. Resolves with how many watches it went to (0: none is connected). Missing from older installed builds.
   */
  sendToWatch?(path: string, json: string): Promise<number>
}

/** What the watch sent over the data layer: a request for the state, or a command (`data` is the JSON text). */
export interface WatchMessage {
  nodeId: string
  path: string
  data: string
}

export interface WatchInfo {
  id: string
  name: string
  /** In Bluetooth range right now. */
  nearby: boolean
  /** The watch app is installed on it. */
  hasApp: boolean
}

export interface WatchOutcome {
  id: string
  name: string
  ok: boolean
  error: string | null
}

/** Null when the native side isn't linked (Expo Go, web), so callers can hide the feature instead of crashing. */
export default requireOptionalNativeModule<SelfHostNative>('SelfHostNative')
