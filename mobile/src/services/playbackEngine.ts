import { createAudioPlayer, setAudioModeAsync, AudioPlayer } from 'expo-audio'

/**
 * A single module-scope player, not tied to any component's lifecycle, so
 * playback survives navigation between screens (mini player -> now playing
 * -> back to library) and stays alive for the whole app session.
 */
/**
 * 250ms instead of the 500ms default: the progress bar is smoother and, more to
 * the point, the synced lyrics land close enough to the beat to feel live.
 */
export const audioPlayer: AudioPlayer = createAudioPlayer(null, { updateInterval: 250 })

/** Skip presses coming from outside the app: Now Bar, notification, headset, Android Auto. */
export type RemoteCommand = 'next' | 'previous'

/**
 * Subscribes to the lock screen skip events. This event is added by our patch to
 * expo-audio (patches/expo-audio+57.0.5.patch) - stock expo-audio strips the
 * next/previous commands from its MediaSession entirely - so it isn't in the
 * library's public typings and has to be attached through the emitter directly.
 */
export function onRemoteCommand(handler: (command: RemoteCommand) => void): () => void {
  const emitter = audioPlayer as unknown as {
    addListener(event: string, listener: (payload: { command: RemoteCommand }) => void): { remove(): void }
  }
  const subscription = emitter.addListener('remoteCommand', (payload) => {
    if (payload?.command === 'next' || payload?.command === 'previous') handler(payload.command)
  })
  return () => subscription.remove()
}

let configured = false

export async function ensureAudioMode(): Promise<void> {
  if (configured) return
  configured = true
  await setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    // Lock screen controls require 'doNotMix' - see expo-audio docs.
    interruptionMode: 'doNotMix'
  })
}
