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
}

/** Null when the native side isn't linked (Expo Go, web), so callers can hide the feature instead of crashing. */
export default requireOptionalNativeModule<SelfHostNative>('SelfHostNative')
