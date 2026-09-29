import { AudioEngine } from './audioEngine'

let engine: AudioEngine | null = null

/** One engine for the whole app session: playback must outlive whichever screen is showing. */
export function getAudioEngine(): AudioEngine {
  if (!engine) engine = new AudioEngine()
  return engine
}

export function seekTo(seconds: number): void {
  getAudioEngine().seek(seconds)
}
