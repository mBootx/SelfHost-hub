import { Text, Pressable, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useNavidromeStore } from '@/store/navidromeStore'
import { NDAlbum } from '@/services/navidrome'
import CoverImage from '@/components/CoverImage'
import { colors, radius, spacing } from '@/constants/theme'

/**
 * `grid` pairs with a `justifyContent: 'space-between'` row (works the same in a
 * wrapping View and in a FlatList's columnWrapperStyle); `rail` is a fixed width
 * for horizontal carousels.
 */
export default function AlbumTile({ album, variant = 'grid' }: { album: NDAlbum; variant?: 'grid' | 'rail' }) {
  const router = useRouter()
  const client = useNavidromeStore((s) => s.client)

  return (
    <Pressable
      style={({ pressed }) => [variant === 'rail' ? styles.rail : styles.grid, pressed && styles.pressed]}
      onPress={() => router.push({ pathname: '/album/[id]', params: { id: album.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${album.name}, ${album.artist}`}
    >
      <CoverImage
        uri={album.coverArt && client ? client.coverArtUrl(album.coverArt, 300) : null}
        style={styles.cover}
        recyclingKey={album.id}
      />
      <Text style={styles.title} numberOfLines={1}>
        {album.name}
      </Text>
      <Text style={styles.artist} numberOfLines={1}>
        {album.artist}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  grid: { width: '48%', marginBottom: spacing.md },
  rail: { width: 136, marginRight: spacing.md },
  pressed: { opacity: 0.6 },
  cover: { width: '100%', aspectRatio: 1, borderRadius: radius.md, marginBottom: spacing.xs },
  title: { color: colors.text, fontSize: 13, fontWeight: '600' },
  artist: { color: colors.textSecondary, fontSize: 12, marginTop: 1 }
})
