import { useEffect, useRef, useState } from 'react'
import { Animated, StyleSheet, View } from 'react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { colors } from '@/constants/theme'
import type { Look } from '@/services/coverColor'

let nextId = 0

function Gradient({ top, middle }: Pick<Look, 'top' | 'middle'>) {
  // Gradients are looked up by id, so the two alive during a cross-fade must not share one.
  const [id] = useState(() => `nowplaying-${nextId++}`)
  return (
    <Svg width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={top} />
          <Stop offset="0.55" stopColor={middle} />
          <Stop offset="1" stopColor={colors.base} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  )
}

/** The colour behind the whole screen. When the cover changes, the new colour fades in over the old one. */
export default function Backdrop({ look }: { look: Look }) {
  const [current, setCurrent] = useState(look)
  const [previous, setPrevious] = useState<Look | null>(null)
  const fade = useRef(new Animated.Value(1)).current

  useEffect(() => {
    if (look.top === current.top && look.middle === current.middle) return
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
          <Gradient top={previous.top} middle={previous.middle} />
        </View>
      )}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: fade }]}>
        <Gradient top={current.top} middle={current.middle} />
      </Animated.View>
    </View>
  )
}
