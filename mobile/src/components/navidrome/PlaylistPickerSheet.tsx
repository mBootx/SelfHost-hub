import { useState } from 'react'
import { Modal, View, Text, Pressable, FlatList, StyleSheet } from 'react-native'
import { ListMusic, Plus, Check, X } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { usePlaylistPickerStore } from '@/store/playlistPickerStore'
import { useToastStore } from '@/store/toastStore'
import PromptModal from '@/components/PromptModal'
import { colors, radius, spacing } from '@/constants/theme'

/** Mounted once, near the tab navigator - same idea as TrackOptionsSheet. */
export default function PlaylistPickerSheet() {
  const song = usePlaylistPickerStore((s) => s.song)
  const close = usePlaylistPickerStore((s) => s.close)
  const playlists = useNavidromeStore((s) => s.playlists)
  const addSongsToPlaylist = useNavidromeStore((s) => s.addSongsToPlaylist)
  const createPlaylist = useNavidromeStore((s) => s.createPlaylist)
  const showToast = useToastStore((s) => s.show)
  const [addedTo, setAddedTo] = useState<Set<string>>(new Set())
  const [showPrompt, setShowPrompt] = useState(false)

  async function handleAdd(playlistId: string): Promise<void> {
    if (!song) return
    try {
      await addSongsToPlaylist(playlistId, [song.id])
      setAddedTo((prev) => new Set(prev).add(playlistId))
      const name = playlists.find((p) => p.id === playlistId)?.name
      showToast(name ? `Ajoute a "${name}"` : 'Ajoute a la playlist')
    } catch {
      showToast("Impossible d'ajouter a la playlist")
    }
  }

  async function handleCreate(name: string): Promise<void> {
    if (!song) return
    setShowPrompt(false)
    try {
      const playlist = await createPlaylist(name, [song.id])
      setAddedTo((prev) => new Set(prev).add(playlist.id))
      showToast(`Playlist "${playlist.name}" creee`)
    } catch {
      showToast('Impossible de creer la playlist')
    }
  }

  function handleClose(): void {
    setAddedTo(new Set())
    close()
  }

  return (
    <>
      <Modal visible={!!song} transparent animationType="fade" onRequestClose={handleClose}>
        <Pressable style={styles.backdrop} onPress={handleClose}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <View style={styles.header}>
              <Text style={styles.title} numberOfLines={1}>
                Ajouter "{song?.title}" a...
              </Text>
              <Pressable onPress={handleClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Fermer">
                <X size={18} color={colors.textSecondary} />
              </Pressable>
            </View>

            <Pressable style={styles.row} onPress={() => setShowPrompt(true)}>
              <Plus size={18} color={colors.accent} />
              <Text style={[styles.rowText, { color: colors.accent }]}>Nouvelle playlist</Text>
            </Pressable>

            <FlatList
              data={playlists}
              keyExtractor={(p) => p.id}
              style={styles.list}
              ListEmptyComponent={<Text style={styles.empty}>Aucune playlist pour le moment.</Text>}
              renderItem={({ item }) => (
                <Pressable style={styles.row} onPress={() => handleAdd(item.id)} disabled={addedTo.has(item.id)}>
                  <ListMusic size={18} color={colors.textSecondary} />
                  <Text style={styles.rowText} numberOfLines={1}>
                    {item.name}
                  </Text>
                  {addedTo.has(item.id) && <Check size={18} color={colors.accent} />}
                </Pressable>
              )}
            />
          </View>
        </Pressable>
      </Modal>

      <PromptModal
        visible={showPrompt}
        title="Nouvelle playlist"
        confirmLabel="Creer"
        onCancel={() => setShowPrompt(false)}
        onConfirm={handleCreate}
      />
    </>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.elevated,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    maxHeight: '70%'
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm
  },
  title: { color: colors.textMuted, fontSize: 12, flex: 1 },
  list: { flexGrow: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  rowText: { color: colors.text, fontSize: 15, flex: 1 },
  empty: { color: colors.textMuted, fontSize: 13, paddingHorizontal: spacing.lg, paddingVertical: spacing.md }
})
