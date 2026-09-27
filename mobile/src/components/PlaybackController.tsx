import { useEffect, useRef } from 'react'
import { useAudioPlayerStatus } from 'expo-audio'
import { audioPlayer, ensureAudioMode, onRemoteCommand } from '@/services/playbackEngine'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useOfflineStore } from '@/store/offlineStore'
import { useArtworkStore } from '@/store/artworkStore'
import { useHistoryStore } from '@/store/historyStore'

/**
 * Invisible component that wires the Zustand player state to the singleton
 * expo-audio player. Rendered once at the root layout so it - and therefore
 * playback - survives navigating between screens.
 *
 * Lock screen / Now Bar integration (setActiveForLockScreen) displays metadata
 * and handles play/pause, seek, and - thanks to the native patch in
 * patches/expo-audio - next/previous track taps too (see onRemoteCommand below).
 */
export default function PlaybackController(): null {
  const client = useNavidromeStore((s) => s.client)
  const queue = useNavidromeStore((s) => s.queue)
  const queueIndex = useNavidromeStore((s) => s.queueIndex)
  const isPlaying = useNavidromeStore((s) => s.isPlaying)
  const volume = useNavidromeStore((s) => s.volume)
  const playbackRate = useNavidromeStore((s) => s.playbackRate)
  const repeatMode = useNavidromeStore((s) => s.repeatMode)
  const setProgress = useNavidromeStore((s) => s.setProgress)
  const next = useNavidromeStore((s) => s.next)
  const prev = useNavidromeStore((s) => s.prev)
  const recordHistory = useHistoryStore((s) => s.record)

  const getOfflineUri = useOfflineStore((s) => s.getLocalUri)
  const song = queue[queueIndex] || null
  const artworkOverride = useArtworkStore((s) => {
    const key = song?.albumId || song?.id
    return key ? s.overrides[key] : undefined
  })

  const status = useAudioPlayerStatus(audioPlayer)
  const prevFinishedRef = useRef(false)
  /** True while a requested play() hasn't produced actual playback yet. */
  const pendingPlayRef = useRef(false)

  useEffect(() => {
    ensureAudioMode()
  }, [])

  // Skip presses from the lock screen / Now Bar / headset arrive here; the queue
  // itself lives in the store, so they drive the same actions as the in-app buttons.
  useEffect(() => onRemoteCommand((command) => (command === 'next' ? next() : prev())), [next, prev])

  useEffect(() => {
    if (!song || !client) return
    const source = getOfflineUri(song.id) || client.streamUrl(song.id)
    // Remember that we still owe this track a play(): replace() reports
    // playing:false until the new source has loaded, and the status sync below
    // must not mistake that for the user having paused.
    pendingPlayRef.current = isPlaying
    audioPlayer.replace(source)
    audioPlayer.shouldCorrectPitch = true
    audioPlayer.setPlaybackRate(playbackRate)
    if (isPlaying) audioPlayer.play()
    recordHistory(song)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.id])

  // Kept separate from the track-load effect above: artworkOverride resolves
  // asynchronously (a user-triggered search that can finish after playback has
  // already started), and re-running it here must only refresh the Now Bar's
  // metadata, never re-trigger replace()/play() and restart the track.
  useEffect(() => {
    if (!song || !client) return
    // Stock expo-audio strips COMMAND_SEEK_TO_NEXT/PREVIOUS from its MediaSession,
    // which hides skip controls on every external surface. Our patch puts them
    // back (see patches/expo-audio), so prev/play/next occupy the main slots and
    // these +/-10s buttons sit in the notification overflow.
    audioPlayer.setActiveForLockScreen(
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
    if (isPlaying) {
      audioPlayer.play()
    } else {
      // An explicit pause cancels any play we were still waiting to land.
      pendingPlayRef.current = false
      audioPlayer.pause()
    }
  }, [isPlaying])

  useEffect(() => {
    audioPlayer.volume = volume
  }, [volume])

  useEffect(() => {
    // Must be setPlaybackRate(): the typings allow `playbackRate = x`, but the
    // native Android property is getter-only and assigning it throws at runtime,
    // which crashed the app on every launch since this effect runs on mount.
    audioPlayer.shouldCorrectPitch = true
    audioPlayer.setPlaybackRate(playbackRate)
  }, [playbackRate])

  useEffect(() => {
    setProgress(status.currentTime, status.duration)

    const justFinished = status.didJustFinish && !prevFinishedRef.current
    prevFinishedRef.current = status.didJustFinish

    // End of track must be handled before the mirroring below: the native status
    // forces playing:false on this tick, and letting that reach the store reads
    // as "the user paused" - which is what silently killed repeat-one.
    if (justFinished) {
      if (repeatMode === 'one') {
        pendingPlayRef.current = true
        useNavidromeStore.setState({ isPlaying: true })
        audioPlayer
          .seekTo(0)
          .then(() => audioPlayer.play())
          .catch(() => {})
      } else {
        next()
      }
      return
    }

    if (pendingPlayRef.current) {
      // Still waiting for a requested play to take: don't mirror the player's
      // transient playing:false back into the store, and re-assert play() once
      // the source is ready (the call made right after replace() can land before
      // loading finished and be silently dropped).
      if (status.playing) pendingPlayRef.current = false
      else if (status.isLoaded) audioPlayer.play()
    } else if (status.playing !== isPlaying) {
      // Genuine outside change - lock screen, Now Bar, headset, audio focus.
      useNavidromeStore.setState({ isPlaying: status.playing })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.currentTime, status.duration, status.playing, status.isLoaded, status.didJustFinish, repeatMode])

  return null
}
