import { useEffect } from 'react'
import { engine, ensureAudioMode, onRemoteCommand } from '@/services/playbackEngine'
import { resumePosition } from '@/services/playbackMemory'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useOfflineStore } from '@/store/offlineStore'
import { useArtworkStore } from '@/store/artworkStore'
import { useHistoryStore } from '@/store/historyStore'
import { useAudioSettingsStore } from '@/store/audioSettingsStore'
import SelfHostNative from '../../modules/selfhost-native'

/**
 * Invisible component that wires the Zustand player state to the audio engine (services/playbackEngine).
 * Rendered once at the root layout so it - and therefore playback - survives navigating between screens.
 *
 * Lock screen / Now Bar integration (setActiveForLockScreen) displays metadata and handles play/pause,
 * seek, and - thanks to the native patch in patches/expo-audio - next/previous track taps too.
 */
export default function PlaybackController(): null {
  const client = useNavidromeStore((s) => s.client)
  const queue = useNavidromeStore((s) => s.queue)
  const queueIndex = useNavidromeStore((s) => s.queueIndex)
  const isPlaying = useNavidromeStore((s) => s.isPlaying)
  const volume = useNavidromeStore((s) => s.volume)
  const playbackRate = useNavidromeStore((s) => s.playbackRate)
  const repeatMode = useNavidromeStore((s) => s.repeatMode)
  const next = useNavidromeStore((s) => s.next)
  const prev = useNavidromeStore((s) => s.prev)
  const recordHistory = useHistoryStore((s) => s.record)
  const getOfflineUri = useOfflineStore((s) => s.getLocalUri)

  const crossfadeSeconds = useAudioSettingsStore((s) => s.crossfadeSeconds)
  const gapless = useAudioSettingsStore((s) => s.gapless)
  const eqEnabled = useAudioSettingsStore((s) => s.eqEnabled)
  const eqPreset = useAudioSettingsStore((s) => s.eqPreset)
  const eqCustomGains = useAudioSettingsStore((s) => s.eqCustomGains)
  const eqBands = useAudioSettingsStore((s) => s.eqBands)
  const setEqBands = useAudioSettingsStore((s) => s.setEqBands)

  const song = queue[queueIndex] || null
  // What follows the current track when it ends on its own - the same rules as the store's next().
  const nextSong = repeatMode === 'one' ? null : (queue[queueIndex + 1] ?? (repeatMode === 'all' ? queue[0] : null))
  const artworkOverride = useArtworkStore((s) => {
    const key = song?.albumId || song?.id
    return key ? s.overrides[key] : undefined
  })

  useEffect(() => {
    ensureAudioMode()
    engine.setHandlers({
      onProgress: (currentTime, duration) => useNavidromeStore.getState().setProgress(currentTime, duration),
      onTrackEnd: () => {
        const state = useNavidromeStore.getState()
        // A one-song queue on repeat-all "advances" to the same index, which reloads nothing.
        if (state.repeatMode === 'one' || (state.repeatMode === 'all' && state.queue.length === 1)) {
          useNavidromeStore.setState({ isPlaying: true })
          engine.restart()
        } else {
          state.next()
        }
      },
      onAutoAdvance: () => useNavidromeStore.getState().next(),
      onExternalPlayState: (playing) => useNavidromeStore.setState({ isPlaying: playing })
    })
    SelfHostNative?.getEqualizerBands(engine.decks[0])
      .then(setEqBands)
      .catch(() => setEqBands(null))
    return () => engine.setHandlers(null)
  }, [])

  // Skip presses from the lock screen / Now Bar / headset arrive here; the queue
  // itself lives in the store, so they drive the same actions as the in-app buttons.
  useEffect(() => onRemoteCommand((command) => (command === 'next' ? next() : prev())), [next, prev])

  // Also re-run when the client first appears: a queue restored from the last session is in place
  // before Navidrome has reconnected.
  useEffect(() => {
    if (!song || !client) return
    // A track restored from the last session picks up where it stopped. It was recorded in the
    // history when it first played, so it isn't recorded again.
    const resumeAt = resumePosition(song.id)
    engine.load(song.id, getOfflineUri(song.id) || client.streamUrl(song.id), useNavidromeStore.getState().isPlaying, resumeAt ?? 0)
    if (resumeAt === null) recordHistory(song)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.id, !!client])

  useEffect(() => {
    if (!client) return
    engine.setNext(nextSong ? { id: nextSong.id, source: getOfflineUri(nextSong.id) || client.streamUrl(nextSong.id) } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextSong?.id, client])

  // Kept separate from the track-load effect above: artworkOverride resolves asynchronously (a
  // user-triggered search that can finish after playback started), and re-running this must only
  // refresh the Now Bar's metadata, never reload the track. After a crossfade or gapless handoff the
  // new track plays on the other deck, which becomes the lock screen's player here.
  useEffect(() => {
    if (!song || !client) return
    // Stock expo-audio strips COMMAND_SEEK_TO_NEXT/PREVIOUS from its MediaSession,
    // which hides skip controls on every external surface. Our patch puts them
    // back (see patches/expo-audio), so prev/play/next occupy the main slots and
    // these +/-10s buttons sit in the notification overflow.
    engine.activePlayer.setActiveForLockScreen(
      true,
      {
        title: song.title,
        artist: song.artist,
        albumTitle: song.album,
        artworkUrl:
          song.coverArt || song.albumId
            ? client.coverArtUrl(song.coverArt || song.albumId || song.id, 512)
            : artworkOverride
      },
      { showSeekForward: true, showSeekBackward: true }
    )
  }, [song, client, artworkOverride])

  useEffect(() => {
    if (isPlaying) engine.play()
    else engine.pause()
  }, [isPlaying])

  useEffect(() => {
    engine.setVolume(volume)
  }, [volume])

  useEffect(() => {
    engine.setRate(playbackRate)
  }, [playbackRate])

  useEffect(() => {
    engine.setTransitions(crossfadeSeconds, gapless)
  }, [crossfadeSeconds, gapless])

  useEffect(() => {
    if (!SelfHostNative || !eqBands) return
    const gains = useAudioSettingsStore.getState().deviceGains()
    for (const deck of engine.decks) SelfHostNative.setEqualizer(deck, eqEnabled, gains).catch(() => {})
  }, [eqEnabled, eqPreset, eqCustomGains, eqBands])

  return null
}
