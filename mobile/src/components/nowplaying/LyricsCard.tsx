import { RefObject } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { Maximize2, MicVocal, Sparkles } from 'lucide-react-native'
import EdgeFade from './EdgeFade'
import LyricLines from './LyricLines'
import type { LyricLine } from '@/services/lyrics'
import type { Look } from '@/services/coverColor'
import { radius, spacing } from '@/constants/theme'

/** How much of the lyrics the card shows: about five lines of the song. */
const WINDOW_HEIGHT = 190

interface Props {
  look: Look
  lines: LyricLine[] | null
  plain: string | null
  loading: boolean
  searching: boolean
  onOpen: () => void
  onAutoSearch: () => void
  /** So the screen can measure where the card is and grow the full page out of it. */
  cardRef: RefObject<View | null>
}

/**
 * The lyrics widget under the player: a card in the cover's colour showing the lines around the one being
 * sung. Tapping it opens the full lyrics page, which grows out of the card.
 */
export default function LyricsCard({ look, lines, plain, loading, searching, onOpen, onAutoSearch, cardRef }: Props) {
  const hasLyrics = !!(lines || plain)

  return (
    <Pressable
      ref={cardRef}
      collapsable={false}
      onPress={hasLyrics ? onOpen : undefined}
      style={[styles.card, { backgroundColor: look.card }]}
      accessibilityRole="button"
      accessibilityLabel="Paroles. Afficher en plein écran"
    >
      <View style={styles.header}>
        <Text style={styles.title}>Paroles</Text>
        {hasLyrics && (
          <View style={styles.expand}>
            <Maximize2 size={15} color="#ffffff" />
          </View>
        )}
      </View>

      <View style={styles.window}>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color="#ffffff" />
          </View>
        ) : lines ? (
          <LyricLines lines={lines} variant="card" />
        ) : plain ? (
          <Text style={styles.plain} numberOfLines={6}>
            {plain}
          </Text>
        ) : (
          <View style={styles.center}>
            <MicVocal size={26} color="rgba(255,255,255,0.75)" />
            <Text style={styles.emptyTitle}>Aucune parole trouvée</Text>
            <Pressable
              style={({ pressed }) => [styles.searchButton, { backgroundColor: look.accent }, (searching || pressed) && styles.pressed]}
              onPress={onAutoSearch}
              disabled={searching}
              accessibilityRole="button"
              accessibilityLabel="Recherche automatique"
            >
              {searching ? (
                <ActivityIndicator color={look.onAccent} />
              ) : (
                <>
                  <Sparkles size={15} color={look.onAccent} />
                  <Text style={[styles.searchButtonText, { color: look.onAccent }]}>Recherche auto</Text>
                </>
              )}
            </Pressable>
          </View>
        )}
        {/* The lyrics melt into the card at the bottom, so the last line isn't cut in half. */}
        {hasLyrics && !loading && <EdgeFade color={look.card} edge="bottom" size={56} id="lyrics-card-fade" />}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, paddingHorizontal: spacing.xl - 4, paddingTop: spacing.lg, paddingBottom: spacing.lg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  title: { color: '#ffffff', fontSize: 16, fontWeight: '800' },
  expand: { width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(0,0,0,0.25)', alignItems: 'center', justifyContent: 'center' },
  window: { height: WINDOW_HEIGHT, overflow: 'hidden' },
  plain: { color: 'rgba(255,255,255,0.9)', fontSize: 21, lineHeight: 28, fontWeight: '800' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  emptyTitle: { color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: '600' },
  searchButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radius.full,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 2,
    marginTop: spacing.xs
  },
  searchButtonText: { fontWeight: '700', fontSize: 14 },
  pressed: { opacity: 0.6 }
})
