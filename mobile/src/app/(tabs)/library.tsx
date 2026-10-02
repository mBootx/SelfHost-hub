import { useEffect, useState } from 'react'
import { View, Text, Pressable, FlatList, RefreshControl, StyleSheet, Alert } from 'react-native'
import { useRouter } from 'expo-router'
import { Disc3, ListMusic, Users, Plus, FolderOpen, Trash2, Tags, ChevronRight } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useToastStore } from '@/store/toastStore'
import { NDGenre, NDPlaylist } from '@/services/navidrome'
import ActionSheet from '@/components/ActionSheet'
import NavidromeGate from '@/components/navidrome/NavidromeGate'
import AlbumTile from '@/components/navidrome/AlbumTile'
import PlaylistTile from '@/components/navidrome/PlaylistTile'
import ArtistRow from '@/components/navidrome/ArtistRow'
import PromptModal from '@/components/PromptModal'
import { Screen, ScreenHeader, EmptyState } from '@/components/Screen'
import { colors, layout, radius, spacing } from '@/constants/theme'

type SubTab = 'albums' | 'artists' | 'genres' | 'playlists'

const SEGMENTS: [SubTab, string][] = [
  ['albums', 'Albums'],
  ['artists', 'Artistes'],
  ['genres', 'Genres'],
  ['playlists', 'Playlists']
]

/**
 * A large Navidrome library can be thousands of rows. Keeping the render window
 * tight bounds how many mounted views (and decoded cover images) sit in memory
 * at once, which is what actually drives the app's footprint while scrolling.
 */
const LIST_PERF = {
  initialNumToRender: 12,
  maxToRenderPerBatch: 12,
  windowSize: 7,
  removeClippedSubviews: true
} as const

function LibraryContent() {
  const router = useRouter()
  const artists = useNavidromeStore((s) => s.artists)
  const recentAlbums = useNavidromeStore((s) => s.recentAlbums)
  const client = useNavidromeStore((s) => s.client)
  const playlists = useNavidromeStore((s) => s.playlists)
  const loadLibrary = useNavidromeStore((s) => s.loadLibrary)
  const createPlaylist = useNavidromeStore((s) => s.createPlaylist)
  const deletePlaylist = useNavidromeStore((s) => s.deletePlaylist)
  const showToast = useToastStore((s) => s.show)

  const [subTab, setSubTab] = useState<SubTab>('albums')
  const [refreshing, setRefreshing] = useState(false)
  const [showNewPlaylist, setShowNewPlaylist] = useState(false)
  const [creatingPlaylist, setCreatingPlaylist] = useState(false)
  const [menuPlaylist, setMenuPlaylist] = useState<NDPlaylist | null>(null)
  const [genres, setGenres] = useState<NDGenre[] | null>(null)
  const [genreError, setGenreError] = useState<string | null>(null)

  // The genres are only asked for the first time the tab is opened.
  useEffect(() => {
    if (subTab !== 'genres' || genres !== null || !client) return
    client
      .getGenres()
      .then((found) => {
        setGenres(found)
        setGenreError(null)
      })
      .catch((err) => setGenreError(err instanceof Error ? err.message : 'Impossible de charger les genres'))
  }, [subTab, genres, client])

  function confirmDeletePlaylist(playlist: NDPlaylist): void {
    Alert.alert('Supprimer la playlist', `"${playlist.name}" sera définitivement supprimée.`, [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Supprimer',
        style: 'destructive',
        onPress: async () => {
          try {
            await deletePlaylist(playlist.id)
            showToast(`Playlist "${playlist.name}" supprimée`)
          } catch (err: any) {
            showToast(err?.message || 'Impossible de supprimer la playlist')
          }
        }
      }
    ])
  }

  async function handleRefresh(): Promise<void> {
    setRefreshing(true)
    await loadLibrary()
    if (client && subTab === 'genres') setGenres(await client.getGenres().catch(() => genres))
    setRefreshing(false)
  }

  async function handleCreatePlaylist(name: string): Promise<void> {
    setCreatingPlaylist(true)
    try {
      const playlist = await createPlaylist(name)
      setShowNewPlaylist(false)
      showToast(`Playlist "${playlist.name}" créée`)
      router.push({ pathname: '/playlist/[id]', params: { id: playlist.id } })
    } catch {
      showToast('Impossible de créer la playlist')
    } finally {
      setCreatingPlaylist(false)
    }
  }

  const refreshControl = (
    <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} colors={[colors.accent]} />
  )

  return (
    <Screen>
      <ScreenHeader
        title="Bibliothèque"
        action={
          subTab === 'playlists' ? (
            <Pressable
              onPress={() => setShowNewPlaylist(true)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Nouvelle playlist"
              style={styles.newPlaylistButton}
            >
              <Plus size={20} color={colors.accent} />
            </Pressable>
          ) : undefined
        }
      />

      <View style={styles.segments}>
        {SEGMENTS.map(([key, label]) => {
          const active = subTab === key
          return (
            <Pressable
              key={key}
              onPress={() => setSubTab(key)}
              style={[styles.segment, active && styles.segmentActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text>
            </Pressable>
          )
        })}
      </View>

      {/*
        Each branch needs its own `key`: without it React reuses the same FlatList
        instance across sub-tabs, and switching between the 2-column grids and the
        1-column artist list trips React Native's "Changing numColumns on the fly
        is not supported" invariant, which crashes the screen.
      */}
      {subTab === 'artists' ? (
        <FlatList
          key="artists"
          contentContainerStyle={styles.list}
          data={artists}
          keyExtractor={(a) => a.id}
          refreshControl={refreshControl}
          showsVerticalScrollIndicator={false}
          {...LIST_PERF}
          ListEmptyComponent={<EmptyState icon={Users} title="Aucun artiste" hint="Tirez vers le bas pour recharger." />}
          renderItem={({ item }) => <ArtistRow artist={item} />}
        />
      ) : subTab === 'genres' ? (
        <FlatList
          key="genres"
          contentContainerStyle={styles.list}
          data={genres ?? []}
          keyExtractor={(g) => g.name}
          refreshControl={refreshControl}
          showsVerticalScrollIndicator={false}
          {...LIST_PERF}
          ListEmptyComponent={
            genres === null && !genreError ? (
              <EmptyState icon={Tags} title="Chargement…" />
            ) : (
              <EmptyState icon={Tags} title={genreError ? 'Genres indisponibles' : 'Aucun genre'} hint={genreError ?? "Les genres viennent des balises de vos fichiers. Tirez vers le bas pour recharger."} />
            )
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.genreRow}
              onPress={() => router.push({ pathname: '/genre/[name]', params: { name: item.name } })}
              accessibilityRole="button"
              accessibilityLabel={`Genre ${item.name}`}
            >
              <View style={styles.genreText}>
                <Text style={styles.genreName} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.genreMeta}>
                  {item.albumCount} album{item.albumCount > 1 ? 's' : ''} · {item.songCount} titre{item.songCount > 1 ? 's' : ''}
                </Text>
              </View>
              <ChevronRight size={18} color={colors.textMuted} />
            </Pressable>
          )}
        />
      ) : subTab === 'playlists' ? (
        <FlatList
          key="playlists"
          contentContainerStyle={styles.list}
          data={playlists}
          keyExtractor={(p) => p.id}
          numColumns={2}
          columnWrapperStyle={styles.column}
          refreshControl={refreshControl}
          showsVerticalScrollIndicator={false}
          {...LIST_PERF}
          ListEmptyComponent={<EmptyState icon={ListMusic} title="Aucune playlist" hint="Appuyez sur + pour en créer une." />}
          renderItem={({ item }) => <PlaylistTile playlist={item} onLongPress={() => setMenuPlaylist(item)} />}
        />
      ) : (
        <FlatList
          key="albums"
          contentContainerStyle={styles.list}
          data={recentAlbums}
          keyExtractor={(a) => a.id}
          numColumns={2}
          columnWrapperStyle={styles.column}
          refreshControl={refreshControl}
          showsVerticalScrollIndicator={false}
          {...LIST_PERF}
          ListEmptyComponent={<EmptyState icon={Disc3} title="Aucun album" hint="Tirez vers le bas pour recharger." />}
          renderItem={({ item }) => <AlbumTile album={item} />}
        />
      )}

      <PromptModal
        visible={showNewPlaylist}
        title="Nouvelle playlist"
        confirmLabel={creatingPlaylist ? 'Création...' : 'Créer'}
        onCancel={() => setShowNewPlaylist(false)}
        onConfirm={handleCreatePlaylist}
      />

      <ActionSheet
        visible={!!menuPlaylist}
        title={menuPlaylist?.name}
        items={
          menuPlaylist
            ? [
                {
                  label: 'Ouvrir',
                  icon: FolderOpen,
                  onPress: () => router.push({ pathname: '/playlist/[id]', params: { id: menuPlaylist.id } })
                },
                { label: 'Supprimer la playlist', icon: Trash2, danger: true, onPress: () => confirmDeletePlaylist(menuPlaylist) }
              ]
            : []
        }
        onClose={() => setMenuPlaylist(null)}
      />
    </Screen>
  )
}

export default function LibraryTab() {
  return (
    <NavidromeGate>
      <LibraryContent />
    </NavidromeGate>
  )
}

const styles = StyleSheet.create({
  newPlaylistButton: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  /** One rounded track holding all three options, rather than three loose pills. */
  segments: {
    flexDirection: 'row',
    backgroundColor: colors.raised,
    borderRadius: radius.full,
    padding: 3,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md
  },
  segment: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm, borderRadius: radius.full },
  segmentActive: { backgroundColor: colors.accent },
  segmentText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  segmentTextActive: { color: '#000' },
  list: { paddingHorizontal: spacing.lg, paddingBottom: layout.contentBottom },
  genreRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.elevated, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  genreText: { flex: 1, minWidth: 0 },
  genreName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  genreMeta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  column: { justifyContent: 'space-between' }
})
