import { NDSong } from '@renderer/services/navidrome'
import { seekTo } from '@renderer/services/playbackEngine'
import { RepeatMode, useNavidromeStore } from '@renderer/store/navidromeStore'
import { LOCAL_DEVICE_ID, useRemoteStore } from '@renderer/store/remoteStore'

/** The song as the screens need it: what a Navidrome song and a remote device's song have in common. */
export type ShownSong = Pick<NDSong, 'id' | 'title' | 'artist' | 'album' | 'albumId' | 'coverArt' | 'duration'>

export interface PlaybackView {
  song: ShownSong | null
  /** What follows when this computer is playing (null when a remote device is: its queue is not known here). */
  upNext: ShownSong | null
  isPlaying: boolean
  repeatMode: RepeatMode
  shuffle: boolean
  volume: number
  /** A remote device is the selected output rather than this computer. */
  isRemote: boolean
  deviceName: string | null
  toggle: () => void
  next: () => void
  prev: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  setVolume: (volume: number) => void
  seek: (seconds: number) => void
}

/**
 * What is playing and the controls to drive it, on whichever device is selected: this computer, or a remote one
 * (a phone) that the commands go to. The same rules as the player bar (components/Navidrome/Player.tsx), for the
 * screens that are not the player bar. Deliberately without the playhead: that changes several times a second and
 * lives in hooks/usePlayhead.ts, so that only what shows it redraws.
 */
export function usePlaybackView(): PlaybackView {
  const selectedDeviceId = useRemoteStore((s) => s.selectedDeviceId)
  const isRemote = selectedDeviceId !== LOCAL_DEVICE_ID
  const remote = useRemoteStore((s) => (s.selectedDeviceId !== LOCAL_DEVICE_ID ? s.devices[s.selectedDeviceId] : undefined))
  const deviceName = useRemoteStore((s) => (isRemote ? s.deviceList.find((d) => d.deviceId === selectedDeviceId)?.deviceName ?? null : null))
  const sendCommand = useRemoteStore((s) => s.sendCommand)

  const localSong = useNavidromeStore((s) => s.queue[s.queueIndex] || null)
  const localNext = useNavidromeStore((s) =>
    s.repeatMode === 'one' ? null : (s.queue[s.queueIndex + 1] ?? (s.repeatMode === 'all' ? s.queue[0] ?? null : null))
  )
  const localPlaying = useNavidromeStore((s) => s.isPlaying)
  const localRepeat = useNavidromeStore((s) => s.repeatMode)
  const localShuffle = useNavidromeStore((s) => s.shuffle)
  const localVolume = useNavidromeStore((s) => s.volume)
  const togglePlay = useNavidromeStore((s) => s.togglePlay)
  const next = useNavidromeStore((s) => s.next)
  const prev = useNavidromeStore((s) => s.prev)
  const setRepeatMode = useNavidromeStore((s) => s.setRepeatMode)
  const toggleLocalShuffle = useNavidromeStore((s) => s.toggleShuffle)
  const setLocalVolume = useNavidromeStore((s) => s.setVolume)
  const setProgress = useNavidromeStore((s) => s.setProgress)

  const repeatMode: RepeatMode = isRemote ? remote?.repeatMode ?? 'off' : localRepeat

  return {
    song: isRemote ? remote?.song ?? null : localSong,
    upNext: isRemote ? null : localNext,
    isPlaying: isRemote ? !!remote?.isPlaying : localPlaying,
    repeatMode,
    shuffle: isRemote ? !!remote?.shuffle : localShuffle,
    volume: isRemote ? remote?.volume ?? 0.8 : localVolume,
    isRemote,
    deviceName,
    toggle: () => (isRemote ? sendCommand('toggle') : togglePlay()),
    next: () => (isRemote ? sendCommand('next') : next()),
    prev: () => (isRemote ? sendCommand('prev') : prev()),
    toggleShuffle: () => (isRemote ? sendCommand('toggleShuffle') : toggleLocalShuffle()),
    cycleRepeat: () => {
      const mode: RepeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off'
      if (isRemote) sendCommand('setRepeatMode', { mode })
      else setRepeatMode(mode)
    },
    setVolume: (volume) => (isRemote ? sendCommand('setVolume', { volume }) : setLocalVolume(volume)),
    seek: (seconds) => {
      if (isRemote) {
        sendCommand('seek', { seconds })
      } else {
        seekTo(seconds)
        setProgress(seconds, useNavidromeStore.getState().duration)
      }
    }
  }
}
