import { Text, Pressable, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { ListMusic } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { NDPlaylist } from '@/services/navidrome'
import CoverImage from '@/components/CoverImage'
import { colors, radius, spacing } from '@/constants/theme'

interface Props {
  playlist: NDPlaylist
  variant?: 'grid' | 'rail'
  onLongPress?: () => void
}

export default function PlaylistTile({ playlist, variant = 'grid', onLongPress }: Props) {
  const router = useRouter()
  const client = useNavidromeStore((s) => s.client)

  return (
    <Pressable
      style={({ pressed }) => [variant === 'rail' ? styles.rail : styles.grid, pressed && styles.pressed]}
      onPress={() => router.push({ pathname: '/playlist/[id]', params: { id: playlist.id } })}
      onLongPress={onLongPress}
      delayLongPress={300}
      accessibilityRole="button"
      accessibilityLabel={`${playlist.name}, ${playlist.songCount} titres`}
    >
      <CoverImage
        uri={playlist.coverArt && client ? client.coverArtUrl(playlist.coverArt, 300) : null}
        style={styles.cover}
        icon={ListMusic}
        recyclingKey={playlist.id}
      />
      <Text style={styles.title} numberOfLines={1}>
        {playlist.name}
      </Text>
      <Text style={styles.meta}>{playlist.songCount} titres</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  grid: { width: '48%', marginBottom: spacing.md },
  rail: { width: 136, marginRight: spacing.md },
  pressed: { opacity: 0.6 },
  cover: { width: '100%', aspectRatio: 1, borderRadius: radius.md, marginBottom: spacing.xs },
  title: { color: colors.text, fontSize: 13, fontWeight: '600' },
  meta: { color: colors.textSecondary, fontSize: 12, marginTop: 1 }
})
