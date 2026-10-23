import { useEffect } from 'react'
import { engine, ensureAudioMode, onRemoteCommand, type NowPlayingInfo } from '@/services/playbackEngine'
import { loudnessFactor } from '@/services/loudness'
import { useSleepTimerStore } from '@/services/sleepTimer'
import { resumePosition } from '@/services/playbackMemory'
import type { NavidromeClient, NDSong } from '@/services/navidrome'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useOfflineStore } from '@/store/offlineStore'
import { useArtworkStore } from '@/store/artworkStore'
import { useHistoryStore } from '@/store/historyStore'
import { useAudioSettingsStore } from '@/store/audioSettingsStore'
import { noteStall, useNetworkStore } from '@/services/offlineMode'
import { streamBitrate } from '@/services/offlinePriority'
import SelfHostNative from '../../modules/selfhost-native'

/** The picture the lock screen and Now Bar show for a song: its Navidrome cover, else one the user picked. */
function lockScreenArtwork(song: NDSong, client: NavidromeClient, override?: string): string | undefined {
  return song.coverArt || song.albumId ? client.coverArtUrl(song.coverArt || song.albumId || song.id, 512) : override
}

/** What the lock screen and Now Bar show for a song. */
function nowPlayingInfo(song: NDSong, client: NavidromeClient, override?: string): NowPlayingInfo {
  return { title: song.title, artist: song.artist, album: song.album, artworkUrl: lockScreenArtwork(song, client, override) }
}

/**
 * Invisible component that wires the Zustand player state to the audio engine (services/playbackEngine).
 * Rendered once at the root layout so it - and therefore playback - survives navigating between screens.
 *
 * Lock screen / Now Bar integration: the engine shows each track there as it becomes current (it is handed each
 * track's details below). Play/pause, seek and - thanks to the native patch in patches/expo-audio - next/previous
 * taps there come back as remote commands.
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
  const normalize = useAudioSettingsStore((s) => s.normalize)
  const eqEnabled = useAudioSettingsStore((s) => s.eqEnabled)
  const eqPreset = useAudioSettingsStore((s) => s.eqPreset)
  const eqCustomGains = useAudioSettingsStore((s) => s.eqCustomGains)
  const eqBands = useAudioSettingsStore((s) => s.eqBands)
  const reduceWhenSlow = useAudioSettingsStore((s) => s.reduceWhenSlow)
  const networkQuality = useNetworkStore((s) => s.quality)
  // A slow network gets a lighter stream; the songs on the phone are played from the phone whatever the network.
  const bitrate = streamBitrate(networkQuality, reduceWhenSlow)
  const setEqBands = useAudioSettingsStore((s) => s.setEqBands)

  const song = queue[queueIndex] || null
  // What follows the current track when it ends on its own - the same rules as the store's next().
  const nextSong = repeatMode === 'one' ? null : (queue[queueIndex + 1] ?? (repeatMode === 'all' ? queue[0] : null))
  // How much each track is turned down to even out the volume (1 when the setting is off or it has no tags).
  const gain = loudnessFactor(song, normalize)
  const nextGain = loudnessFactor(nextSong, normalize)
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
          return
        }
        const ended = state.queue[state.queueIndex]
        state.next()
        // The same song twice in a row (queued again): nothing changes for the effects below, so nothing would
        // load it. It starts again from the top.
        const after = useNavidromeStore.getState()
        if (ended && after.isPlaying && after.queueIndex !== state.queueIndex && after.queue[after.queueIndex]?.id === ended.id) {
          engine.restart()
        }
      },
      onAutoAdvance: () => useNavidromeStore.getState().next(),
      onExternalPlayState: (playing) => useNavidromeStore.setState({ isPlaying: playing }),
      onStopAfterTrack: () => {
        useSleepTimerStore.getState().finished()
        useNavidromeStore.getState().stopAtTrackEnd()
      },
      // Only a streamed song waiting for data says something about the network.
      onBuffering: (buffering) => {
        const state = useNavidromeStore.getState()
        const current = state.queue[state.queueIndex]
        if (!buffering || (current && !useOfflineStore.getState().isOffline(current.id))) noteStall(buffering)
      }
    })
    SelfHostNative?.getEqualizerBands(engine.decks[0])
      .then(setEqBands)
      .catch(() => setEqBands(null))
    return () => engine.setHandlers(null)
  }, [])

  // Presses from the lock screen / Now Bar / headset arrive here. The queue lives in the store, so a skip drives the
  // same actions as the in-app buttons; play and pause already acted on the player and the engine takes them as
  // the person's choice.
  useEffect(
    () =>
      onRemoteCommand((command) => {
        if (command === 'next') next()
        else if (command === 'previous') prev()
        else engine.remotePlayState(command === 'play')
      }),
    [next, prev]
  )

  // Also re-run when the client first appears: a queue restored from the last session is in place
  // before Navidrome has reconnected.
  useEffect(() => {
    if (!song) return
    const localUri = getOfflineUri(song.id)
    if (!localUri && !client) return
    // A track restored from the last session picks up where it stopped. It was recorded in the
    // history when it first played, so it isn't recorded again.
    const resumeAt = resumePosition(song.id)
    const source = localUri || client!.streamUrl(song.id, bitrate)
    const info: NowPlayingInfo = client
      ? nowPlayingInfo(song, client, artworkOverride)
      : { title: song.title, artist: song.artist, album: song.album, artworkUrl: artworkOverride }
    engine.load(song.id, source, useNavidromeStore.getState().isPlaying, resumeAt ?? 0, gain, info)
    if (resumeAt === null) recordHistory(song)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.id, !!client])

  // The next track comes with what the Now Bar shows for it: when a crossfade or a gapless hop starts it, the engine
  // puts it there in the same step, with no wait for the queue to catch up.
  const nextOverride = useArtworkStore((s) => {
    const key = nextSong?.albumId || nextSong?.id
    return key ? s.overrides[key] : undefined
  })
  useEffect(() => {
    if (!client) return
    engine.setNext(
      nextSong
        ? {
            id: nextSong.id,
            source: getOfflineUri(nextSong.id) || client.streamUrl(nextSong.id, bitrate),
            gain: nextGain,
            info: nowPlayingInfo(nextSong, client, nextOverride)
          }
        : null
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextSong, client, nextGain, bitrate, nextOverride])

  // The setting was switched while this track plays: it is turned down (or back up) at once.
  useEffect(() => {
    engine.setGain(gain)
  }, [gain, song?.id])

  // Kept separate from the track-load effect above: artworkOverride resolves asynchronously (a
  // user-triggered search that can finish after playback started), and re-running this must only
  // refresh the Now Bar's details, never reload the track. The engine has already put the track on the
  // Now Bar when it became current; this only sends what changed since (it sends nothing if nothing did).
  useEffect(() => {
    if (!song || !client) return
    engine.setNowPlaying(song.id, nowPlayingInfo(song, client, artworkOverride))
  }, [song, client, artworkOverride])

  // The next track's cover is downloaded ahead of time, so skipping to it shows its picture on the
  // Now Bar straight away rather than after a download.
  const nextArtwork = client && nextSong ? lockScreenArtwork(nextSong, client) : undefined
  useEffect(() => {
    if (nextArtwork) SelfHostNative?.prefetchArtwork?.(nextArtwork)
  }, [nextArtwork])

  // The home-screen widget shows the same song, and whether it is playing.
  useEffect(() => {
    if (!SelfHostNative?.updateWidget) return
    if (!song || !client) {
      SelfHostNative.updateWidget('', '', '', false)
      return
    }
    SelfHostNative.updateWidget(song.title, song.artist, lockScreenArtwork(song, client, artworkOverride) ?? '', isPlaying)
  }, [song, client, artworkOverride, isPlaying])

  // Nothing left to play (queue cleared, signed out): the Now Bar goes too, instead of showing the last song.
  useEffect(() => {
    if (!song) engine.clearNowPlaying()
  }, [song])

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
