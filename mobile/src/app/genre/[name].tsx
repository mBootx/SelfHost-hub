import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useNavigation } from 'expo-router'
import { Disc3, Shuffle } from 'lucide-react-native'
import { EmptyState } from '@/components/Screen'
import AlbumTile from '@/components/navidrome/AlbumTile'
import { NDAlbum } from '@/services/navidrome'
import { prefetchCoverArt } from '@/services/imagePrefetch'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useToastStore } from '@/store/toastStore'
import { colors, layout, radius, spacing } from '@/constants/theme'

/** Albums are fetched this many at a time. */
const PAGE = 40
/** A shuffle of the genre is this long. */
const SHUFFLE_SONGS = 60

/** One genre: its albums, and a button that plays a random mix of it. */
export default function GenreScreen() {
  const { name } = useLocalSearchParams<{ name: string }>()
  const navigation = useNavigation()
  const client = useNavidromeStore((s) => s.client)
  const playQueue = useNavidromeStore((s) => s.playQueue)
  const showToast = useToastStore((s) => s.show)

  const [albums, setAlbums] = useState<NDAlbum[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const [mixing, setMixing] = useState(false)
  const fetching = useRef(false)

  useEffect(() => {
    navigation.setOptions({ title: name || 'Genre' })
  }, [name, navigation])

  const loadPage = useCallback(
    async (offset: number) => {
      if (!client || !name || fetching.current) return
      fetching.current = true
      try {
        const page = await client.getAlbumsByGenre(name, PAGE, offset)
        prefetchCoverArt(client, page.map((album) => album.coverArt), 300)
        setAlbums((previous) => (offset === 0 ? page : [...previous, ...page.filter((album) => !previous.some((known) => known.id === album.id))]))
        setMore(page.length === PAGE)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Impossible de charger ce genre')
      } finally {
        fetching.current = false
        setLoading(false)
      }
    },
    [client, name]
  )

  useEffect(() => {
    setAlbums([])
    setLoading(true)
    void loadPage(0)
  }, [loadPage])

  async function mix(): Promise<void> {
    if (!client || !name || mixing) return
    setMixing(true)
    try {
      const songs = await client.getRandomSongs(SHUFFLE_SONGS, name)
      if (songs.length === 0) showToast('Aucun titre dans ce genre')
      else playQueue(songs, 0)
    } catch {
      showToast('Impossible de lancer le mix')
    } finally {
      setMixing(false)
    }
  }

  if (!client) return <View style={styles.container} />
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    )
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.content}
      data={albums}
      keyExtractor={(album) => album.id}
      numColumns={2}
      columnWrapperStyle={styles.column}
      showsVerticalScrollIndicator={false}
      onEndReachedThreshold={0.6}
      onEndReached={() => {
        if (more) void loadPage(albums.length)
      }}
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={styles.name} numberOfLines={2}>
            {name}
          </Text>
          <Pressable style={[styles.mix, mixing && styles.mixBusy]} onPress={() => void mix()} disabled={mixing} accessibilityRole="button" accessibilityLabel={`Lecture aléatoire du genre ${name}`}>
            {mixing ? <ActivityIndicator color="#000000" /> : <Shuffle size={16} color="#000000" />}
            <Text style={styles.mixText}>Lecture aléatoire</Text>
          </Pressable>
        </View>
      }
      ListEmptyComponent={<EmptyState icon={Disc3} title={error ? 'Chargement impossible' : 'Aucun album'} hint={error ?? 'Ce genre ne contient pas d’album.'} />}
      renderItem={({ item }) => <AlbumTile album={item} />}
    />
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.base },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.base },
  content: { paddingHorizontal: spacing.lg, paddingBottom: layout.contentBottom },
  column: { justifyContent: 'space-between' },
  header: { alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg },
  name: { color: colors.text, fontSize: 24, fontWeight: '800', textAlign: 'center', letterSpacing: -0.4 },
  mix: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.accent, borderRadius: radius.full, paddingHorizontal: spacing.xl, paddingVertical: spacing.sm + 2 },
  mixBusy: { opacity: 0.7 },
  mixText: { color: '#000000', fontWeight: '800', fontSize: 14 }
})
