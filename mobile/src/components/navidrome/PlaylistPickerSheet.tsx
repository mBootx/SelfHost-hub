import { useMemo, useState } from 'react'
import { View, Text, Pressable, FlatList, StyleSheet, TextInput } from 'react-native'
import { ListMusic, Plus, Check, Search } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { usePlaylistPickerStore } from '@/store/playlistPickerStore'
import { useToastStore } from '@/store/toastStore'
import BottomSheet from '@/components/BottomSheet'
import CoverImage from '@/components/CoverImage'
import PromptModal from '@/components/PromptModal'
import { plural } from '@/services/plural'
import { colors, radius, spacing, tint } from '@/constants/theme'

/** The search box shows from this many playlists on. */
const SEARCH_FROM = 7

/** Mounted once, near the tab navigator - same idea as TrackOptionsSheet. */
export default function PlaylistPickerSheet() {
  const pick = usePlaylistPickerStore((s) => s.pick)
  const close = usePlaylistPickerStore((s) => s.close)
  const client = useNavidromeStore((s) => s.client)
  const playlists = useNavidromeStore((s) => s.playlists)
  const addSongsToPlaylist = useNavidromeStore((s) => s.addSongsToPlaylist)
  const createPlaylist = useNavidromeStore((s) => s.createPlaylist)
  const showToast = useToastStore((s) => s.show)
  const [addedTo, setAddedTo] = useState<Set<string>>(new Set())
  const [showPrompt, setShowPrompt] = useState(false)
  const [query, setQuery] = useState('')

  const ids = pick?.songs.map((s) => s.id) ?? []
  const what = pick ? (pick.songs.length > 1 ? `${pick.songs.length} titres` : '') : ''
  const first = pick?.songs[0]
  const coverId = first?.coverArt || first?.albumId

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? playlists.filter((p) => p.name.toLowerCase().includes(needle)) : playlists
  }, [playlists, query])

  async function handleAdd(playlistId: string): Promise<void> {
    if (!pick) return
    try {
      await addSongsToPlaylist(playlistId, ids)
      setAddedTo((prev) => new Set(prev).add(playlistId))
      const name = playlists.find((p) => p.id === playlistId)?.name
      const added = what ? `${what} ajoutés` : 'Ajouté'
      showToast(name ? `${added} à « ${name} »` : `${added} à la playlist`)
    } catch {
      showToast("Impossible d'ajouter à la playlist")
    }
  }

  async function handleCreate(name: string): Promise<void> {
    if (!pick) return
    setShowPrompt(false)
    try {
      const playlist = await createPlaylist(name, ids)
      setAddedTo((prev) => new Set(prev).add(playlist.id))
      showToast(`Playlist « ${playlist.name} » créée`)
    } catch {
      showToast('Impossible de créer la playlist')
    }
  }

  function handleClose(): void {
    setAddedTo(new Set())
    setQuery('')
    close()
  }

  return (
    <>
      <BottomSheet
        visible={!!pick}
        onClose={handleClose}
        title="Ajouter à une playlist"
        subtitle={pick ? `${pick.label}${what ? ` · ${what}` : ''}` : undefined}
        leading={<CoverImage uri={coverId && client ? client.coverArtUrl(coverId, 120) : null} style={styles.cover} iconSize={20} recyclingKey={first?.id} />}
        scrollable={false}
        maxHeight={0.86}
      >
        <Pressable style={({ pressed }) => [styles.create, pressed && styles.pressed]} onPress={() => setShowPrompt(true)} accessibilityRole="button" accessibilityLabel="Nouvelle playlist">
          <View style={styles.createTile}>
            <Plus size={20} color={colors.onAccent} strokeWidth={2.6} />
          </View>
          <Text style={styles.createText}>Nouvelle playlist</Text>
        </Pressable>

        {playlists.length >= SEARCH_FROM && (
          <View style={styles.search}>
            <Search size={16} color={colors.textMuted} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Chercher une playlist"
              placeholderTextColor={colors.textMuted}
              autoCorrect={false}
              accessibilityLabel="Chercher une playlist"
            />
          </View>
        )}

        <FlatList
          data={shown}
          keyExtractor={(p) => p.id}
          style={styles.list}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={<Text style={styles.empty}>{query ? 'Aucune playlist ne correspond.' : 'Aucune playlist pour le moment.'}</Text>}
          renderItem={({ item }) => {
            const added = addedTo.has(item.id)
            return (
              <Pressable
                style={({ pressed }) => [styles.row, added && styles.rowDone, pressed && !added && styles.pressed]}
                onPress={() => handleAdd(item.id)}
                disabled={added}
                accessibilityRole="button"
                accessibilityLabel={`${item.name}${added ? ', ajouté' : ''}`}
              >
                <CoverImage uri={item.coverArt && client ? client.coverArtUrl(item.coverArt, 100) : null} style={styles.playlistCover} icon={ListMusic} iconSize={18} recyclingKey={item.id} />
                <View style={styles.rowText}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.meta}>{plural(item.songCount, 'titre', 'titres')}</Text>
                </View>
                <View style={[styles.state, added && styles.stateDone]}>{added ? <Check size={16} color={colors.onAccent} strokeWidth={3} /> : <Plus size={16} color={colors.textSecondary} />}</View>
              </Pressable>
            )
          }}
        />
      </BottomSheet>

      <PromptModal visible={showPrompt} title="Nouvelle playlist" placeholder="Nom de la playlist" confirmLabel="Créer" onCancel={() => setShowPrompt(false)} onConfirm={handleCreate} />
    </>
  )
}

const styles = StyleSheet.create({
  cover: { width: 48, height: 48, borderRadius: radius.sm + 2 },
  create: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    padding: spacing.sm + 2,
    borderRadius: radius.lg,
    backgroundColor: tint(colors.accent, 0.12),
    borderWidth: 1,
    borderColor: tint(colors.accent, 0.35)
  },
  createTile: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  createText: { flex: 1, color: colors.accent, fontSize: 15, fontWeight: '700' },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.border
  },
  searchInput: { flex: 1, color: colors.text, fontSize: 14, paddingVertical: spacing.sm + 1 },
  list: { flexGrow: 0, paddingHorizontal: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.sm + 2, borderRadius: radius.md },
  rowDone: { backgroundColor: tint(colors.accent, 0.1) },
  pressed: { backgroundColor: colors.hover },
  playlistCover: { width: 44, height: 44, borderRadius: radius.sm + 2 },
  rowText: { flex: 1, minWidth: 0 },
  name: { color: colors.text, fontSize: 15, fontWeight: '600' },
  meta: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  state: { width: 28, height: 28, borderRadius: radius.full, backgroundColor: colors.hover, alignItems: 'center', justifyContent: 'center' },
  stateDone: { backgroundColor: colors.accent },
  empty: { color: colors.textMuted, fontSize: 13, paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, textAlign: 'center' }
})
