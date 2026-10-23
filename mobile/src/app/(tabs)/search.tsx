import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, TextInput, ScrollView, Pressable, ActivityIndicator, RefreshControl, StyleSheet } from 'react-native'
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
import SelectButton from '@/components/navidrome/SelectButton'
import { useSelectionPool } from '@/hooks/useSelectionPool'
import { NDAlbum, NDArtist, NDSong } from '@/services/navidrome'
import { scanLibrary } from '@/services/libraryScan'
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
  const lastCompletedAt = useDowntifyStore((s) => s.lastCompletedAt)
  const loadLibrary = useNavidromeStore((s) => s.loadLibrary)

  const inputRef = useRef<TextInput>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Results>(EMPTY)
  const [downloadable, setDownloadable] = useState<DowntifySong[]>([])
  const downloadableRef = useRef<DowntifySong[]>([])
  downloadableRef.current = downloadable
  const [searching, setSearching] = useState(false)
  // Why the library could not be searched (the server out of reach): not the same as finding nothing.
  const [localError, setLocalError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Bumped on every keystroke; a response whose ticket is stale gets dropped so
  // a slow early request can't overwrite the results of a later one.
  const ticket = useRef(0)

  /** Searches the library and Downtify for `term` and shows what comes back, unless a newer search has started since. */
  const runSearch = useCallback(
    async (term: string, localOnly = false): Promise<void> => {
      if (!client) return
      const mine = ++ticket.current
      const currentDownloadableIds = new Set(downloadableRef.current.map((s) => s.song_id))
      const dtState = useDowntifyStore.getState()
      const doneSongs = [
        ...dtState.completedSongs,
        ...dtState.queue.filter((q) => q.status === 'done').map((q) => q.song)
      ].filter((s) => currentDownloadableIds.has(s.song_id))
      const doneTitles = Array.from(new Set(doneSongs.map((s) => s.name))).filter(
        (name) => name && name.toLowerCase() !== term.toLowerCase()
      )

      // Local library and Downtify are searched together; allSettled so a
      // sleeping Downtify box never costs us the Navidrome results.
      const [local, remote, ...extraLocals] = await Promise.allSettled([
        client.search(term),
        !localOnly && downtify ? downtify.searchSongs(term) : Promise.resolve(downloadableRef.current),
        ...doneTitles.slice(0, 3).map((title) => client.search(title))
      ])
      if (ticket.current !== mine) return
      const baseLocal = local.status === 'fulfilled' ? local.value : EMPTY
      const songMap = new Map<string, NDSong>()
      for (const s of baseLocal.songs) songMap.set(s.id, s)
      for (const extra of extraLocals) {
        if (extra.status === 'fulfilled') {
          for (const s of extra.value.songs) {
            if (!songMap.has(s.id)) songMap.set(s.id, s)
          }
        }
      }
      const localResults: Results = {
        artists: baseLocal.artists,
        albums: baseLocal.albums,
        songs: Array.from(songMap.values())
      }
      setResults(localResults)
      setLocalError(local.status === 'rejected' ? (local.reason instanceof Error ? local.reason.message : 'Serveur injoignable') : null)
      if (!localOnly) {
        setDownloadable(remote.status === 'fulfilled' ? remote.value : [])
      }
      setSearching(false)
      prefetchCoverArt(client, localResults.albums.map((a) => a.coverArt), 300)
      prefetchCoverArt(client, localResults.artists.map((a) => a.coverArt), 100)
      prefetchCoverArt(client, localResults.songs.map((s) => s.coverArt || s.albumId), 100)
    },
    [client, downtify]
  )

  useEffect(() => {
    // Any keystroke makes an answer still on its way out of date.
    ticket.current++
    const term = query.trim()
    if (!client || term.length < MIN_QUERY) {
      setResults(EMPTY)
      setDownloadable([])
      setLocalError(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => void runSearch(term), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, client, runSearch])

  // Whenever a Downtify download finishes and Navidrome has scanned it, refresh the local hits automatically.
  useEffect(() => {
    if (!lastCompletedAt) return
    const term = query.trim()
    if (client && term.length >= MIN_QUERY) {
      void runSearch(term, downloadableRef.current.length > 0)
    }
  }, [lastCompletedAt, client, query, runSearch])

  // Pulled down: scan the server for any newly downloaded files, reload library lists, and re-run the search.
  async function handleRefresh(): Promise<void> {
    setRefreshing(true)
    try {
      const term = query.trim()
      await scanLibrary().catch(() => loadLibrary())
      if (term.length >= MIN_QUERY) {
        await runSearch(term, downloadableRef.current.length > 0)
      }
    } finally {
      setRefreshing(false)
    }
  }

  // A search tab should be ready to type in the moment it opens.
  useFocusEffect(
    useCallback(() => {
      const timer = setTimeout(() => inputRef.current?.focus(), 250)
      return () => clearTimeout(timer)
    }, [])
  )

  const hasLocal = results.artists.length > 0 || results.albums.length > 0 || results.songs.length > 0
  const hasAny = hasLocal || downloadable.length > 0
  useSelectionPool(results.songs)
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
          placeholder="Artistes, albums, titres…"
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
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void handleRefresh()} tintColor={colors.accent} colors={[colors.accent]} />
        }
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

        {searched && searching && !refreshing && <ActivityIndicator color={colors.accent} style={styles.loader} />}

        {searched && !searching && !hasAny && (
          localError ? (
            <EmptyState icon={X} title="Recherche impossible" hint={localError} />
          ) : (
            <EmptyState icon={X} title={`Aucun résultat pour « ${query.trim()} »`} />
          )
        )}

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
            <SectionTitle action={<SelectButton label="Sélectionner" />}>Dans votre bibliothèque</SectionTitle>
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
