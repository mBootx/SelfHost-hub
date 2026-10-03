import { useRef } from 'react'
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native'

type IconComponent = React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>

/** How long a finger must stay on the button. Long enough that brushing it, or a swipe across it, does nothing. */
export const HOLD_MS = 300

/**
 * A big button of the car screen that acts when held a moment, not at the first touch: the fill shows the hold, and a
 * finger that slides off before it is full cancels it (the touch then no longer counts as a press).
 */
export default function HoldButton({
  icon: Icon,
  label,
  onActivate,
  primary = false,
  accent
}: {
  icon: IconComponent
  label: string
  onActivate: () => void
  primary?: boolean
  accent: string
}) {
  const fill = useRef(new Animated.Value(0)).current

  function start(): void {
    fill.stopAnimation()
    fill.setValue(0)
    Animated.timing(fill, { toValue: 1, duration: HOLD_MS, easing: Easing.linear, useNativeDriver: false }).start()
  }

  function stop(): void {
    fill.stopAnimation()
    Animated.timing(fill, { toValue: 0, duration: 150, useNativeDriver: false }).start()
  }

  const width = fill.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] })
  const color = primary ? '#000000' : '#ffffff'

  return (
    <Pressable
      onPressIn={start}
      onPressOut={stop}
      onLongPress={onActivate}
      delayLongPress={HOLD_MS}
      style={({ pressed }) => [styles.button, primary && { backgroundColor: accent }, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Maintenir un instant"
      // A screen reader's double tap counts as the press.
      onAccessibilityAction={(e) => e.nativeEvent.actionName === 'activate' && onActivate()}
      accessibilityActions={[{ name: 'activate' }]}
    >
      <Animated.View style={[styles.fill, { width, backgroundColor: primary ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.22)' }]} />
      <View style={styles.content}>
        <Icon size={40} color={color} strokeWidth={2.4} />
        <Text style={[styles.label, { color }]} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    flex: 1,
    height: 88,
    borderRadius: 20,
    backgroundColor: '#1f1f1f',
    borderWidth: 2,
    borderColor: '#3a3a3a',
    overflow: 'hidden',
    justifyContent: 'center'
  },
  pressed: { borderColor: '#ffffff' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  content: { alignItems: 'center', justifyContent: 'center', gap: 2 },
  label: { fontSize: 13, fontWeight: '800', letterSpacing: 0.5 }
})
