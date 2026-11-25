import { useEffect, useRef, useState } from 'react'
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Repeat,
  Repeat1,
  Shuffle,
  Volume2,
  Volume1,
  VolumeX,
  ListMusic,
  Music,
  HardDriveDownload,
  Cast,
  Laptop,
  Smartphone,
  GripVertical,
  Maximize2,
  Moon,
  X
} from 'lucide-react'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useOfflineStore } from '@renderer/store/offlineStore'
import { useRemoteStore, LOCAL_DEVICE_ID } from '@renderer/store/remoteStore'
import { useHistoryStore } from '@renderer/store/historyStore'
import { useToastStore } from '@renderer/store/toastStore'
import { useAudioSettingsStore } from '@renderer/store/audioSettingsStore'
import { useUIStore } from '@renderer/store/uiStore'
import { getAudioEngine, seekTo } from '@renderer/services/playbackEngine'
import { resumePosition } from '@renderer/services/playbackMemory'
import { plural } from '@renderer/services/plural'
import { useScrub } from '@renderer/hooks/useScrub'

const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75]
const SLEEP_PRESETS = [15, 30, 45, 60]

function formatSleepRemaining(ms: number): string {
  const safeMs = Math.max(0, ms)
  if (safeMs < 60_000) return `${Math.max(1, Math.ceil(safeMs / 1000))} s`
  return `${Math.ceil(safeMs / 60_000)} min`
}

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Owns the playhead subscription. Kept out of Player so the artwork, track title
 * and transport buttons don't re-render on every timeupdate for the whole track.
 * Follows whichever device is selected: local ticks come straight from the
 * store, a remote device's progress comes from its last reported state.
 */
function ProgressBar({ hasSong }: { hasSong: boolean }): JSX.Element {
  const selectedDeviceId = useRemoteStore((s) => s.selectedDeviceId)
  const isRemote = selectedDeviceId !== LOCAL_DEVICE_ID
  const localCurrentTime = useNavidromeStore((s) => s.currentTime)
  const localDuration = useNavidromeStore((s) => s.duration)
  const remote = useRemoteStore((s) => (isRemote ? s.devices[selectedDeviceId] : undefined))
  const setProgress = useNavidromeStore((s) => s.setProgress)
  const sendCommand = useRemoteStore((s) => s.sendCommand)

  const duration = isRemote ? remote?.duration ?? 0 : localDuration
  const scrub = useScrub(isRemote ? remote?.currentTime ?? 0 : localCurrentTime, (t) => {
    if (isRemote) {
      sendCommand('seek', { seconds: t })
    } else {
      seekTo(t)
      setProgress(t, duration)
    }
  })
  const currentTime = scrub.value
  const progressPercent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0

  return (
    <div className="flex w-full max-w-md items-center gap-2 text-[11px] tabular-nums text-gray-400">
      <span className="w-9 text-right">{formatTime(currentTime)}</span>
      <input
        type="range"
        min={0}
        max={duration || 0}
        value={currentTime}
        onPointerDown={scrub.onPointerDown}
        onChange={scrub.onChange}
        disabled={!hasSong}
        className="range-accent w-full disabled:cursor-default disabled:opacity-50"
        style={{ '--range-progress': `${progressPercent}%` } as React.CSSProperties}
      />
      <span className="w-9">{formatTime(duration)}</span>
    </div>
  )
}

export default function Player(): JSX.Element {
  const client = useNavidromeStore((s) => s.client)
  const queue = useNavidromeStore((s) => s.queue)
  const queueIndex = useNavidromeStore((s) => s.queueIndex)
  const localIsPlaying = useNavidromeStore((s) => s.isPlaying)
  const localRepeatMode = useNavidromeStore((s) => s.repeatMode)
  const localShuffle = useNavidromeStore((s) => s.shuffle)
  const localVolume = useNavidromeStore((s) => s.volume)
  const localPlaybackRate = useNavidromeStore((s) => s.playbackRate)
  const setPlaybackRate = useNavidromeStore((s) => s.setPlaybackRate)
  // The playhead lives in ProgressBar, so this component stays still while a
  // track plays instead of re-rendering on every timeupdate.
  const togglePlay = useNavidromeStore((s) => s.togglePlay)
  const next = useNavidromeStore((s) => s.next)
  const prev = useNavidromeStore((s) => s.prev)
  const setRepeatMode = useNavidromeStore((s) => s.setRepeatMode)
  const toggleShuffle = useNavidromeStore((s) => s.toggleShuffle)
  const setVolume = useNavidromeStore((s) => s.setVolume)
  const setProgress = useNavidromeStore((s) => s.setProgress)
  const jumpTo = useNavidromeStore((s) => s.jumpTo)
  const removeFromQueueAt = useNavidromeStore((s) => s.removeFromQueueAt)
  const reorderQueue = useNavidromeStore((s) => s.reorderQueue)
  const clearQueue = useNavidromeStore((s) => s.clearQueue)

  const getOfflineUrl = useOfflineStore((s) => s.getLocalUrl)
  const recordHistory = useHistoryStore((s) => s.record)
  const showToast = useToastStore((s) => s.show)

  const remoteRunning = useRemoteStore((s) => s.running)
  const deviceList = useRemoteStore((s) => s.deviceList)
  const selectedDeviceId = useRemoteStore((s) => s.selectedDeviceId)
  const switchOutput = useRemoteStore((s) => s.switchOutput)
  const sendCommand = useRemoteStore((s) => s.sendCommand)
  const handoffToHere = useRemoteStore((s) => s.handoffToHere)
  const handoffToDevice = useRemoteStore((s) => s.handoffToDevice)
  const remoteDevices = useRemoteStore((s) => s.devices)
  const remoteDevice = useRemoteStore((s) =>
    s.selectedDeviceId !== LOCAL_DEVICE_ID ? s.devices[s.selectedDeviceId] : undefined
  )
  const isRemote = selectedDeviceId !== LOCAL_DEVICE_ID
  const activeDeviceName = isRemote
    ? deviceList.find((d) => d.deviceId === selectedDeviceId)?.deviceName ?? 'Appareil'
    : null

  const crossfadeSeconds = useAudioSettingsStore((s) => s.crossfadeSeconds)
  const gapless = useAudioSettingsStore((s) => s.gapless)
  const normalize = useAudioSettingsStore((s) => s.normalize)
  const eqEnabled = useAudioSettingsStore((s) => s.eqEnabled)
  const eqGains = useAudioSettingsStore((s) => s.eqGains)

  const sleepTimerEndAt = useNavidromeStore((s) => s.sleepTimerEndAt)
  const sleepEndOfTrack = useNavidromeStore((s) => s.sleepEndOfTrack)
  const setSleepTimer = useNavidromeStore((s) => s.setSleepTimer)
  const cancelSleepTimer = useNavidromeStore((s) => s.cancelSleepTimer)

  const [showQueue, setShowQueue] = useState(false)
  const [showDevices, setShowDevices] = useState(false)
  const [showSleep, setShowSleep] = useState(false)
  const [sleepNow, setSleepNow] = useState(() => Date.now())
  const sleepMenuRef = useRef<HTMLDivElement>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const localSong = queue[queueIndex] || null
  const isSongOffline = useOfflineStore((s) => (localSong ? !!s.tracks[localSong.id] : false))

  // What's shown and driven by the transport below: the local player, unless a
  // remote device is selected as the active output, in which case its last
  // reported state takes over.
  const song = isRemote ? remoteDevice?.song ?? null : localSong
  const isPlaying = isRemote ? !!remoteDevice?.isPlaying : localIsPlaying
  const repeatMode = isRemote ? remoteDevice?.repeatMode ?? 'off' : localRepeatMode
  const shuffle = isRemote ? !!remoteDevice?.shuffle : localShuffle
  const volume = isRemote ? remoteDevice?.volume ?? 0.8 : localVolume

  // What follows the current track when it ends on its own - the same rules as the store's next().
  const localNextSong =
    localRepeatMode === 'one' ? null : (queue[queueIndex + 1] ?? (localRepeatMode === 'all' ? queue[0] : null))

  // These effects always follow the LOCAL store, never the display state above: the audio engine is
  // this computer's own output, which stays silent whenever a remote device is the selected target
  // (selectDevice pauses it locally).
  useEffect(() => {
    const engine = getAudioEngine()
    engine.setHandlers({
      onProgress: (currentTime, duration) => useNavidromeStore.getState().setProgress(currentTime, duration),
      onTrackEnd: () => {
        const { repeatMode, queue, next, sleepEndOfTrack, cancelSleepTimer } = useNavidromeStore.getState()
        if (sleepEndOfTrack) {
          cancelSleepTimer()
          useNavidromeStore.setState({ isPlaying: false })
          return
        }
        // A one-song queue on repeat-all "advances" to the same index, which reloads nothing.
        if (repeatMode === 'one' || (repeatMode === 'all' && queue.length === 1)) engine.restart()
        else next()
      },
      onAutoAdvance: () => useNavidromeStore.getState().next(),
      onError: (trackId) => {
        const state = useNavidromeStore.getState()
        const failed = state.queue[state.queueIndex]
        if (failed?.id !== trackId) return
        // Said only when sound was expected: a track restored at start-up with the server away fails quietly, and
        // pressing play tries it again.
        if (state.isPlaying) useToastStore.getState().show(`Lecture impossible : « ${failed.title} » (serveur injoignable ou fichier introuvable)`)
        useNavidromeStore.setState({ isPlaying: false })
      }
    })
    return () => {
      engine.setHandlers(null)
      engine.stop()
    }
  }, [])

  useEffect(() => {
    if (!localSong) return
    const src = getOfflineUrl(localSong.id) || (client ? client.streamUrl(localSong.id) : null)
    if (!src) return
    // A track restored from the last session picks up where it stopped. It was recorded in the
    // history when it first played, so it isn't recorded again.
    const resumeAt = resumePosition(localSong.id)
    getAudioEngine().load(localSong.id, src, useNavidromeStore.getState().isPlaying, resumeAt ?? 0)
    if (resumeAt === null) recordHistory(localSong)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localSong?.id])

  useEffect(() => {
    const nextSrc = localNextSong
      ? getOfflineUrl(localNextSong.id) || (client ? client.streamUrl(localNextSong.id) : null)
      : null
    getAudioEngine().setNext(localNextSong && nextSrc ? { id: localNextSong.id, src: nextSrc } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localNextSong?.id, client])

  useEffect(() => {
    if (localIsPlaying) getAudioEngine().play()
    else getAudioEngine().pause()
  }, [localIsPlaying])

  useEffect(() => {
    getAudioEngine().setVolume(localVolume)
  }, [localVolume])

  useEffect(() => {
    getAudioEngine().setRate(localPlaybackRate)
  }, [localPlaybackRate])

  useEffect(() => {
    getAudioEngine().setTransitions(crossfadeSeconds, gapless)
  }, [crossfadeSeconds, gapless])

  useEffect(() => {
    getAudioEngine().setEqualizer(eqEnabled, eqGains)
  }, [eqEnabled, eqGains])

  useEffect(() => {
    getAudioEngine().applyNormalize(localSong, localNextSong, normalize)
  }, [localSong, localNextSong, normalize])

  useEffect(() => {
    if (sleepTimerEndAt === null) return
    setSleepNow(Date.now())
    const timer = setInterval(() => setSleepNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [sleepTimerEndAt])

  useEffect(() => {
    if (!showSleep) return
    function onPointerDown(e: MouseEvent): void {
      if (sleepMenuRef.current && !sleepMenuRef.current.contains(e.target as Node)) {
        setShowSleep(false)
      }
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setShowSleep(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [showSleep])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const tag = (e.target as HTMLElement)?.tagName
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable
      if (isTyping) {
        // "/" is a normal character while typing - only treat it as the search
        // shortcut when nothing has focus yet.
        return
      }
      // Ctrl+R, Alt+S and the like belong to Windows and Chromium, not to the player.
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // Space on a focused button presses that button: playing or pausing as well would undo its click.
      if (e.code === 'Space' && (tag === 'BUTTON' || tag === 'SELECT' || tag === 'A')) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (isRemote) sendCommand('toggle')
        else togglePlay()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (isRemote) {
          const t = Math.min(remoteDevice?.duration || 0, (remoteDevice?.currentTime || 0) + 10)
          sendCommand('seek', { seconds: t })
        } else {
          const { currentTime, duration } = useNavidromeStore.getState()
          const t = Math.min(duration || 0, currentTime + 10)
          seekTo(t)
          setProgress(t, duration)
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (isRemote) {
          const t = Math.max(0, (remoteDevice?.currentTime || 0) - 10)
          sendCommand('seek', { seconds: t })
        } else {
          const { currentTime, duration } = useNavidromeStore.getState()
          const t = Math.max(0, currentTime - 10)
          seekTo(t)
          setProgress(t, duration)
        }
      } else if (e.key === 's' || e.key === 'S') {
        handleToggleShuffle()
      } else if (e.key === 'r' || e.key === 'R') {
        handleCycleRepeat()
      } else if (e.key === '/') {
        e.preventDefault()
        window.dispatchEvent(new Event('shub:focus-search'))
      } else if (e.key === 'f' || e.key === 'F') {
        // The full-screen player; the same key closes it.
        e.preventDefault()
        useUIStore.getState().toggleBigPicture()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [togglePlay, isRemote, sendCommand, remoteDevice])

  function handleTogglePlay(): void {
    if (isRemote) sendCommand('toggle')
    else togglePlay()
  }
  function handleNext(): void {
    if (isRemote) sendCommand('next')
    else next()
  }
  function handlePrev(): void {
    if (isRemote) sendCommand('prev')
    else prev()
  }
  function handleToggleShuffle(): void {
    if (isRemote) sendCommand('toggleShuffle')
    else toggleShuffle()
  }
  function handleCycleRepeat(): void {
    const mode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off'
    if (isRemote) sendCommand('setRepeatMode', { mode })
    else setRepeatMode(mode)
  }
  function handleSetVolume(v: number): void {
    if (isRemote) sendCommand('setVolume', { volume: v })
    else setVolume(v)
  }
  // Unmuting goes back to the volume there was, not to a fixed one.
  const volumeBeforeMute = useRef(0.8)
  function handleToggleMute(): void {
    if (volume > 0) {
      volumeBeforeMute.current = volume
      handleSetVolume(0)
    } else {
      handleSetVolume(volumeBeforeMute.current > 0 ? volumeBeforeMute.current : 0.8)
    }
  }
  function handleCycleSpeed(): void {
    const idx = SPEEDS.indexOf(localPlaybackRate)
    setPlaybackRate(SPEEDS[(idx + 1) % SPEEDS.length])
  }
  function handleSeek(seconds: number): void {
    if (isRemote) {
      sendCommand('seek', { seconds })
    } else {
      seekTo(seconds)
      setProgress(seconds, useNavidromeStore.getState().duration)
    }
  }
  function currentPosition(): number {
    return isRemote ? remoteDevice?.currentTime ?? 0 : useNavidromeStore.getState().currentTime
  }

  // Windows media controls (volume flyout, lock screen, keyboard media keys) and the tray menu go
  // through the same handlers as the buttons below, so they drive whichever device is selected.
  // The ref keeps them current without re-registering on every render.
  const mediaActions = useRef({ isPlaying, togglePlay: handleTogglePlay, next: handleNext, prev: handlePrev, seek: handleSeek, position: currentPosition })
  mediaActions.current = { isPlaying, togglePlay: handleTogglePlay, next: handleNext, prev: handlePrev, seek: handleSeek, position: currentPosition }

  useEffect(() => {
    const session = navigator.mediaSession
    const artwork = song && client ? client.coverArtUrl(song.coverArt || song.albumId || song.id, 512) : null
    session.metadata = song
      ? new MediaMetadata({
          title: song.title,
          artist: song.artist,
          album: song.album ?? '',
          artwork: artwork ? [{ src: artwork, sizes: '640x640', type: 'image/jpeg' }] : []
        })
      : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.id, client])

  useEffect(() => {
    navigator.mediaSession.playbackState = song ? (isPlaying ? 'playing' : 'paused') : 'none'
    window.api.tray.setNowPlaying(song ? { title: song.title, artist: song.artist, isPlaying } : null)
  }, [song, isPlaying])

  useEffect(() => {
    const session = navigator.mediaSession
    const actions = mediaActions
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => {
        if (!actions.current.isPlaying) actions.current.togglePlay()
      }],
      ['pause', () => {
        if (actions.current.isPlaying) actions.current.togglePlay()
      }],
      ['stop', () => {
        if (actions.current.isPlaying) actions.current.togglePlay()
      }],
      ['nexttrack', () => actions.current.next()],
      ['previoustrack', () => actions.current.prev()],
      ['seekto', (details) => {
        if (details.seekTime !== undefined) actions.current.seek(details.seekTime)
      }],
      ['seekbackward', (details) => actions.current.seek(Math.max(0, actions.current.position() - (details.seekOffset ?? 10)))],
      ['seekforward', (details) => actions.current.seek(actions.current.position() + (details.seekOffset ?? 10))]
    ]
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler)
      } catch {
        // This Chromium doesn't know the action.
      }
    }
    const stopTrayCommands = window.api.tray.onCommand((command) => {
      if (command === 'toggle') actions.current.togglePlay()
      else if (command === 'next') actions.current.next()
      else actions.current.prev()
    })
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null)
        } catch {
          // Same as above.
        }
      }
      stopTrayCommands()
      session.metadata = null
      window.api.tray.setNowPlaying(null)
    }
  }, [])

  // The Windows timeline: the local playhead at most once a second, or the remote device's last report.
  useEffect(() => {
    const session = navigator.mediaSession
    const update = (duration: number, position: number, rate: number): void => {
      if (!(duration > 0)) return
      try {
        session.setPositionState({ duration, playbackRate: rate, position: Math.min(Math.max(position, 0), duration) })
      } catch {
        // Rejected (e.g. duration not known yet): the next update will do.
      }
    }
    if (isRemote) {
      update(remoteDevice?.duration ?? 0, remoteDevice?.currentTime ?? 0, 1)
      return
    }
    let last = 0
    return useNavidromeStore.subscribe((s) => {
      const now = Date.now()
      if (now - last < 1000) return
      last = now
      update(s.duration, s.currentTime, s.playbackRate)
    })
  }, [isRemote, remoteDevice])

  const VolumeIcon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2
  const volumePercent = volume * 100

  return (
    <div className="border-t border-surface-border bg-surface-elevated">
      <div className="grid grid-cols-3 items-center gap-4 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {song && client ? (
            <button
              onClick={() => useUIStore.getState().openBigPicture()}
              title="Plein écran (F)"
              aria-label="Ouvrir le lecteur plein écran"
              className="group relative h-14 w-14 shrink-0 overflow-hidden rounded shadow-md"
            >
              <img
                src={client.coverArtUrl(song.coverArt || song.albumId || song.id, 64)}
                alt=""
                className="h-14 w-14 object-cover transition-opacity group-hover:opacity-50"
              />
              <Maximize2 className="absolute inset-0 m-auto h-5 w-5 text-white opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-surface-hover">
              <Music className="h-5 w-5 text-gray-600" />
            </div>
          )}
          <div className="min-w-0">
            <p className={`flex items-center gap-1.5 truncate text-sm font-medium ${song ? 'text-white' : 'text-gray-500'}`}>
              <span className="truncate">{song?.title || 'Aucune lecture'}</span>
              {isSongOffline && !isRemote && (
                <span title="Disponible hors ligne">
                  <HardDriveDownload className="h-3.5 w-3.5 shrink-0 text-accent" />
                </span>
              )}
            </p>
            <p className="truncate text-xs text-gray-400">
              {isRemote ? `${song?.artist || '-'} · ${deviceList.find((d) => d.deviceId === selectedDeviceId)?.deviceName}` : song?.artist || '-'}
            </p>
          </div>
        </div>

        <div className="flex flex-col items-center gap-1">
          <div className="flex items-center gap-4">
            <button
              onClick={handleToggleShuffle}
              title="Aléatoire (S)"
              aria-label="Lecture aléatoire"
              aria-pressed={shuffle}
              className={`transition-colors ${shuffle ? 'text-accent' : 'text-gray-400 hover:text-white'}`}
            >
              <Shuffle className="h-4 w-4" />
            </button>
            <button onClick={handlePrev} title="Précédent" aria-label="Titre précédent" className="text-gray-300 hover:text-white">
              <SkipBack className="h-5 w-5" />
            </button>
            <button
              onClick={handleTogglePlay}
              title={isPlaying ? 'Pause (Espace)' : 'Lecture (Espace)'}
              aria-label={isPlaying ? 'Pause' : 'Lecture'}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-black transition-transform hover:scale-105"
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 pl-0.5" />}
            </button>
            <button onClick={handleNext} title="Suivant" aria-label="Titre suivant" className="text-gray-300 hover:text-white">
              <SkipForward className="h-5 w-5" />
            </button>
            <button
              onClick={handleCycleRepeat}
              title={repeatMode === 'one' ? 'Répéter ce titre (R)' : repeatMode === 'all' ? 'Répéter tout (R)' : 'Répéter (R)'}
              aria-label="Répétition"
              className={`transition-colors ${repeatMode !== 'off' ? 'text-accent' : 'text-gray-400 hover:text-white'}`}
            >
              {repeatMode === 'one' ? <Repeat1 className="h-4 w-4" /> : <Repeat className="h-4 w-4" />}
            </button>
          </div>
          <ProgressBar hasSong={!!song} />
        </div>

        <div className="flex items-center justify-end gap-3">
          {remoteRunning && (() => {
            const otherDevices = deviceList.filter((d) => d.deviceId !== 'hub')
            const playingRemote = otherDevices.find(
              (d) => remoteDevices[d.deviceId]?.isPlaying && remoteDevices[d.deviceId]?.song
            )
            return (
            <div className="relative flex items-center gap-1.5">
              {isRemote && activeDeviceName && (
                <button
                  onClick={() => setShowDevices((v) => !v)}
                  title={`Écoute sur ${activeDeviceName}`}
                  className="hidden items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/25 xl:flex"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  <span className="max-w-[130px] truncate">Écoute sur {activeDeviceName}</span>
                </button>
              )}
              <button
                onClick={() => setShowDevices((v) => !v)}
                title={isRemote && activeDeviceName ? `Écoute sur ${activeDeviceName}` : 'Appareils'}
                className={`rounded-full p-1.5 transition-colors ${
                  isRemote || showDevices ? 'bg-surface-hover text-accent' : 'text-gray-400 hover:text-white'
                }`}
              >
                <Cast className="h-4 w-4" />
              </button>
              {showDevices && (
                <div className="absolute bottom-full right-0 z-10 mb-2 w-72 animate-fade-in rounded-lg border border-surface-border bg-surface-elevated p-1.5 shadow-xl">
                  <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    {isRemote && activeDeviceName ? `Écoute sur ${activeDeviceName}` : 'Écoute sur cet ordinateur'}
                  </p>
                  <button
                    onClick={() => {
                      const source = playingRemote
                      if (switchOutput(LOCAL_DEVICE_ID) && source) showToast(`Lecture reprise depuis ${source.deviceName}`)
                      setShowDevices(false)
                    }}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
                      selectedDeviceId === LOCAL_DEVICE_ID ? 'bg-accent/10 text-accent' : 'text-gray-300 hover:bg-surface-hover'
                    }`}
                  >
                    <Laptop className="h-3.5 w-3.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate">Cet ordinateur</span>
                        {localIsPlaying && localSong && (
                          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                            En cours de lecture
                          </span>
                        )}
                        {selectedDeviceId === LOCAL_DEVICE_ID && (
                          <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] font-semibold text-gray-200">
                            Contrôlé
                          </span>
                        )}
                      </div>
                      {selectedDeviceId !== LOCAL_DEVICE_ID && playingRemote && (
                        <span className="block text-[10px] font-semibold text-accent">Passer l&apos;écoute ici</span>
                      )}
                    </div>
                  </button>
                  {otherDevices.map((d) => {
                      const dState = remoteDevices[d.deviceId]
                      const isSelected = selectedDeviceId === d.deviceId
                      const isPlayingHere = !!(dState?.isPlaying && dState?.song)
                      return (
                        <div key={d.deviceId} className="space-y-1">
                          <button
                            onClick={() => {
                              const hadLocalPlaying = localIsPlaying && !!localSong
                              if (switchOutput(d.deviceId) && hadLocalPlaying) showToast(`Lecture transférée vers ${d.deviceName}`)
                              setShowDevices(false)
                            }}
                            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
                              isSelected ? 'bg-accent/10 text-accent' : 'text-gray-300 hover:bg-surface-hover'
                            }`}
                          >
                            {d.platform === 'desktop' ? (
                              <Laptop className="h-3.5 w-3.5 shrink-0" />
                            ) : (
                              <Smartphone className="h-3.5 w-3.5 shrink-0" />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="truncate">{d.deviceName}</span>
                                {isPlayingHere && (
                                  <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                                    En cours de lecture
                                  </span>
                                )}
                                {isSelected && (
                                  <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] font-semibold text-gray-200">
                                    Contrôlé
                                  </span>
                                )}
                              </div>
                              {dState?.song && (
                                <span className="block truncate text-[11px] text-gray-500">
                                  {dState.song.title} · {dState.song.artist}
                                </span>
                              )}
                            </div>
                          </button>
                          <div className="flex gap-1 px-2 pb-1">
                            {dState?.song && (
                              <button
                                onClick={() => {
                                  if (handoffToHere(d.deviceId)) showToast(`Lecture reprise depuis ${d.deviceName}`)
                                  setShowDevices(false)
                                }}
                                className="rounded bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent hover:bg-accent/25"
                              >
                                Passer l&apos;écoute ici
                              </button>
                            )}
                            {localSong && !localIsPlaying && (
                              <button
                                onClick={() => {
                                  if (handoffToDevice(d.deviceId)) showToast(`Lecture transférée vers ${d.deviceName}`)
                                  setShowDevices(false)
                                }}
                                className="rounded bg-surface-hover px-2 py-0.5 text-[11px] font-semibold text-gray-300 hover:text-white"
                              >
                                Transférer là-bas
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  {otherDevices.length === 0 && (
                    <p className="px-2 py-1.5 text-xs text-gray-500">Aucun autre appareil connecté.</p>
                  )}
                </div>
              )}
            </div>
            )
          })()}
          {!isRemote && (
            <button
              onClick={handleCycleSpeed}
              title="Vitesse de lecture"
              className={`rounded-full px-1.5 py-1 text-xs font-semibold transition-colors ${
                localPlaybackRate !== 1 ? 'bg-surface-hover text-accent' : 'text-gray-400 hover:text-white'
              }`}
            >
              {localPlaybackRate}x
            </button>
          )}
          {!isRemote && (
            <div ref={sleepMenuRef} className="relative">
              {(() => {
                const sleepRemainingMs = sleepTimerEndAt !== null ? Math.max(0, sleepTimerEndAt - sleepNow) : null
                const sleepActive = sleepRemainingMs !== null || sleepEndOfTrack
                const sleepLabel =
                  sleepRemainingMs !== null
                    ? formatSleepRemaining(sleepRemainingMs)
                    : sleepEndOfTrack
                      ? 'Fin du titre'
                      : null
                return (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setShowDevices(false)
                        setShowSleep((v) => !v)
                      }}
                      title={sleepLabel ? `Minuteur de veille · ${sleepLabel}` : 'Minuteur de veille'}
                      aria-label={sleepLabel ? `Minuteur de veille actif : ${sleepLabel}` : 'Minuteur de veille'}
                      aria-expanded={showSleep}
                      className={`flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold transition-colors ${
                        sleepActive || showSleep ? 'bg-surface-hover text-accent' : 'text-gray-400 hover:text-white'
                      }`}
                    >
                      <Moon className="h-4 w-4 shrink-0" />
                      {sleepLabel && <span className="tabular-nums">{sleepLabel}</span>}
                    </button>
                    {showSleep && (
                      <div className="absolute bottom-full right-0 z-10 mb-2 w-48 animate-fade-in rounded-lg border border-surface-border bg-surface-elevated p-1.5 shadow-xl">
                        <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                          {sleepRemainingMs !== null
                            ? `Veille · ${formatSleepRemaining(sleepRemainingMs)}`
                            : sleepEndOfTrack
                              ? 'Veille · Fin du titre'
                              : 'Minuteur de veille'}
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            cancelSleepTimer()
                            setShowSleep(false)
                          }}
                          className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm transition-colors ${
                            !sleepActive ? 'text-accent' : 'text-gray-300 hover:bg-surface-hover'
                          }`}
                        >
                          <span>Désactivé</span>
                        </button>
                        {SLEEP_PRESETS.map((minutes) => (
                          <button
                            key={minutes}
                            type="button"
                            onClick={() => {
                              setSleepTimer(minutes)
                              setShowSleep(false)
                            }}
                            className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm text-gray-300 transition-colors hover:bg-surface-hover hover:text-white"
                          >
                            <span>{minutes} min</span>
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => {
                            setSleepTimer('endOfTrack')
                            setShowSleep(false)
                          }}
                          className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm transition-colors ${
                            sleepEndOfTrack ? 'text-accent' : 'text-gray-300 hover:bg-surface-hover'
                          }`}
                        >
                          <span>Fin du titre</span>
                        </button>
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
          )}
          <button
            onClick={() => useUIStore.getState().openBigPicture()}
            title="Plein écran (F)"
            className="rounded-full p-1.5 text-gray-400 transition-colors hover:text-white"
          >
            <Maximize2 className="h-4 w-4" />
          </button>
          <button
            onClick={() => setShowQueue((v) => !v)}
            title="File de lecture"
            className={`rounded-full p-1.5 transition-colors ${
              showQueue ? 'bg-surface-hover text-accent' : 'text-gray-400 hover:text-white'
            }`}
          >
            <ListMusic className="h-4 w-4" />
          </button>
          <button
            onClick={handleToggleMute}
            title={volume > 0 ? 'Muet' : 'Rétablir le son'}
            className="text-gray-400 transition-colors hover:text-white"
          >
            <VolumeIcon className="h-4 w-4" />
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => handleSetVolume(Number(e.target.value))}
            className="range-accent w-24"
            style={{ '--range-progress': `${volumePercent}%` } as React.CSSProperties}
          />
        </div>
      </div>

      {showQueue && (
        <div className="max-h-64 animate-fade-in overflow-y-auto border-t border-surface-border px-2 py-2">
          <div className="flex items-center justify-between px-2 pb-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              File de lecture · {plural(queue.length, 'titre', 'titres')}
            </p>
            {queue.length > 0 &&
              (confirmClear ? (
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-gray-400">Vider la file ?</span>
                  <button
                    onClick={() => {
                      clearQueue()
                      setConfirmClear(false)
                      showToast('File de lecture vidée')
                    }}
                    className="rounded-full bg-red-500/20 px-2 py-0.5 font-semibold text-red-400 hover:bg-red-500/30"
                  >
                    Oui
                  </button>
                  <button onClick={() => setConfirmClear(false)} className="text-gray-500 hover:text-white">
                    Annuler
                  </button>
                </div>
              ) : (
                <button onClick={() => setConfirmClear(true)} className="text-[11px] text-gray-500 hover:text-red-400">
                  Vider
                </button>
              ))}
          </div>
          {queue.map((s, i) => (
            <div
              key={`${s.id}-${i}`}
              draggable
              onDragStart={() => setDraggedIndex(i)}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOverIndex(i)
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (draggedIndex !== null && draggedIndex !== i) reorderQueue(draggedIndex, i)
                setDraggedIndex(null)
                setDragOverIndex(null)
              }}
              onDragEnd={() => {
                setDraggedIndex(null)
                setDragOverIndex(null)
              }}
              className={`group flex items-center gap-1.5 rounded px-1 py-1 text-sm transition-colors ${
                i === queueIndex ? 'bg-surface-hover text-accent' : 'text-gray-300 hover:bg-surface-hover'
              } ${dragOverIndex === i && draggedIndex !== null && draggedIndex !== i ? 'border-t-2 border-accent' : ''}`}
            >
              <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-gray-600" />
              <button onClick={() => jumpTo(i)} className="min-w-0 flex-1 truncate py-0.5 text-left">
                {s.title} <span className="text-gray-500">- {s.artist}</span>
              </button>
              <span className="shrink-0 text-xs text-gray-500">{formatTime(s.duration)}</span>
              <button
                onClick={() => removeFromQueueAt(i)}
                title="Retirer de la file"
                className="shrink-0 rounded p-0.5 text-gray-500 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
