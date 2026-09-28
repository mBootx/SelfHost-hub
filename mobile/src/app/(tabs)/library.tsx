import { useState } from 'react'
import { View, Text, Pressable, FlatList, RefreshControl, StyleSheet, Alert } from 'react-native'
import { useRouter } from 'expo-router'
import { Disc3, ListMusic, Users, Plus, FolderOpen, Trash2 } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useToastStore } from '@/store/toastStore'
import { NDPlaylist } from '@/services/navidrome'
import ActionSheet from '@/components/ActionSheet'
import NavidromeGate from '@/components/navidrome/NavidromeGate'
import AlbumTile from '@/components/navidrome/AlbumTile'
import PlaylistTile from '@/components/navidrome/PlaylistTile'
import ArtistRow from '@/components/navidrome/ArtistRow'
import PromptModal from '@/components/PromptModal'
import { Screen, ScreenHeader, EmptyState } from '@/components/Screen'
import { colors, layout, radius, spacing } from '@/constants/theme'

type SubTab = 'albums' | 'artists' | 'playlists'

const SEGMENTS: [SubTab, string][] = [
  ['albums', 'Albums'],
  ['artists', 'Artistes'],
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

  function confirmDeletePlaylist(playlist: NDPlaylist): void {
    Alert.alert('Supprimer la playlist', `"${playlist.name}" sera definitivement supprimee.`, [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Supprimer',
        style: 'destructive',
        onPress: async () => {
          try {
            await deletePlaylist(playlist.id)
            showToast(`Playlist "${playlist.name}" supprimee`)
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
    setRefreshing(false)
  }

  async function handleCreatePlaylist(name: string): Promise<void> {
    setCreatingPlaylist(true)
    try {
      const playlist = await createPlaylist(name)
      setShowNewPlaylist(false)
      showToast(`Playlist "${playlist.name}" creee`)
      router.push({ pathname: '/playlist/[id]', params: { id: playlist.id } })
    } catch {
      showToast('Impossible de creer la playlist')
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
        title="Bibliotheque"
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
          ListEmptyComponent={<EmptyState icon={ListMusic} title="Aucune playlist" hint="Appuyez sur + pour en creer une." />}
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
        confirmLabel={creatingPlaylist ? 'Creation...' : 'Creer'}
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
  column: { justifyContent: 'space-between' }
})
