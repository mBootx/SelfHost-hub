import { useNavidromeStore } from '@/store/navidromeStore'
import { useRemoteStore, LOCAL_DEVICE_ID } from '@/store/remoteStore'

/**
 * Where the music is: the local player's playhead, or the selected remote device's last reported one.
 * It ticks four times a second, so only small leaf components should call it - never a whole screen.
 */
export function usePlayhead(): { currentTime: number; duration: number; isRemote: boolean } {
  const selectedDeviceId = useRemoteStore((s) => s.selectedDeviceId)
  const isRemote = selectedDeviceId !== LOCAL_DEVICE_ID
  const localCurrentTime = useNavidromeStore((s) => s.currentTime)
  const localDuration = useNavidromeStore((s) => s.duration)
  const remote = useRemoteStore((s) => (isRemote ? s.devices[selectedDeviceId] : undefined))

  return {
    currentTime: isRemote ? remote?.currentTime ?? 0 : localCurrentTime,
    duration: isRemote ? remote?.duration ?? 0 : localDuration,
    isRemote
  }
}
