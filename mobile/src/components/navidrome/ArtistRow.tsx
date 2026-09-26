import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { ChevronRight, User } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { NDArtist } from '@/services/navidrome'
import CoverImage from '@/components/CoverImage'
import { colors, radius, spacing } from '@/constants/theme'

export default function ArtistRow({ artist }: { artist: NDArtist }) {
  const router = useRouter()
  const client = useNavidromeStore((s) => s.client)

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={() => router.push({ pathname: '/artist/[id]', params: { id: artist.id } })}
      accessibilityRole="button"
      accessibilityLabel={artist.name}
    >
      <CoverImage
        uri={artist.coverArt && client ? client.coverArtUrl(artist.coverArt, 100) : null}
        style={styles.avatar}
        icon={User}
        iconSize={20}
        recyclingKey={artist.id}
      />
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>
          {artist.name}
        </Text>
        {!!artist.albumCount && <Text style={styles.meta}>{artist.albumCount} albums</Text>}
      </View>
      <ChevronRight size={18} color={colors.textMuted} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  pressed: { opacity: 0.6 },
  avatar: { width: 48, height: 48, borderRadius: radius.full },
  info: { flex: 1, minWidth: 0 },
  name: { color: colors.text, fontSize: 14, fontWeight: '600' },
  meta: { color: colors.textMuted, fontSize: 12, marginTop: 1 }
})
