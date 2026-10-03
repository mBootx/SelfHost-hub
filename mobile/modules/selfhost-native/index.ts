import type { ComponentType } from 'react'
import type { ViewProps } from 'react-native'
import { requireNativeView, requireOptionalNativeModule } from 'expo'
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
    (event: 'onWatchUpdateProgress', listener: (payload: { sent: number; total: number }) => void): { remove: () => void }
    (event: 'onHandFrame', listener: (payload: NativeHandFrame) => void): { remove: () => void }
    (event: 'onHandTrackerState', listener: (payload: HandTrackerState) => void): { remove: () => void }
    (event: 'onAmbientLight', listener: (payload: { lux: number }) => void): { remove: () => void }
  }
  /**
   * The dominant colour of the cover at url ("#rrggbb"), or null if it can't be had. Uses the same cover cache
   * as the Now Bar. Missing from older installed builds.
   */
  getCoverColor?(url: string): Promise<string | null>
  /**
   * A `side` by `side` copy of the cover at url, as r, g, b numbers one pixel after the other (the Now Playing screen's
   * palette is read from it), or null if it can't be had. Same cover cache as the Now Bar. Missing from older installed builds.
   */
  getCoverPixels?(url: string, side: number): Promise<number[] | null>
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
  /**
   * Sends the APK at `fileUri` to the watch `nodeId` over a data layer channel, after `header` (one line of JSON, see
   * services/watchUpdateProtocol.ts). Resolves once every byte was handed to the channel, rejects with a sentence when
   * the watch cannot be reached or closes the channel. Progress comes as onWatchUpdateProgress. Missing from builds before 2.5.2.
   */
  sendUpdateToWatch?(nodeId: string, fileUri: string, header: string): Promise<void>
  /** The camera permission (for the car mode's gestures), and asking for it. Missing from older installed builds. */
  getCameraPermission?(): Promise<PermissionAnswer>
  requestCameraPermission?(): Promise<PermissionAnswer>
  /**
   * Starts the front camera and MediaPipe's hand landmarker at about `fps` frames a second (or changes the rate of one
   * already running). False when it cannot start: no screen, or no permission. Frames come as onHandFrame, how the
   * tracker is doing as onHandTrackerState. Missing from older installed builds.
   */
  startHandTracking?(fps: number): boolean
  stopHandTracking?(): void
  /** What the car mode does around the screen (each false when there is no activity to change). */
  setKeepScreenOn?(on: boolean): boolean
  /** 0 to 1, or -1 for the phone's own brightness. */
  setScreenBrightness?(level: number): boolean
  setScreenOrientation?(mode: 'portrait' | 'landscape' | 'auto' | 'app'): boolean
  /** Screen awake, brightness and orientation back as they were before the car mode. */
  restoreCarScreen?(): boolean
  /** One step of the phone's media volume up (+1) or down (-1), with its volume panel; the volume after it (0 to 1), or -1. */
  stepMediaVolume?(direction: number): number
  /** The ambient light sensor, as onAmbientLight (lux, at most twice a second). False without a sensor. */
  startLightSensor?(): boolean
  stopLightSensor?(): void
}

/** An answer about a permission, as Expo modules give it. */
export interface PermissionAnswer {
  status: 'granted' | 'denied' | 'undetermined'
  granted: boolean
  canAskAgain: boolean
}

/** One hand in a camera frame: 21 points (x, y, z each; x and y from 0 to 1 across the mirrored, upright picture). */
export interface NativeHand {
  score: number
  side: string
  points: number[]
}

export interface NativeHandFrame {
  /** Milliseconds since the phone started (only goes forward). */
  t: number
  /** How long the landmarker took with the frame, in milliseconds. */
  ms: number
  width: number
  height: number
  hands: NativeHand[]
}

export interface HandTrackerState {
  state: 'running' | 'stopped' | 'error'
  error: string | null
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
const native = requireOptionalNativeModule<SelfHostNative>('SelfHostNative')
export default native

/**
 * What the front camera sees, for the car mode's test mode (HandCameraPreview.kt); null in a build without it. While it
 * is on screen the hand tracker feeds it too.
 */
export const HandCameraPreview: ComponentType<ViewProps> | null =
  native && typeof native.startHandTracking === 'function' ? requireNativeView<ViewProps>('SelfHostNative') : null
