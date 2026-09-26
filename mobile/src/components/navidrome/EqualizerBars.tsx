import { useEffect, useRef } from 'react'
import { View, Animated, Easing, StyleSheet } from 'react-native'
import { colors } from '@/constants/theme'

function useBarAnimation(delay: number): Animated.Value {
  const value = useRef(new Animated.Value(0.3)).current

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: 1, duration: 450, delay, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(value, { toValue: 0.3, duration: 450, easing: Easing.inOut(Easing.ease), useNativeDriver: true })
      ])
    )
    loop.start()
    return () => loop.stop()
  }, [value, delay])

  return value
}

export default function EqualizerBars() {
  const a = useBarAnimation(0)
  const b = useBarAnimation(150)
  const c = useBarAnimation(300)

  return (
    <View style={styles.row}>
      <Animated.View style={[styles.bar, { transform: [{ scaleY: a }] }]} />
      <Animated.View style={[styles.bar, { transform: [{ scaleY: b }] }]} />
      <Animated.View style={[styles.bar, { transform: [{ scaleY: c }] }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 12 },
  bar: { width: 2.5, height: 12, backgroundColor: colors.accent, borderRadius: 1 }
})
