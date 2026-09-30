import { StyleSheet, View } from 'react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'

/**
 * A strip along the top or bottom edge that melts into `color`, so scrolling lyrics fade out under a header or at
 * the end of a card instead of being cut in half. `id` must be unique on screen: gradients are looked up by it.
 */
export default function EdgeFade({ color, edge, size, id }: { color: string; edge: 'top' | 'bottom'; size: number; id: string }) {
  const solidAtTop = edge === 'top'
  return (
    <View pointerEvents="none" style={[styles.strip, { height: size }, edge === 'top' ? styles.top : styles.bottom]}>
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity={solidAtTop ? 1 : 0} />
            <Stop offset="1" stopColor={color} stopOpacity={solidAtTop ? 0 : 1} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  )
}

const styles = StyleSheet.create({
  strip: { position: 'absolute', left: 0, right: 0 },
  top: { top: 0 },
  bottom: { bottom: 0 }
})
