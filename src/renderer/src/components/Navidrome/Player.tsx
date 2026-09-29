import { useEffect, useState } from 'react'
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
  X
} from 'lucide-react'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { useOfflineStore } from '@renderer/store/offlineStore'
import { useRemoteStore, LOCAL_DEVICE_ID } from '@renderer/store/remoteStore'
import { useHistoryStore } from '@renderer/store/historyStore'
import { useToastStore } from '@renderer/store/toastStore'
import { useAudioSettingsStore } from '@renderer/store/audioSettingsStore'
import { getAudioEngine, seekTo } from '@renderer/services/playbackEngine'

const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75]

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

  const currentTime = isRemote ? remote?.currentTime ?? 0 : localCurrentTime
  const duration = isRemote ? remote?.duration ?? 0 : localDuration
  const progressPercent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0

  return (
    <div className="flex w-full max-w-md items-center gap-2 text-[11px] tabular-nums text-gray-400">
      <span className="w-9 text-right">{formatTime(currentTime)}</span>
      <input
        type="range"
        min={0}
        max={duration || 0}
        value={currentTime}
        onChange={(e) => {
          const t = Number(e.target.value)
          if (isRemote) {
            sendCommand('seek', { seconds: t })
          } else {
            seekTo(t)
            setProgress(t, duration)
          }
        }}
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
  const playQueue = useNavidromeStore((s) => s.playQueue)
  const removeFromQueueAt = useNavidromeStore((s) => s.removeFromQueueAt)
  const reorderQueue = useNavidromeStore((s) => s.reorderQueue)
  const clearQueue = useNavidromeStore((s) => s.clearQueue)

  const getOfflineUrl = useOfflineStore((s) => s.getLocalUrl)
  const recordHistory = useHistoryStore((s) => s.record)
  const showToast = useToastStore((s) => s.show)

  const remoteRunning = useRemoteStore((s) => s.running)
  const deviceList = useRemoteStore((s) => s.deviceList)
  const selectedDeviceId = useRemoteStore((s) => s.selectedDeviceId)
  const selectDevice = useRemoteStore((s) => s.selectDevice)
  const sendCommand = useRemoteStore((s) => s.sendCommand)
  const remoteDevice = useRemoteStore((s) =>
    s.selectedDeviceId !== LOCAL_DEVICE_ID ? s.devices[s.selectedDeviceId] : undefined
  )
  const isRemote = selectedDeviceId !== LOCAL_DEVICE_ID

  const crossfadeSeconds = useAudioSettingsStore((s) => s.crossfadeSeconds)
  const gapless = useAudioSettingsStore((s) => s.gapless)
  const eqEnabled = useAudioSettingsStore((s) => s.eqEnabled)
  const eqGains = useAudioSettingsStore((s) => s.eqGains)

  const [showQueue, setShowQueue] = useState(false)
  const [showDevices, setShowDevices] = useState(false)
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
        const { repeatMode, queue, next } = useNavidromeStore.getState()
        // A one-song queue on repeat-all "advances" to the same index, which reloads nothing.
        if (repeatMode === 'one' || (repeatMode === 'all' && queue.length === 1)) engine.restart()
        else next()
      },
      onAutoAdvance: () => useNavidromeStore.getState().next()
    })
    return () => {
      engine.setHandlers(null)
      engine.stop()
    }
  }, [])

  useEffect(() => {
    if (!localSong || !client) return
    const src = getOfflineUrl(localSong.id) || client.streamUrl(localSong.id)
    getAudioEngine().load(localSong.id, src, useNavidromeStore.getState().isPlaying)
    recordHistory(localSong)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localSong?.id])

  useEffect(() => {
    if (!client) return
    getAudioEngine().setNext(
      localNextSong ? { id: localNextSong.id, src: getOfflineUrl(localNextSong.id) || client.streamUrl(localNextSong.id) } : null
    )
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
    function onKey(e: KeyboardEvent): void {
      const tag = (e.target as HTMLElement)?.tagName
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA'
      if (isTyping) {
        // "/" is a normal character while typing - only treat it as the search
        // shortcut when nothing has focus yet.
        return
      }
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
  function handleCycleSpeed(): void {
    const idx = SPEEDS.indexOf(localPlaybackRate)
    setPlaybackRate(SPEEDS[(idx + 1) % SPEEDS.length])
  }

  const VolumeIcon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2
  const volumePercent = volume * 100

  return (
    <div className="border-t border-surface-border bg-surface-elevated">
      <div className="grid grid-cols-3 items-center gap-4 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {song && client ? (
            <img
              src={client.coverArtUrl(song.coverArt || song.albumId || song.id, 64)}
              alt=""
              className="h-14 w-14 rounded object-cover shadow-md"
            />
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-surface-hover">
              <Music className="h-5 w-5 text-gray-600" />
            </div>
          )}
          <div className="min-w-0">
            <p className={`flex items-center gap-1.5 truncate text-sm font-medium ${song ? 'text-white' : 'text-gray-500'}`}>
              <span className="truncate">{song?.title || 'Aucune lecture'}</span>
              {isSongOffline && !isRemote && (
                <span title="Disponible hors-ligne">
                  <HardDriveDownload className="h-3.5 w-3.5 shrink-0 text-accent" />
                </span>
              )}
            </p>
            <p className="truncate text-xs text-gray-400">
              {isRemote ? `${song?.artist || '-'} - ${deviceList.find((d) => d.deviceId === selectedDeviceId)?.deviceName}` : song?.artist || '-'}
            </p>
          </div>
        </div>

        <div className="flex flex-col items-center gap-1">
          <div className="flex items-center gap-4">
            <button
              onClick={handleToggleShuffle}
              className={`transition-colors ${shuffle ? 'text-accent' : 'text-gray-400 hover:text-white'}`}
            >
              <Shuffle className="h-4 w-4" />
            </button>
            <button onClick={handlePrev} className="text-gray-300 hover:text-white">
              <SkipBack className="h-5 w-5" />
            </button>
            <button
              onClick={handleTogglePlay}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-black transition-transform hover:scale-105"
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 pl-0.5" />}
            </button>
            <button onClick={handleNext} className="text-gray-300 hover:text-white">
              <SkipForward className="h-5 w-5" />
            </button>
            <button
              onClick={handleCycleRepeat}
              className={`transition-colors ${repeatMode !== 'off' ? 'text-accent' : 'text-gray-400 hover:text-white'}`}
            >
              {repeatMode === 'one' ? <Repeat1 className="h-4 w-4" /> : <Repeat className="h-4 w-4" />}
            </button>
          </div>
          <ProgressBar hasSong={!!song} />
        </div>

        <div className="flex items-center justify-end gap-3">
          {remoteRunning && (
            <div className="relative">
              <button
                onClick={() => setShowDevices((v) => !v)}
                title="Appareils"
                className={`rounded-full p-1.5 transition-colors ${
                  isRemote || showDevices ? 'bg-surface-hover text-accent' : 'text-gray-400 hover:text-white'
                }`}
              >
                <Cast className="h-4 w-4" />
              </button>
              {showDevices && (
                <div className="absolute bottom-full right-0 z-10 mb-2 w-56 animate-fade-in rounded-lg border border-surface-border bg-surface-elevated p-1.5 shadow-xl">
                  <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    Lire sur
                  </p>
                  <button
                    onClick={() => {
                      selectDevice(LOCAL_DEVICE_ID)
                      setShowDevices(false)
                    }}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
                      selectedDeviceId === LOCAL_DEVICE_ID ? 'text-accent' : 'text-gray-300 hover:bg-surface-hover'
                    }`}
                  >
                    <Laptop className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">Cet ordinateur</span>
                  </button>
                  {deviceList
                    .filter((d) => d.deviceId !== 'hub')
                    .map((d) => (
                      <button
                        key={d.deviceId}
                        onClick={() => {
                          selectDevice(d.deviceId)
                          setShowDevices(false)
                        }}
                        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
                          selectedDeviceId === d.deviceId ? 'text-accent' : 'text-gray-300 hover:bg-surface-hover'
                        }`}
                      >
                        <Smartphone className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{d.deviceName}</span>
                      </button>
                    ))}
                  {deviceList.filter((d) => d.deviceId !== 'hub').length === 0 && (
                    <p className="px-2 py-1.5 text-xs text-gray-500">Aucun autre appareil connecte.</p>
                  )}
                </div>
              )}
            </div>
          )}
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
            onClick={() => handleSetVolume(volume > 0 ? 0 : 0.8)}
            title={volume > 0 ? 'Muet' : 'Retablir le son'}
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
              File de lecture - {queue.length} titres
            </p>
            {queue.length > 0 &&
              (confirmClear ? (
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-gray-400">Vider la file ?</span>
                  <button
                    onClick={() => {
                      clearQueue()
                      setConfirmClear(false)
                      showToast('File de lecture videe')
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
              <button onClick={() => playQueue(queue, i)} className="min-w-0 flex-1 truncate py-0.5 text-left">
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
