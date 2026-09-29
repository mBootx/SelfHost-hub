import { useEffect } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet } from 'react-native'
import { useNavigation } from 'expo-router'
import { Download, X } from 'lucide-react-native'
import { useDowntifyStore } from '@/store/downtifyStore'
import CoverImage from '@/components/CoverImage'
import { EmptyState } from '@/components/Screen'
import { colors, layout, radius, spacing } from '@/constants/theme'

function statusLabel(status: string): string {
  if (status === 'done') return 'Terminé'
  if (status === 'error') return 'Erreur'
  if (status === 'queued') return 'En attente'
  if (status === 'downloading') return 'En cours'
  return status
}

export default function DowntifyQueueScreen() {
  const navigation = useNavigation()
  const queue = useDowntifyStore((s) => s.queue)
  const refreshQueue = useDowntifyStore((s) => s.refreshQueue)
  const cancelQueueItem = useDowntifyStore((s) => s.cancelQueueItem)
  const clearQueue = useDowntifyStore((s) => s.clearQueue)

  useEffect(() => {
    navigation.setOptions({ title: 'Téléchargements' })
    refreshQueue()
  }, [])

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.content}
      data={queue}
      keyExtractor={(q) => q.song.song_id}
      showsVerticalScrollIndicator={false}
      ListHeaderComponent={
        queue.length > 0 ? (
          <Pressable
            onPress={() => clearQueue()}
            style={({ pressed }) => [styles.clearButton, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Vider la file"
          >
            <Text style={styles.clearText}>Tout effacer</Text>
          </Pressable>
        ) : null
      }
      ListEmptyComponent={
        <EmptyState icon={Download} title="File vide" hint="Lancez un téléchargement depuis l'onglet Recherche." />
      }
      renderItem={({ item }) => (
        <View style={styles.card}>
          <View style={styles.row}>
            <CoverImage uri={item.song.cover_url} style={styles.cover} iconSize={16} recyclingKey={item.song.song_id} />
            <View style={styles.info}>
              <Text style={styles.title} numberOfLines={1}>
                {item.song.name}
              </Text>
              <Text style={styles.artist} numberOfLines={1}>
                {item.song.artists.join(', ')}
              </Text>
            </View>
            <Text style={[styles.status, item.status === 'error' && styles.statusError]}>{statusLabel(item.status)}</Text>
            <Pressable
              onPress={() => cancelQueueItem(item.song.song_id)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Retirer ${item.song.name}`}
            >
              <X size={16} color={colors.textMuted} />
            </Pressable>
          </View>
          {item.status === 'downloading' && (
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.min(100, item.progress)}%` }]} />
            </View>
          )}
          {item.status === 'error' && !!item.message && (
            <Text style={styles.message} numberOfLines={2}>
              {item.message}
            </Text>
          )}
        </View>
      )}
    />
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.base },
  content: { paddingHorizontal: spacing.lg, paddingBottom: layout.contentBottom },
  clearButton: { alignSelf: 'flex-end', marginBottom: spacing.sm },
  clearText: { color: colors.textMuted, fontSize: 12 },
  pressed: { opacity: 0.6 },
  card: { backgroundColor: colors.elevated, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  cover: { width: 44, height: 44, borderRadius: radius.sm },
  info: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 14, fontWeight: '500' },
  artist: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  status: { color: colors.textSecondary, fontSize: 11 },
  statusError: { color: colors.danger },
  track: { height: 4, borderRadius: radius.full, backgroundColor: colors.hover, overflow: 'hidden', marginTop: spacing.sm },
  fill: { height: 4, backgroundColor: colors.downtify },
  message: { color: colors.danger, fontSize: 11, marginTop: spacing.xs }
})
