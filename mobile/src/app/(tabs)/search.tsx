import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, TextInput, ScrollView, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Search, X, CloudDownload } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useDowntifyStore } from '@/store/downtifyStore'
import NavidromeGate from '@/components/navidrome/NavidromeGate'
import AlbumTile from '@/components/navidrome/AlbumTile'
import ArtistRow from '@/components/navidrome/ArtistRow'
import TrackRow from '@/components/navidrome/TrackRow'
import DownloadRow from '@/components/downtify/DownloadRow'
import { Screen, SectionTitle, EmptyState } from '@/components/Screen'
import { NDAlbum, NDArtist, NDSong } from '@/services/navidrome'
import { prefetchCoverArt } from '@/services/imagePrefetch'
import { DowntifySong } from '@/services/downtify'
import { colors, layout, radius, spacing } from '@/constants/theme'

const MIN_QUERY = 2
const DEBOUNCE_MS = 300

type Results = { artists: NDArtist[]; albums: NDAlbum[]; songs: NDSong[] }
const EMPTY: Results = { artists: [], albums: [], songs: [] }

function SearchContent() {
  const client = useNavidromeStore((s) => s.client)
  const playQueue = useNavidromeStore((s) => s.playQueue)
  const currentSongId = useNavidromeStore((s) => s.queue[s.queueIndex]?.id)
  const isPlaying = useNavidromeStore((s) => s.isPlaying)
  const downtify = useDowntifyStore((s) => s.client)

  const inputRef = useRef<TextInput>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Results>(EMPTY)
  const [downloadable, setDownloadable] = useState<DowntifySong[]>([])
  const [searching, setSearching] = useState(false)

  // Bumped on every keystroke; a response whose ticket is stale gets dropped so
  // a slow early request can't overwrite the results of a later one.
  const ticket = useRef(0)

  useEffect(() => {
    const term = query.trim()
    if (!client || term.length < MIN_QUERY) {
      ticket.current++
      setResults(EMPTY)
      setDownloadable([])
      setSearching(false)
      return
    }

    const mine = ++ticket.current
    setSearching(true)
    const timer = setTimeout(async () => {
      // Local library and Downtify are searched together; allSettled so a
      // sleeping Downtify box never costs us the Navidrome results.
      const [local, remote] = await Promise.allSettled([
        client.search(term),
        downtify ? downtify.searchSongs(term) : Promise.resolve([] as DowntifySong[])
      ])
      if (ticket.current !== mine) return
      const localResults = local.status === 'fulfilled' ? local.value : EMPTY
      setResults(localResults)
      setDownloadable(remote.status === 'fulfilled' ? remote.value : [])
      setSearching(false)
      if (client) {
        prefetchCoverArt(client, localResults.albums.map((a) => a.coverArt), 300)
        prefetchCoverArt(client, localResults.artists.map((a) => a.coverArt), 100)
        prefetchCoverArt(client, localResults.songs.map((s) => s.coverArt || s.albumId), 100)
      }
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [query, client, downtify])

  // A search tab should be ready to type in the moment it opens.
  useFocusEffect(
    useCallback(() => {
      const timer = setTimeout(() => inputRef.current?.focus(), 250)
      return () => clearTimeout(timer)
    }, [])
  )

  const hasLocal = results.artists.length > 0 || results.albums.length > 0 || results.songs.length > 0
  const hasAny = hasLocal || downloadable.length > 0
  const searched = query.trim().length >= MIN_QUERY

  return (
    <Screen>
      <View style={styles.searchBar}>
        <Search size={18} color={colors.textMuted} />
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder="Artistes, albums, titres..."
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Rechercher dans la bibliothèque et sur Downtify"
        />
        {query.length > 0 && (
          <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Effacer">
            <X size={18} color={colors.textMuted} />
          </Pressable>
        )}
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        {!searched && (
          <EmptyState
            icon={Search}
            title="Rechercher"
            hint={
              downtify
                ? 'Cherche dans votre bibliothèque et sur Downtify. Deux lettres minimum.'
                : 'Cherche dans votre bibliothèque. Deux lettres minimum.'
            }
          />
        )}

        {searched && searching && <ActivityIndicator color={colors.accent} style={styles.loader} />}

        {searched && !searching && !hasAny && <EmptyState icon={X} title={`Aucun résultat pour "${query.trim()}"`} />}

        {!searching && results.artists.length > 0 && (
          <View style={styles.section}>
            <SectionTitle>Artistes</SectionTitle>
            {results.artists.map((artist) => (
              <ArtistRow key={artist.id} artist={artist} />
            ))}
          </View>
        )}

        {!searching && results.albums.length > 0 && (
          <View style={styles.section}>
            <SectionTitle>Albums</SectionTitle>
            <View style={styles.grid}>
              {results.albums.map((album) => (
                <AlbumTile key={album.id} album={album} />
              ))}
            </View>
          </View>
        )}

        {!searching && results.songs.length > 0 && client && (
          <View style={styles.section}>
            <SectionTitle>Dans votre bibliothèque</SectionTitle>
            {results.songs.map((song, i) => (
              <TrackRow
                key={song.id}
                song={song}
                client={client}
                isCurrent={song.id === currentSongId}
                isPlaying={isPlaying}
                onPress={() => playQueue(results.songs, i)}
              />
            ))}
          </View>
        )}

        {!searching && downloadable.length > 0 && (
          <View style={styles.section}>
            <View style={styles.downtifyTitle}>
              <CloudDownload size={17} color={colors.downtify} />
              <Text style={styles.downtifyTitleText}>À télécharger</Text>
            </View>
            {downloadable.map((song) => (
              <DownloadRow key={song.song_id} song={song} />
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  )
}

export default function SearchTab() {
  return (
    <NavidromeGate>
      <SearchContent />
    </NavidromeGate>
  )
}

const styles = StyleSheet.create({
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.elevated,
    borderRadius: radius.full,
    paddingHorizontal: spacing.lg,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.md
  },
  input: { flex: 1, color: colors.text, fontSize: 15, paddingVertical: spacing.md },
  scroll: { paddingHorizontal: spacing.lg, paddingBottom: layout.contentBottom },
  loader: { marginTop: spacing.xl },
  section: { marginBottom: spacing.lg },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  downtifyTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.sm },
  downtifyTitleText: { color: colors.text, fontSize: 17, fontWeight: '700', letterSpacing: -0.2 }
})
