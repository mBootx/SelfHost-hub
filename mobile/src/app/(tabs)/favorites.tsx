import { useCallback, useEffect, useState } from 'react'
import { View, Text, ScrollView, ActivityIndicator, RefreshControl, StyleSheet } from 'react-native'
import { Heart } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import NavidromeGate from '@/components/navidrome/NavidromeGate'
import AlbumTile from '@/components/navidrome/AlbumTile'
import TrackRow from '@/components/navidrome/TrackRow'
import { Screen, ScreenHeader, SectionTitle, EmptyState } from '@/components/Screen'
import { NDAlbum, NDSong } from '@/services/navidrome'
import { prefetchCoverArt } from '@/services/imagePrefetch'
import { colors, layout, spacing } from '@/constants/theme'

function FavoritesContent() {
  const client = useNavidromeStore((s) => s.client)
  const playQueue = useNavidromeStore((s) => s.playQueue)
  const currentSongId = useNavidromeStore((s) => s.queue[s.queueIndex]?.id)
  const isPlaying = useNavidromeStore((s) => s.isPlaying)

  const [favorites, setFavorites] = useState<{ albums: NDAlbum[]; songs: NDSong[] }>({ albums: [], songs: [] })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!client) return
    setError(null)
    try {
      const res = await client.getStarred()
      setFavorites({ albums: res.albums, songs: res.songs })
      prefetchCoverArt(client, res.albums.map((a) => a.coverArt), 300)
      prefetchCoverArt(client, res.songs.map((s) => s.coverArt || s.albumId), 100)
    } catch (err: any) {
      setError(err?.message || 'Impossible de charger les favoris')
    }
  }, [client])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    load().finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [load])

  async function handleRefresh(): Promise<void> {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const isEmpty = favorites.albums.length === 0 && favorites.songs.length === 0

  return (
    <Screen>
      <ScreenHeader title="Favoris" />
      {loading ? (
        <ActivityIndicator color={colors.accent} style={styles.loader} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} colors={[colors.accent]} />
          }
        >
          {!!error && <Text style={styles.error}>{error}</Text>}

          {!error && isEmpty && (
            <EmptyState icon={Heart} title="Aucun favori" hint="Les titres et albums que vous aimez sur Navidrome apparaitront ici." />
          )}

          {favorites.albums.length > 0 && (
            <View style={styles.section}>
              <SectionTitle>Albums</SectionTitle>
              <View style={styles.grid}>
                {favorites.albums.map((album) => (
                  <AlbumTile key={album.id} album={album} />
                ))}
              </View>
            </View>
          )}

          {favorites.songs.length > 0 && client && (
            <View style={styles.section}>
              <SectionTitle>Titres</SectionTitle>
              {favorites.songs.map((song, i) => (
                <TrackRow
                  key={song.id}
                  song={song}
                  client={client}
                  isCurrent={song.id === currentSongId}
                  isPlaying={isPlaying}
                  onPress={() => playQueue(favorites.songs, i)}
                />
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </Screen>
  )
}

export default function FavoritesTab() {
  return (
    <NavidromeGate>
      <FavoritesContent />
    </NavidromeGate>
  )
}

const styles = StyleSheet.create({
  loader: { marginTop: spacing.xl },
  scroll: { paddingHorizontal: spacing.lg, paddingBottom: layout.contentBottom },
  section: { marginBottom: spacing.lg },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  error: { color: colors.danger, fontSize: 13, textAlign: 'center', marginTop: spacing.lg }
})
