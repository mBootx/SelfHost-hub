import { useEffect, useRef, useState } from 'react'
import { estimatePosition, PlayheadBase } from '@renderer/services/bigPicture'
import { useNavidromeStore } from '@renderer/store/navidromeStore'
import { LOCAL_DEVICE_ID, useRemoteStore } from '@renderer/store/remoteStore'

/**
 * Where the song is, smoothly. This computer reports its position a few times a second and a remote device about
 * once a second; between two reports the position is moved along by the clock, so the lyrics and the progress bar
 * run instead of stepping. The next report is the truth again. Call it in the component that draws the position (and
 * nowhere above it): it redraws that component `fps` times a second.
 */
export function usePlayhead(fps = 24): { time: number; duration: number } {
  const selectedDeviceId = useRemoteStore((s) => s.selectedDeviceId)
  const isRemote = selectedDeviceId !== LOCAL_DEVICE_ID
  const remote = useRemoteStore((s) => (s.selectedDeviceId !== LOCAL_DEVICE_ID ? s.devices[s.selectedDeviceId] : undefined))
  const localTime = useNavidromeStore((s) => s.currentTime)
  const localDuration = useNavidromeStore((s) => s.duration)
  const localPlaying = useNavidromeStore((s) => s.isPlaying)
  const localRate = useNavidromeStore((s) => s.playbackRate)

  const reported = isRemote ? remote?.currentTime ?? 0 : localTime
  const duration = isRemote ? remote?.duration ?? 0 : localDuration
  const playing = isRemote ? !!remote?.isPlaying : localPlaying
  const rate = isRemote ? 1 : localRate

  const base = useRef<PlayheadBase>({ time: reported, at: performance.now(), playing, rate })
  const [time, setTime] = useState(reported)

  useEffect(() => {
    base.current = { time: reported, at: performance.now(), playing, rate }
    setTime(reported)
  }, [reported, playing, rate])

  useEffect(() => {
    if (!playing) return
    let frame = 0
    let last = 0
    const tick = (now: number): void => {
      if (now - last >= 1000 / fps) {
        last = now
        setTime(estimatePosition(base.current, now, duration))
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, duration, fps])

  return { time, duration }
}
