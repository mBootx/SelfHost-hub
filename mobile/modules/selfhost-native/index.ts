import { requireOptionalNativeModule } from 'expo'
import type { AudioPlayer } from 'expo-audio'

export interface EqualizerBands {
  /** Centre frequency of each band the device offers, in Hz. */
  frequencies: number[]
  minDb: number
  maxDb: number
}

interface SelfHostNative {
  getEqualizerBands(player: AudioPlayer): Promise<EqualizerBands | null>
  setEqualizer(player: AudioPlayer, enabled: boolean, gainsDb: number[]): Promise<boolean>
}

/** Null when the native side isn't linked (Expo Go, web), so callers can hide the feature instead of crashing. */
export default requireOptionalNativeModule<SelfHostNative>('SelfHostNative')
