import { useEffect, useRef, useState } from 'react'
import { Animated, StyleSheet, View } from 'react-native'
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg'
import type { Look } from '@/services/coverColor'

let nextId = 0

type Colours = Pick<Look, 'top' | 'middle' | 'bottom' | 'glow'>

function Gradient({ top, middle, bottom, glow }: Colours) {
  // Gradients are looked up by id, so the two alive during a cross-fade must not share one.
  const [id] = useState(() => `nowplaying-${nextId++}`)
  return (
    <Svg width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={top} />
          <Stop offset="0.55" stopColor={middle} />
          <Stop offset="1" stopColor={bottom} />
        </LinearGradient>
        {glow && (
          // The cover's second colour, from the top right corner, fading out before the middle of the screen.
          <RadialGradient id={`${id}-glow`} cx="1" cy="0" rx="0.95" ry="0.55" fx="1" fy="0" gradientUnits="objectBoundingBox">
            <Stop offset="0" stopColor={glow} stopOpacity={0.85} />
            <Stop offset="0.6" stopColor={glow} stopOpacity={0.25} />
            <Stop offset="1" stopColor={glow} stopOpacity={0} />
          </RadialGradient>
        )}
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      {glow && <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id}-glow)`} />}
    </Svg>
  )
}

const same = (a: Colours, b: Colours): boolean => a.top === b.top && a.middle === b.middle && a.bottom === b.bottom && a.glow === b.glow

/** The colours behind the whole screen, the cover's. When the cover changes, the new ones fade in over the old. */
export default function Backdrop({ look }: { look: Look }) {
  const [current, setCurrent] = useState<Colours>(look)
  const [previous, setPrevious] = useState<Colours | null>(null)
  const fade = useRef(new Animated.Value(1)).current

  useEffect(() => {
    if (same(look, current)) return
    setPrevious(current)
    setCurrent(look)
    fade.setValue(0)
    Animated.timing(fade, { toValue: 1, duration: 500, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setPrevious(null)
    })
  }, [look, current, fade])

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {previous && (
        <View style={StyleSheet.absoluteFill}>
          <Gradient {...previous} />
        </View>
      )}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: fade }]}>
        <Gradient {...current} />
      </Animated.View>
    </View>
  )
}
