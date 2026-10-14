import { useCallback, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import type { NDSong } from '@/services/navidrome'
import { occurrenceKeys } from '@/services/dragMath'
import DragList from '@/components/DragList'
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

/** Every row of the queue is this high, which is what lets a row be dragged to another place. */
const ROW_HEIGHT = 60

/**
 * The play queue, over the same coloured backdrop as the player. Tap a row to jump to it; hold its grip and drag it to
 * put it elsewhere.
 */
export default function QueueView({ queue, queueIndex, accent, bottomInset, onPlay, onRemove, onMove, onClear }: Props) {
  const [confirmClear, setConfirmClear] = useState(false)
  // The same song can be in the queue twice: each keeps its own key while it moves.
  const keys = useMemo(() => occurrenceKeys(queue.map((song) => song.id)), [queue])
  const keyOf = useCallback((_song: NDSong, index: number) => keys[index], [keys])

  const header = (
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
              accessibilityRole="button"
            >
              <Text style={styles.confirmYes}>Oui</Text>
            </Pressable>
            <Pressable onPress={() => setConfirmClear(false)} hitSlop={8} accessibilityRole="button">
              <Text style={styles.confirmCancel}>Annuler</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable onPress={() => setConfirmClear(true)} hitSlop={8} accessibilityRole="button">
            <Text style={styles.clearLink}>Vider</Text>
          </Pressable>
        ))}
    </View>
  )

  return (
    <DragList
      style={styles.scroll}
      contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: bottomInset + spacing.xl }}
      items={queue}
      keyOf={keyOf}
      rowHeight={ROW_HEIGHT}
      onMove={onMove}
      header={header}
      gripColor="rgba(255,255,255,0.7)"
      activeBackground="rgba(0,0,0,0.6)"
      renderRow={(song, i, grip) => (
        <View style={[styles.row, i === queueIndex && styles.rowActive]}>
          <Pressable style={styles.rowMain} onPress={() => onPlay(i)} accessibilityRole="button" accessibilityLabel={`${song.title}, ${song.artist}`}>
            <Text style={[styles.rowTitle, i === queueIndex && { color: accent }]} numberOfLines={1}>
              {song.title}
            </Text>
            <Text style={styles.rowArtist} numberOfLines={1}>
              {song.artist}
            </Text>
          </Pressable>
          <Pressable onPress={() => onRemove(i)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Retirer de la file">
            <X size={18} color="rgba(255,255,255,0.7)" />
          </Pressable>
          {grip}
        </View>
      )}
    />
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
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingLeft: spacing.sm, borderRadius: radius.md },
  rowActive: { backgroundColor: 'rgba(255,255,255,0.12)' },
  rowMain: { flex: 1, minWidth: 0, justifyContent: 'center', alignSelf: 'stretch' },
  rowTitle: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  rowArtist: { color: 'rgba(255,255,255,0.6)', fontSize: 13, marginTop: 1 }
})
