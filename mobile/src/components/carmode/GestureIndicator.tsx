import { useEffect, useRef, useState } from 'react'
import { Animated, Easing, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native'
import { Hand, Heart, Pause, SkipBack, SkipForward, Volume1, Volume2 } from 'lucide-react-native'
import type { GestureName } from '@/services/gestureRecognizer'

type IconComponent = React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>

/** Each gesture: what it does, how it is made (for the hints), its icon, and its name with an arrow (the small print). */
export const GESTURE_INFO: Record<GestureName, { action: string; how: string; icon: IconComponent; tag: string }> = {
  PINCH: { action: 'Lecture / pause', how: 'Pincer pouce et index', icon: Pause, tag: 'PINCH' },
  WAVE_RIGHT: { action: 'Suivant', how: 'Main vers la droite', icon: SkipForward, tag: 'WAVE_RIGHT ➜' },
  WAVE_LEFT: { action: 'Précédent', how: 'Main vers la gauche', icon: SkipBack, tag: '⬅ WAVE_LEFT' },
  PALM_UP: { action: 'Volume +', how: 'Main ouverte en haut', icon: Volume2, tag: 'PALM_UP ⬆' },
  PALM_DOWN: { action: 'Volume −', how: 'Main ouverte en bas', icon: Volume1, tag: 'PALM_DOWN ⬇' },
  THUMB_UP: { action: "J'aime", how: 'Pouce levé', icon: Heart, tag: 'THUMB_UP' }
}

const LABEL_SIZE = 80

/**
 * The label's size: as big as 80 when it fits on one line across `width`, smaller for a longer one ("Lecture / pause").
 * A bold capital-and-lowercase line is about 0.6 of its size wide per character.
 */
export function labelSize(text: string, width: number): number {
  if (width <= 0 || text.length === 0) return LABEL_SIZE
  return Math.max(28, Math.min(LABEL_SIZE, Math.floor((width - 32) / (text.length * 0.6))))
}

/** How far the icon of a wave travels, the way the hand went. */
const ARROW_TRAVEL = 28
/** Shown at full strength for a moment, then faded out: gone by the end of the second the store keeps it. */
const HOLD_MS = 250
const FADE_MS = 750

/**
 * The gesture just recognised, big in the middle of the car screen: its icon, what it did, and how sure the camera was.
 * It shows at full strength and fades out over a second; the icon of a wave or a volume step slides the way the hand
 * went. `count` changes at every gesture, so the same gesture twice shows twice.
 */
export default function GestureIndicator({
  gesture,
  count,
  label,
  outcome,
  confidence,
  showConfidence,
  color = '#ffffff',
  style
}: {
  gesture: GestureName | null
  count: number
  /** What it did, when that is more precise than the gesture's own action ("Pause" rather than "Lecture / pause"). */
  label?: string | null
  /** What came of it ("Volume 60 %", "Ajouté aux favoris"). */
  outcome?: string | null
  confidence: number
  showConfidence: boolean
  color?: string
  /** Laid over what it covers (a dark backdrop, say), which fades out with it. */
  style?: StyleProp<ViewStyle>
}) {
  const opacity = useRef(new Animated.Value(0)).current
  const slide = useRef(new Animated.Value(0)).current
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (count === 0) return
    opacity.stopAnimation()
    slide.stopAnimation()
    opacity.setValue(1)
    slide.setValue(0)
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: FADE_MS, delay: HOLD_MS, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      Animated.timing(slide, { toValue: 1, duration: 450, easing: Easing.out(Easing.cubic), useNativeDriver: true })
    ]).start()
  }, [count])

  // The store forgets the gesture once its second is up, by when it has faded out.
  const current = gesture
  if (!current) return null
  const info = GESTURE_INFO[current]
  const Icon = info.icon
  const dx = current === 'WAVE_RIGHT' ? ARROW_TRAVEL : current === 'WAVE_LEFT' ? -ARROW_TRAVEL : 0
  const dy = current === 'PALM_UP' ? -ARROW_TRAVEL / 2 : current === 'PALM_DOWN' ? ARROW_TRAVEL / 2 : 0
  const translateX = slide.interpolate({ inputRange: [0, 1], outputRange: [-dx, dx] })
  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [-dy, dy] })
  const scale = slide.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] })
  const text = label || info.action

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.root, style, { opacity }]}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${text}${outcome ? `, ${outcome}` : ''}`}
    >
      <Animated.View style={{ transform: [{ translateX }, { translateY }, { scale }] }}>
        <Icon size={104} color={color} strokeWidth={2.2} />
      </Animated.View>
      <Text style={[styles.label, { color, fontSize: labelSize(text, width) }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.4}>
        {text}
      </Text>
      {!!outcome && (
        <Text style={[styles.outcome, { color }]} numberOfLines={1}>
          {outcome}
        </Text>
      )}
      <View style={styles.tagRow}>
        <Hand size={14} color="#d4d4d4" />
        <Text style={styles.tag}>{info.tag}</Text>
      </View>
      {showConfidence && (
        <View style={styles.bar} accessibilityLabel={`Certitude ${Math.round(confidence * 100)} %`}>
          <View style={[styles.barFill, { width: `${Math.round(Math.min(1, Math.max(0, confidence)) * 100)}%`, backgroundColor: color }]} />
        </View>
      )}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, alignSelf: 'stretch' },
  label: { fontSize: 80, fontWeight: '800', marginTop: 8, letterSpacing: -1, textAlign: 'center', alignSelf: 'stretch' },
  outcome: { fontSize: 26, fontWeight: '700', marginTop: 2 },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  tag: { color: '#d4d4d4', fontSize: 14, fontWeight: '700', letterSpacing: 1 },
  bar: { width: 160, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', marginTop: 12, overflow: 'hidden' },
  barFill: { height: 4, borderRadius: 2 }
})
