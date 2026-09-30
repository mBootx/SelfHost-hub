import { requireOptionalNativeModule } from 'expo'
import type { AudioPlayer } from 'expo-audio'

export interface EqualizerBands {
  /** Centre frequency of each band the device offers, in Hz. */
  frequencies: number[]
  minDb: number
  maxDb: number
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
   * Ramps incoming up to volume and outgoing down to silence over durationMs, then pauses outgoing.
   * Returns true once started. Missing from older installed builds.
   */
  startCrossfade?(outgoing: AudioPlayer, incoming: AudioPlayer, durationMs: number, volume: number): boolean
  /** Stops a crossfade where it is, leaving the volumes as they are. */
  cancelCrossfade?(): void
  /**
   * The dominant colour of the cover at url ("#rrggbb"), or null if it can't be had. Uses the same cover cache
   * as the Now Bar. Missing from older installed builds.
   */
  getCoverColor?(url: string): Promise<string | null>
}

/** Null when the native side isn't linked (Expo Go, web), so callers can hide the feature instead of crashing. */
export default requireOptionalNativeModule<SelfHostNative>('SelfHostNative')
