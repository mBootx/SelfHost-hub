import { useEffect, useRef, useState } from 'react'
import { View, PanResponder, Vibration, StyleSheet, GestureResponderEvent } from 'react-native'
import Svg, { Circle, Line } from 'react-native-svg'
import { colors } from '@/constants/theme'

export const PATTERN_MIN_DOTS = 4

interface Props {
  /** Called when the finger lifts, with the dots in the order they were joined (0-8, row by row). */
  onComplete: (dots: number[]) => void
  disabled?: boolean
  /** Bumped by the parent after a wrong pattern: shows it in red for a moment, then clears it. */
  errorKey?: number
  size?: number
}

interface Point {
  x: number
  y: number
}

const ERROR_SHOWN_MS = 700

/** The dot a straight line from a to b jumps over (0 to 2 passes 1): joined too, as on Android. */
function between(a: number, b: number): number | null {
  const [ra, ca, rb, cb] = [Math.floor(a / 3), a % 3, Math.floor(b / 3), b % 3]
  if ((ra + rb) % 2 !== 0 || (ca + cb) % 2 !== 0) return null
  const middle = ((ra + rb) / 2) * 3 + (ca + cb) / 2
  return middle === a || middle === b ? null : middle
}

export default function PatternPad({ onComplete, disabled = false, errorKey = 0, size = 280 }: Props) {
  const cell = size / 3
  const hitRadius = cell * 0.32
  const centers: Point[] = Array.from({ length: 9 }, (_, i) => ({ x: ((i % 3) + 0.5) * cell, y: (Math.floor(i / 3) + 0.5) * cell }))

  const [dots, setDots] = useState<number[]>([])
  const [finger, setFinger] = useState<Point | null>(null)
  const [showError, setShowError] = useState(false)

  // The responder is created once, so it reads everything through refs.
  const dotsRef = useRef<number[]>([])
  const drawing = useRef(false)
  const live = useRef({ disabled, onComplete, centers, hitRadius })
  live.current = { disabled, onComplete, centers, hitRadius }

  useEffect(() => {
    if (errorKey === 0) return
    setShowError(true)
    Vibration.vibrate(120)
    const id = setTimeout(() => {
      setShowError(false)
      // A new attempt may already be under way.
      if (drawing.current) return
      dotsRef.current = []
      setDots([])
    }, ERROR_SHOWN_MS)
    return () => clearTimeout(id)
  }, [errorKey])

  function track(event: GestureResponderEvent): void {
    const point = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }
    setFinger(point)
    const { centers: c, hitRadius: r } = live.current
    const hit = c.findIndex((center) => Math.hypot(center.x - point.x, center.y - point.y) <= r)
    if (hit === -1 || dotsRef.current.includes(hit)) return
    const next = [...dotsRef.current]
    const last = next[next.length - 1]
    const skipped = last === undefined ? null : between(last, hit)
    if (skipped !== null && !next.includes(skipped)) next.push(skipped)
    next.push(hit)
    dotsRef.current = next
    setDots(next)
    Vibration.vibrate(8)
  }

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !live.current.disabled,
      onMoveShouldSetPanResponder: () => !live.current.disabled,
      // Keeps a scroll view or the modal from stealing the drawing halfway.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        drawing.current = true
        setShowError(false)
        dotsRef.current = []
        setDots([])
        track(event)
      },
      onPanResponderMove: (event) => track(event),
      onPanResponderRelease: () => {
        drawing.current = false
        setFinger(null)
        const drawn = dotsRef.current
        if (drawn.length > 0) live.current.onComplete(drawn)
      },
      onPanResponderTerminate: () => {
        drawing.current = false
        setFinger(null)
        dotsRef.current = []
        setDots([])
      }
    })
  ).current

  const stroke = showError ? colors.danger : colors.accent
  const last = dots[dots.length - 1]

  return (
    <View style={[{ width: size, height: size }, disabled && styles.disabled]} {...responder.panHandlers}>
      {/* The drawing ignores touches, so every touch position is measured against the pad itself. */}
      <Svg width={size} height={size} pointerEvents="none">
        {dots.slice(1).map((dot, i) => (
          <Line
            key={`${dots[i]}-${dot}`}
            x1={centers[dots[i]].x}
            y1={centers[dots[i]].y}
            x2={centers[dot].x}
            y2={centers[dot].y}
            stroke={stroke}
            strokeWidth={6}
            strokeLinecap="round"
            strokeOpacity={0.7}
          />
        ))}
        {finger && last !== undefined && (
          <Line
            x1={centers[last].x}
            y1={centers[last].y}
            x2={finger.x}
            y2={finger.y}
            stroke={stroke}
            strokeWidth={6}
            strokeLinecap="round"
            strokeOpacity={0.4}
          />
        )}
        {centers.map((center, i) => {
          const selected = dots.includes(i)
          return (
            <Circle
              key={i}
              cx={center.x}
              cy={center.y}
              r={selected ? 11 : 7}
              fill={selected ? stroke : colors.textSecondary}
            />
          )
        })}
        {centers.map((center, i) =>
          dots.includes(i) ? (
            <Circle key={`ring-${i}`} cx={center.x} cy={center.y} r={24} fill={stroke} fillOpacity={0.15} />
          ) : null
        )}
      </Svg>
    </View>
  )
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.4 }
})
