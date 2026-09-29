import { memo, useEffect, useRef, useState, RefObject } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { MicVocal, Sparkles } from 'lucide-react-native'
import { LyricLine, activeLineIndex } from '@/services/lyrics'
import { useNavidromeStore } from '@/store/navidromeStore'
import { colors, radius, spacing } from '@/constants/theme'

interface Props {
  lines: LyricLine[] | null
  plain: string | null
  loading: boolean
  searching: boolean
  onSeek: (seconds: number) => void
  onAutoSearch: () => void
  /**
   * The lyrics no longer own their own scroll viewport - they're one section of
   * the whole Now Playing page's ScrollView, so the page can grow past the
   * screen instead of squeezing everything into a fixed frame. Auto-follow
   * therefore scrolls the parent, using this section's own offset within it.
   */
  scrollRef: RefObject<ScrollView | null>
  sectionOffset: number
  viewportHeight: number
}

type LineState = 'past' | 'active' | 'upcoming'

/**
 * Memoised per line: the playhead ticks four times a second, but only the two
 * lines whose state actually flips need to redraw, not the whole lyric sheet.
 */
const Line = memo(function Line({
  text,
  state,
  onPress,
  onLayout
}: {
  text: string
  state: LineState
  onPress: () => void
  onLayout: (y: number) => void
}) {
  return (
    <Pressable
      onLayout={(e) => onLayout(e.nativeEvent.layout.y)}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={text || 'Passage instrumental'}
    >
      <Text style={[styles.line, state === 'active' ? styles.lineActive : state === 'past' && styles.linePast]}>
        {text || '♪'}
      </Text>
    </Pressable>
  )
})

export default function LyricsView({
  lines,
  plain,
  loading,
  searching,
  onSeek,
  onAutoSearch,
  scrollRef,
  sectionOffset,
  viewportHeight
}: Props) {
  const currentTime = useNavidromeStore((s) => s.currentTime)
  // Measured per line rather than assuming a fixed row height, because long
  // lines wrap and would otherwise drift the scroll position out of sync.
  const offsets = useRef<number[]>([])
  const [active, setActive] = useState(-1)

  const index = lines ? activeLineIndex(lines, currentTime) : -1

  useEffect(() => {
    if (index === active) return
    setActive(index)
    const y = offsets.current[index]
    if (y === undefined || viewportHeight === 0) return
    scrollRef.current?.scrollTo({ y: Math.max(0, sectionOffset + y - viewportHeight / 2), animated: true })
  }, [index, active, sectionOffset, viewportHeight, scrollRef])

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    )
  }

  if (!lines && !plain) {
    return (
      <View style={styles.center}>
        <View style={styles.emptyIcon}>
          <MicVocal size={26} color={colors.textMuted} />
        </View>
        <Text style={styles.emptyTitle}>Aucune parole trouvée</Text>
        <Text style={styles.emptyHint}>Lancez une recherche élargie pour retrouver les paroles et la pochette.</Text>
        <Pressable
          style={({ pressed }) => [styles.searchButton, (searching || pressed) && styles.pressed]}
          onPress={onAutoSearch}
          disabled={searching}
          accessibilityRole="button"
          accessibilityLabel="Recherche automatique"
        >
          {searching ? (
            <ActivityIndicator color="#000" />
          ) : (
            <>
              <Sparkles size={16} color="#000" />
              <Text style={styles.searchButtonText}>Recherche auto</Text>
            </>
          )}
        </Pressable>
      </View>
    )
  }

  if (!lines) {
    return (
      <View style={styles.content}>
        <Text style={styles.plain}>{plain}</Text>
      </View>
    )
  }

  return (
    <View style={styles.content}>
      {lines.map((line, i) => (
        <Line
          key={`${line.time}-${i}`}
          text={line.text}
          state={i === active ? 'active' : i < active ? 'past' : 'upcoming'}
          onPress={() => onSeek(line.time)}
          onLayout={(y) => {
            offsets.current[i] = y
          }}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  center: { minHeight: 240, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: spacing.sm },
  content: { paddingVertical: spacing.md },
  /** Dim by default, bright and larger on the line currently being sung. */
  line: { color: colors.textMuted, fontSize: 19, fontWeight: '700', lineHeight: 30, marginBottom: spacing.md },
  lineActive: { color: colors.accent, fontSize: 22, lineHeight: 33 },
  linePast: { color: colors.textSecondary },
  plain: { color: colors.textSecondary, fontSize: 15, lineHeight: 24 },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.elevated,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emptyTitle: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
  emptyHint: { color: colors.textMuted, fontSize: 12, textAlign: 'center', lineHeight: 17 },
  searchButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    marginTop: spacing.sm
  },
  searchButtonText: { color: '#000', fontWeight: '700', fontSize: 14 },
  pressed: { opacity: 0.6 }
})
