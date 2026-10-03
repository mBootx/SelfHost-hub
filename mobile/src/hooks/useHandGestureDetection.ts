import { useEffect, useRef, useState } from 'react'
import { createGestureRecognizer, GestureEvent, GestureRecognizer, HandPose } from '@/services/gestureRecognizer'
import { fpsFor, useCarModeStore } from '@/store/carModeStore'
import SelfHostNative from '../../modules/selfhost-native'

/** 'unavailable': this build of the app has no hand tracking. */
export type TrackerStatus = 'off' | 'starting' | 'running' | 'error' | 'unavailable'

export interface HandDetection {
  status: TrackerStatus
  error: string | null
  isHand: boolean
  pose: HandPose | null
  /** Frames analysed a second, as measured. */
  fps: number
  /** The landmarker's average time per frame, in milliseconds (the test mode shows it). */
  processingMs: number
  /** The picture's size and the points of every hand in it, for the test mode's drawing (null outside it). */
  view: { width: number; height: number; hands: number[][] } | null
}

const IDLE = { isHand: false, pose: null, fps: 0, processingMs: 0, view: null }

/** How often the screen is told what the camera sees: often enough to draw the hand in test mode, rarely otherwise. */
const PUBLISH_TEST_MS = 80
const PUBLISH_MS = 300

/**
 * Runs the front camera and the gesture recognizer while `active` (the car screen is up, the app on screen and
 * unlocked, the camera allowed) and calls `onGesture` for each gesture. Stops the camera as soon as `active` goes false
 * or the screen goes away, so it is never left running.
 */
export function useHandGestureDetection(active: boolean, onGesture: (event: GestureEvent) => void): HandDetection {
  const thresholds = useCarModeStore((s) => s.gestureThresholds)
  const gestures = useCarModeStore((s) => s.gestures)
  const batterySaver = useCarModeStore((s) => s.batterySaver)
  const testMode = useCarModeStore((s) => s.testMode)
  const setCameraActive = useCarModeStore((s) => s.setCameraActive)

  const available = typeof SelfHostNative?.startHandTracking === 'function' && typeof SelfHostNative?.addListener === 'function'
  const [status, setStatus] = useState<TrackerStatus>(available ? 'off' : 'unavailable')
  const [error, setError] = useState<string | null>(null)
  const [seen, setSeen] = useState<Omit<HandDetection, 'status' | 'error'>>(IDLE)

  const recognizer = useRef<GestureRecognizer | null>(null)
  const onGestureRef = useRef(onGesture)
  const testModeRef = useRef(testMode)
  useEffect(() => {
    onGestureRef.current = onGesture
    testModeRef.current = testMode
  })

  const fps = fpsFor(batterySaver)
  const fpsRef = useRef(fps)

  useEffect(() => {
    recognizer.current?.setOptions({ thresholds, enabled: gestures })
  }, [thresholds, gestures])

  useEffect(() => {
    if (!available) {
      setStatus('unavailable')
      return
    }
    if (!active) {
      setStatus('off')
      return
    }
    const native = SelfHostNative!
    const rec = createGestureRecognizer({ thresholds: useCarModeStore.getState().gestureThresholds, enabled: useCarModeStore.getState().gestures })
    recognizer.current = rec
    const times: number[] = []
    let msTotal = 0
    let msCount = 0
    let publishedAt = 0

    const frames = native.addListener!('onHandFrame', (frame) => {
      const event = rec.push(frame)
      if (event) onGestureRef.current(event)
      times.push(frame.t)
      while (times.length > 1 && times[0] < frame.t - 2000) times.shift()
      msTotal += frame.ms
      msCount++
      const now = Date.now()
      if (!event && now - publishedAt < (testModeRef.current ? PUBLISH_TEST_MS : PUBLISH_MS)) return
      publishedAt = now
      const state = rec.state()
      const span = times[times.length - 1] - times[0]
      setSeen({
        isHand: state.present,
        pose: state.pose,
        fps: span > 0 ? Math.round(((times.length - 1) * 1000) / span) : 0,
        processingMs: msCount > 0 ? Math.round(msTotal / msCount) : 0,
        view: testModeRef.current ? { width: frame.width, height: frame.height, hands: frame.hands.map((h) => h.points) } : null
      })
      msTotal = 0
      msCount = 0
    })
    const states = native.addListener!('onHandTrackerState', ({ state, error: message }) => {
      if (state === 'running') {
        setStatus('running')
        setError(null)
        setCameraActive(true)
      } else if (state === 'error') {
        setStatus('error')
        setError(message || 'Caméra indisponible')
        setCameraActive(false)
      } else {
        setStatus('off')
        setCameraActive(false)
      }
    })

    setStatus('starting')
    setError(null)
    fpsRef.current = fpsFor(useCarModeStore.getState().batterySaver)
    if (!native.startHandTracking!(fpsRef.current)) {
      setStatus('error')
      setError("La caméra n'a pas pu démarrer")
    }

    return () => {
      frames.remove()
      states.remove()
      native.stopHandTracking?.()
      rec.reset()
      recognizer.current = null
      setCameraActive(false)
      setSeen(IDLE)
    }
  }, [active, available, setCameraActive])

  // The battery setting changes the frame rate of the camera already running, without restarting it.
  useEffect(() => {
    if (!active || !available || fpsRef.current === fps) return
    fpsRef.current = fps
    SelfHostNative?.startHandTracking?.(fps)
  }, [fps, active, available])

  return { status, error, ...seen }
}
