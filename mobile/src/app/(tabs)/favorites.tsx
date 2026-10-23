import { useCallback, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { View, Text, FlatList, ActivityIndicator, RefreshControl, StyleSheet } from 'react-native'
import { Heart } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import NavidromeGate from '@/components/navidrome/NavidromeGate'
import AlbumTile from '@/components/navidrome/AlbumTile'
import TrackRow from '@/components/navidrome/TrackRow'
import { Screen, ScreenHeader, SectionTitle, EmptyState } from '@/components/Screen'
import SelectButton from '@/components/navidrome/SelectButton'
import { useSelectionPool } from '@/hooks/useSelectionPool'
import { NDAlbum, NDSong } from '@/services/navidrome'
import { prefetchCoverArt } from '@/services/imagePrefetch'
import { storage } from '@/services/storage'
import { useOfflineStore } from '@/store/offlineStore'
import { colors, layout, spacing } from '@/constants/theme'

const FAVORITES_CACHE_KEY = 'navidrome.cachedFavorites'

function FavoritesContent() {
  const client = useNavidromeStore((s) => s.client)
  const status = useNavidromeStore((s) => s.status)
  const playQueue = useNavidromeStore((s) => s.playQueue)
  const currentSongId = useNavidromeStore((s) => s.queue[s.queueIndex]?.id)
  const isPlaying = useNavidromeStore((s) => s.isPlaying)
  const offlineTracks = useOfflineStore((s) => s.tracks)

  const [favorites, setFavorites] = useState<{ albums: NDAlbum[]; songs: NDSong[] }>({ albums: [], songs: [] })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  useSelectionPool(favorites.songs)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!client) {
      const cached = await storage.loadPref<{ albums: NDAlbum[]; songs: NDSong[] }>(FAVORITES_CACHE_KEY).catch(() => null)
      if (cached) setFavorites({ albums: cached.albums ?? [], songs: cached.songs ?? [] })
      return
    }
    setError(null)
    try {
      const res = await client.getStarred()
      setFavorites({ albums: res.albums, songs: res.songs })
      storage.savePref(FAVORITES_CACHE_KEY, { albums: res.albums, songs: res.songs }).catch(() => {})
      prefetchCoverArt(client, res.albums.map((a) => a.coverArt), 300)
      prefetchCoverArt(client, res.songs.map((s) => s.coverArt || s.albumId), 100)
    } catch (err: any) {
      const cached = await storage.loadPref<{ albums: NDAlbum[]; songs: NDSong[] }>(FAVORITES_CACHE_KEY).catch(() => null)
      if (cached && (cached.albums?.length || cached.songs?.length)) {
        setFavorites({ albums: cached.albums ?? [], songs: cached.songs ?? [] })
      } else {
        setError(err?.message || 'Impossible de charger les favoris')
      }
    }
  }, [client])

  // Read again each time the tab is shown: a song liked or unliked elsewhere (the player, the watch, the PC) is
  // there without pulling down. Only the first read shows the spinner.
  const loadedOnce = useRef(false)
  useFocusEffect(
    useCallback(() => {
      let cancelled = false
      if (!loadedOnce.current) setLoading(true)
      load().finally(() => {
        if (cancelled) return
        loadedOnce.current = true
        setLoading(false)
      })
      return () => {
        cancelled = true
      }
    }, [load])
  )

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
        // A FlatList so only rows near the viewport mount - liked songs can run into the hundreds.
        <FlatList
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          initialNumToRender={14}
          maxToRenderPerBatch={14}
          windowSize={7}
          removeClippedSubviews
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} colors={[colors.accent]} />
          }
          ListHeaderComponent={
            <>
              {!!error && <Text style={styles.error}>{error}</Text>}

              {!error && isEmpty && (
                <EmptyState icon={Heart} title="Aucun favori" hint="Les titres et albums que vous aimez sur Navidrome apparaîtront ici." />
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

              {favorites.songs.length > 0 && <SectionTitle action={<SelectButton label="Sélectionner" />}>Titres</SectionTitle>}
            </>
          }
          data={favorites.songs}
          keyExtractor={(s) => s.id}
          renderItem={({ item, index }) => (
            <TrackRow
              song={item}
              client={client}
              isCurrent={item.id === currentSongId}
              isPlaying={isPlaying}
              onPress={() => {
                if (status !== 'connected') {
                  const playable = favorites.songs.filter((s) => s.id in offlineTracks)
                  if (playable.length > 0 && playable.length < favorites.songs.length) {
                    const idx = Math.max(0, playable.findIndex((s) => s.id === item.id))
                    playQueue(playable, idx)
                    return
                  }
                }
                playQueue(favorites.songs, index)
              }}
            />
          )}
        />
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
