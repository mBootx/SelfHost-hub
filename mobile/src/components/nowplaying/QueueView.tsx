import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { ChevronDown, ChevronUp, X } from 'lucide-react-native'
import type { NDSong } from '@/services/navidrome'
import { colors, radius, spacing } from '@/constants/theme'

interface Props {
  queue: NDSong[]
  queueIndex: number
  /** The song playing is picked out in the cover's colour. */
  accent: string
  bottomInset: number
  onPlay: (index: number) => void
  onRemove: (index: number) => void
  onMove: (from: number, to: number) => void
  onClear: () => void
}

/** The play queue, over the same coloured backdrop as the player. Tap a row to jump to it. */
export default function QueueView({ queue, queueIndex, accent, bottomInset, onPlay, onRemove, onMove, onClear }: Props) {
  const [confirmClear, setConfirmClear] = useState(false)

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: bottomInset + spacing.xl }}>
      <View style={styles.header}>
        <Text style={styles.headerText}>
          {queue.length} {queue.length > 1 ? 'titres' : 'titre'}
        </Text>
        {queue.length > 0 &&
          (confirmClear ? (
            <View style={styles.confirmRow}>
              <Text style={styles.confirmText}>Vider ?</Text>
              <Pressable
                onPress={() => {
                  onClear()
                  setConfirmClear(false)
                }}
                hitSlop={8}
              >
                <Text style={styles.confirmYes}>Oui</Text>
              </Pressable>
              <Pressable onPress={() => setConfirmClear(false)} hitSlop={8}>
                <Text style={styles.confirmCancel}>Annuler</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={() => setConfirmClear(true)} hitSlop={8}>
              <Text style={styles.clearLink}>Vider</Text>
            </Pressable>
          ))}
      </View>

      {queue.map((song, i) => (
        <View key={`${song.id}-${i}`} style={[styles.row, i === queueIndex && styles.rowActive]}>
          <Pressable style={styles.rowMain} onPress={() => onPlay(i)}>
            <Text style={[styles.rowTitle, i === queueIndex && { color: accent }]} numberOfLines={1}>
              {song.title}
            </Text>
            <Text style={styles.rowArtist} numberOfLines={1}>
              {song.artist}
            </Text>
          </Pressable>
          <Pressable onPress={() => onMove(i, i - 1)} disabled={i === 0} hitSlop={8} accessibilityLabel="Monter">
            <ChevronUp size={18} color={i === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.7)'} />
          </Pressable>
          <Pressable onPress={() => onMove(i, i + 1)} disabled={i === queue.length - 1} hitSlop={8} accessibilityLabel="Descendre">
            <ChevronDown size={18} color={i === queue.length - 1 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.7)'} />
          </Pressable>
          <Pressable onPress={() => onRemove(i)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Retirer de la file">
            <X size={18} color="rgba(255,255,255,0.7)" />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm, paddingHorizontal: spacing.sm },
  headerText: { color: 'rgba(255,255,255,0.65)', fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  clearLink: { color: 'rgba(255,255,255,0.65)', fontSize: 13, fontWeight: '700' },
  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  confirmText: { color: 'rgba(255,255,255,0.75)', fontSize: 13 },
  confirmYes: { color: colors.danger, fontSize: 13, fontWeight: '800' },
  confirmCancel: { color: 'rgba(255,255,255,0.65)', fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.sm, borderRadius: radius.md },
  rowActive: { backgroundColor: 'rgba(255,255,255,0.12)' },
  rowMain: { flex: 1, minWidth: 0 },
  rowTitle: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  rowArtist: { color: 'rgba(255,255,255,0.6)', fontSize: 13, marginTop: 1 }
})
