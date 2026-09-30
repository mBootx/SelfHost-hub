import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { LayoutChangeEvent, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { LyricLine, activeLineIndex } from '@/services/lyrics'
import { usePlayhead } from '@/hooks/usePlayhead'

export type LyricsVariant = 'card' | 'full'

/** How big the lines are and where the sung one sits: the card is a small window, the full page is the screen. */
const METRICS = {
  card: { fontSize: 21, lineHeight: 28, gap: 10, align: 0 },
  full: { fontSize: 30, lineHeight: 38, gap: 22, align: 0.3 }
} as const

/** After the full page is scrolled by hand, the lyrics stay where they were put for this long. */
const HOLD_MS = 4000

type LineState = 'past' | 'active' | 'upcoming'

/**
 * One line, memoised: the playhead ticks four times a second, but only the two lines whose state flips need
 * to redraw. Size never changes with the state (only the brightness), so nothing below it reflows.
 */
const Line = memo(function Line({
  index,
  text,
  state,
  variant,
  onPress,
  onLayout
}: {
  index: number
  text: string
  state: LineState
  variant: LyricsVariant
  onPress?: (index: number) => void
  onLayout: (index: number, y: number) => void
}) {
  const m = METRICS[variant]
  const label = (
    <Text
      style={[
        styles.line,
        { fontSize: m.fontSize, lineHeight: m.lineHeight, marginBottom: m.gap },
        state === 'active' ? styles.active : state === 'past' ? styles.past : styles.upcoming
      ]}
    >
      {text || '♪'}
    </Text>
  )
  const measure = (e: LayoutChangeEvent): void => onLayout(index, e.nativeEvent.layout.y)
  if (!onPress) return <View onLayout={measure}>{label}</View>
  return (
    <Pressable onLayout={measure} onPress={() => onPress(index)} accessibilityRole="button" accessibilityLabel={text || 'Passage instrumental'}>
      {label}
    </Pressable>
  )
})

interface Props {
  lines: LyricLine[]
  variant: LyricsVariant
  /** Tapping a line seeks to it. Only the full page is interactive; the card is one big button. */
  onSeek?: (seconds: number) => void
  /** Room under the last line for whatever floats over the bottom of the page. */
  bottomInset?: number
}

/** Synced lyrics that follow the playhead: the sung line is bright, the rest dimmer, and the list scrolls with it. */
export default function LyricLines({ lines, variant, onSeek, bottomInset = 0 }: Props) {
  const m = METRICS[variant]
  const { currentTime } = usePlayhead()
  const index = activeLineIndex(lines, currentTime)

  const scroll = useRef<ScrollView>(null)
  // Measured per line rather than assumed: long lines wrap and would drift a fixed row height out of sync.
  const offsets = useRef<number[]>([])
  const holdUntil = useRef(0)
  const jumped = useRef(false)
  const [viewport, setViewport] = useState(0)
  const [measured, setMeasured] = useState(false)
  const linesRef = useRef(lines)
  linesRef.current = lines

  useEffect(() => {
    if (!measured || viewport === 0 || Date.now() < holdUntil.current) return
    const y = index < 0 ? 0 : offsets.current[index]
    if (y === undefined) return
    // The first placement (opening the page part-way through the song) jumps; after that it glides.
    scroll.current?.scrollTo({ y: Math.max(0, y - viewport * m.align), animated: jumped.current })
    jumped.current = true
  }, [index, measured, viewport, m.align])

  const handleLayout = useCallback(
    (i: number, y: number) => {
      offsets.current[i] = y
      if (i === linesRef.current.length - 1) setMeasured(true)
    },
    []
  )
  const handlePress = useCallback(
    (i: number) => {
      const line = linesRef.current[i]
      if (line) onSeek?.(line.time)
    },
    [onSeek]
  )
  const hold = (): void => {
    holdUntil.current = Date.now() + HOLD_MS
  }

  const list = (
    <ScrollView
      ref={scroll}
      scrollEnabled={variant === 'full'}
      showsVerticalScrollIndicator={false}
      onLayout={(e) => setViewport(e.nativeEvent.layout.height)}
      onScrollBeginDrag={hold}
      onMomentumScrollEnd={hold}
      contentContainerStyle={{ paddingTop: 8, paddingBottom: Math.max(0, viewport * (1 - m.align) - m.lineHeight) + bottomInset }}
    >
      {lines.map((line, i) => (
        <Line
          key={`${line.time}-${i}`}
          index={i}
          text={line.text}
          state={i === index ? 'active' : i < index ? 'past' : 'upcoming'}
          variant={variant}
          onPress={variant === 'full' && onSeek ? handlePress : undefined}
          onLayout={handleLayout}
        />
      ))}
    </ScrollView>
  )

  return variant === 'card' ? (
    <View style={styles.fill} pointerEvents="none">
      {list}
    </View>
  ) : (
    list
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  line: { fontWeight: '800' },
  active: { color: '#ffffff' },
  upcoming: { color: 'rgba(255,255,255,0.5)' },
  past: { color: 'rgba(255,255,255,0.3)' }
})
