import { ChangeEvent, useCallback, useRef, useState } from 'react'

/**
 * A position slider that seeks once, where it is let go. Following every pixel of a drag seeked the player dozens of
 * times a second (and sent as many commands to a phone being driven remotely). While the slider is held it shows
 * where it would go; a click on the track, or the arrow keys on a focused slider, still seek at once.
 */
export function useScrub(
  time: number,
  commit: (seconds: number) => void
): { value: number; onPointerDown: () => void; onChange: (e: ChangeEvent<HTMLInputElement>) => void } {
  const [held, setHeld] = useState<number | null>(null)
  const pressed = useRef(false)
  const latest = useRef<number | null>(null)
  const commitRef = useRef(commit)
  commitRef.current = commit

  // Released anywhere, even off the slider: the drag ends there.
  const release = useCallback(() => {
    pressed.current = false
    const seconds = latest.current
    latest.current = null
    setHeld(null)
    if (seconds !== null) commitRef.current(seconds)
  }, [])

  return {
    value: held ?? time,
    onPointerDown: () => {
      pressed.current = true
      window.addEventListener('pointerup', release, { once: true })
    },
    onChange: (e) => {
      const seconds = Number(e.target.value)
      if (pressed.current) {
        latest.current = seconds
        setHeld(seconds)
      } else {
        commitRef.current(seconds)
      }
    }
  }
}
