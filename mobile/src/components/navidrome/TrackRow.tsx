import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Play, X } from 'lucide-react-native'
import { NavidromeClient, NDSong } from '@/services/navidrome'
import { useTrackSheetStore } from '@/store/trackSheetStore'
import CoverImage from '@/components/CoverImage'
import EqualizerBars from './EqualizerBars'
import OfflineButton from './OfflineButton'
import { colors, radius, spacing } from '@/constants/theme'

interface Props {
  song: NDSong
  client: NavidromeClient
  isCurrent: boolean
  isPlaying: boolean
  onPress: () => void
  showArtist?: boolean
  /** Only passed by a playlist's own track list - renders a trailing remove button. */
  onRemove?: () => void
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function TrackRow({ song, client, isCurrent, isPlaying, onPress, showArtist, onRemove }: Props) {
  const openSheet = useTrackSheetStore((s) => s.open)
  const coverId = song.coverArt || song.albumId

  return (
    <Pressable
      style={({ pressed }) => [styles.row, isCurrent && styles.rowActive, pressed && styles.pressed]}
      onPress={onPress}
      onLongPress={() => openSheet(song)}
      delayLongPress={300}
      accessibilityRole="button"
      accessibilityLabel={`${song.title}, ${song.artist}`}
      accessibilityHint="Appui long pour les options de file de lecture"
    >
      <View style={styles.thumbWrap}>
        <CoverImage
          uri={coverId ? client.coverArtUrl(coverId, 100) : null}
          style={styles.thumb}
          iconSize={16}
          recyclingKey={song.id}
        />
        {isCurrent && (
          <View style={styles.overlay}>{isPlaying ? <EqualizerBars /> : <Play size={14} color="#fff" fill="#fff" />}</View>
        )}
      </View>
      <View style={styles.info}>
        <Text style={[styles.title, isCurrent && styles.titleActive]} numberOfLines={1}>
          {song.title}
        </Text>
        {showArtist !== false && (
          <Text style={styles.artist} numberOfLines={1}>
            {song.artist}
          </Text>
        )}
      </View>
      <Text style={styles.duration}>{formatDuration(song.duration)}</Text>
      <OfflineButton song={song} client={client} />
      {onRemove && (
        <Pressable onPress={onRemove} hitSlop={10} accessibilityRole="button" accessibilityLabel="Retirer de la playlist">
          <X size={16} color={colors.textMuted} />
        </Pressable>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.sm
  },
  rowActive: { backgroundColor: colors.raised },
  pressed: { opacity: 0.6 },
  thumbWrap: { width: 44, height: 44, borderRadius: radius.sm, overflow: 'hidden' },
  thumb: { width: '100%', height: '100%' },
  overlay: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  info: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 14, fontWeight: '500' },
  titleActive: { color: colors.accent },
  artist: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  duration: { color: colors.textMuted, fontSize: 12 }
})
