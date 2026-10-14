import { useEffect, useState } from 'react'
import { View, Text, FlatList, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useNavigation } from 'expo-router'
import { User } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { NDAlbum, NDArtist } from '@/services/navidrome'
import { prefetchCoverArt } from '@/services/imagePrefetch'
import { plural } from '@/services/plural'
import { EmptyState } from '@/components/Screen'
import AlbumTile from '@/components/navidrome/AlbumTile'
import CoverImage from '@/components/CoverImage'
import { colors, layout, radius, spacing } from '@/constants/theme'

export default function ArtistScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const navigation = useNavigation()
  const client = useNavidromeStore((s) => s.client)

  const [artist, setArtist] = useState<NDArtist | null>(null)
  const [albums, setAlbums] = useState<NDAlbum[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!client || !id) return
    let cancelled = false
    setLoading(true)
    client
      .getArtist(id)
      .then((res) => {
        if (cancelled) return
        setArtist(res.artist)
        setAlbums(res.albums)
        setError(null)
        navigation.setOptions({ title: res.artist?.name || 'Artiste' })
        prefetchCoverArt(client, res.albums.map((a) => a.coverArt), 300)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Artiste introuvable')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id, client, attempt])

  if (!client) return <View style={styles.container} />
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    )
  }

  if (error && !artist) {
    return (
      <View style={[styles.container, styles.center]}>
        <EmptyState icon={User} title="Artiste indisponible" hint={error} action={{ label: 'Réessayer', onPress: () => setAttempt((n) => n + 1) }} />
      </View>
    )
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.content}
      data={albums}
      keyExtractor={(a) => a.id}
      numColumns={2}
      columnWrapperStyle={styles.column}
      showsVerticalScrollIndicator={false}
      ListHeaderComponent={
        <View style={styles.header}>
          <CoverImage
            uri={artist?.coverArt ? client.coverArtUrl(artist.coverArt, 400) : null}
            style={styles.avatar}
            icon={User}
            iconSize={44}
            recyclingKey={artist?.id}
          />
          <Text style={styles.name} numberOfLines={2}>
            {artist?.name}
          </Text>
          <Text style={styles.meta}>{plural(albums.length, 'album', 'albums')}</Text>
        </View>
      }
      renderItem={({ item }) => <AlbumTile album={item} />}
    />
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.base },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.base },
  content: { paddingHorizontal: spacing.lg, paddingBottom: layout.contentBottom },
  column: { justifyContent: 'space-between' },
  header: { alignItems: 'center', marginBottom: spacing.lg },
  avatar: { width: 150, height: 150, borderRadius: radius.full, marginBottom: spacing.lg },
  name: { color: colors.text, fontSize: 22, fontWeight: '800', textAlign: 'center', letterSpacing: -0.4 },
  meta: { color: colors.textSecondary, fontSize: 13, marginTop: spacing.xs }
})
