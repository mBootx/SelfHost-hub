import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator, Alert, Switch } from 'react-native'
import { useLocalSearchParams, useNavigation } from 'expo-router'
import { Play, HardDriveDownload, ListMusic, Trash2 } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useOfflineStore } from '@/store/offlineStore'
import { useToastStore } from '@/store/toastStore'
import { NDPlaylist, NDSong } from '@/services/navidrome'
import { prefetchCoverArt } from '@/services/imagePrefetch'
import { plural } from '@/services/plural'
import { EmptyState } from '@/components/Screen'
import TrackRow from '@/components/navidrome/TrackRow'
import DragList from '@/components/DragList'
import CoverImage from '@/components/CoverImage'
import { colors, layout, radius, spacing } from '@/constants/theme'

type SortMode = 'default' | 'title' | 'artist' | 'duration'

/** The height of a song while the playlist is being reordered (rows of one height are what can be dragged). */
const REORDER_ROW = 56

const SORT_OPTIONS: { key: SortMode; label: string }[] = [
  { key: 'default', label: 'Ordre' },
  { key: 'title', label: 'Titre' },
  { key: 'artist', label: 'Artiste' },
  { key: 'duration', label: 'Durée' }
]

/** A playlist slot; `key` stays valid as earlier slots are removed, unlike its index. */
interface Entry {
  key: string
  song: NDSong
}

export default function PlaylistScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const navigation = useNavigation()
  const client = useNavidromeStore((s) => s.client)
  const playQueue = useNavidromeStore((s) => s.playQueue)
  const currentSongId = useNavidromeStore((s) => s.queue[s.queueIndex]?.id)
  const isPlaying = useNavidromeStore((s) => s.isPlaying)
  const downloadTracks = useOfflineStore((s) => s.downloadTracks)
  const kept = useOfflineStore((s) => (id ? id in s.keptPlaylists : false))
  const setKeptPlaylist = useOfflineStore((s) => s.setKeptPlaylist)
  const removeFromPlaylist = useNavidromeStore((s) => s.removeFromPlaylist)
  const deletePlaylist = useNavidromeStore((s) => s.deletePlaylist)
  const showToast = useToastStore((s) => s.show)

  const [playlist, setPlaylist] = useState<NDPlaylist | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [sortMode, setSortMode] = useState<SortMode>('default')
  // Putting the songs in another order by dragging them: a mode of its own, with the songs in the playlist's order.
  const [reordering, setReordering] = useState(false)
  // The server addresses slots by index, so removals run one at a time against this mirror of its order.
  const serverEntries = useRef<Entry[]>([])
  const removalQueue = useRef<Promise<void>>(Promise.resolve())

  const displayEntries = useMemo(() => {
    const visible = entries.filter((e) => !removing.has(e.key))
    if (sortMode === 'title') visible.sort((a, b) => a.song.title.localeCompare(b.song.title))
    else if (sortMode === 'artist') visible.sort((a, b) => a.song.artist.localeCompare(b.song.artist))
    else if (sortMode === 'duration') visible.sort((a, b) => a.song.duration - b.song.duration)
    return visible
  }, [entries, removing, sortMode])

  function handleRemove(key: string): void {
    if (!id) return
    setRemoving((prev) => new Set(prev).add(key))
    removalQueue.current = removalQueue.current.then(async () => {
      try {
        const index = serverEntries.current.findIndex((e) => e.key === key)
        if (index < 0) return
        await removeFromPlaylist(id, index)
        serverEntries.current = serverEntries.current.filter((e) => e.key !== key)
        setEntries(serverEntries.current)
        showToast('Retiré de la playlist')
      } catch {
        showToast('Impossible de retirer ce titre')
      } finally {
        setRemoving((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    })
  }

  /** Keeps the playlist on the phone (every song now, and those added later), or stops keeping it. */
  function toggleKept(keep: boolean): void {
    if (!id || !client) return
    const name = playlist?.name ?? 'Playlist'
    setKeptPlaylist(id, name, keep)
    if (keep) void downloadTracks(entries.map((e) => e.song), client, { label: name })
    else showToast('Les titres déjà téléchargés restent sur le téléphone')
  }

  /** A song dragged to another place: shown at once, then the whole order is saved (one change at a time, in order). */
  function handleMove(from: number, to: number): void {
    if (!id || !client) return
    const next = [...entries]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setEntries(next)
    const target = client
    removalQueue.current = removalQueue.current.then(async () => {
      try {
        await target.replacePlaylistSongs(id, next.map((e) => e.song.id))
        serverEntries.current = next
      } catch (err) {
        showToast(`Ordre non enregistré : ${err instanceof Error && err.message ? err.message : 'erreur inconnue'}`)
        setEntries(serverEntries.current)
      }
    })
  }
  const entryKey = useCallback((entry: Entry) => entry.key, [])

  function confirmDelete(): void {
    if (!id || !playlist) return
    Alert.alert('Supprimer la playlist ?', `« ${playlist.name} » sera définitivement supprimée.`, [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Supprimer',
        style: 'destructive',
        onPress: async () => {
          try {
            await deletePlaylist(id)
            showToast(`Playlist « ${playlist.name} » supprimée`)
            navigation.goBack()
          } catch (err: any) {
            showToast(err?.message || 'Impossible de supprimer la playlist')
          }
        }
      }
    ])
  }

  useEffect(() => {
    if (!client || !id) return
    let cancelled = false
    setLoading(true)
    client
      .getPlaylist(id)
      .then((res) => {
        if (cancelled) return
        const loaded = res.songs.map((song, i) => ({ key: `${i}:${song.id}`, song }))
        serverEntries.current = loaded
        setPlaylist(res.playlist)
        setEntries(loaded)
        setError(null)
        navigation.setOptions({ title: res.playlist?.name || 'Playlist' })
        prefetchCoverArt(client, res.songs.map((s) => s.coverArt || s.albumId), 100)
        // Kept on the phone: what was added since is fetched now that it is open.
        if (id in useOfflineStore.getState().keptPlaylists) {
          void useOfflineStore.getState().downloadTracks(res.songs, client, { quiet: true, label: res.playlist?.name })
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Playlist introuvable')
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

  if (error && !playlist) {
    return (
      <View style={[styles.container, styles.center]}>
        <EmptyState icon={ListMusic} title="Playlist indisponible" hint={error} action={{ label: 'Réessayer', onPress: () => setAttempt((n) => n + 1) }} />
      </View>
    )
  }

  // Playlists don't always carry their own coverArt id on the server; fall back to the
  // first track's art (already fetched, no extra request) so the header isn't blank.
  const firstSong = entries[0]?.song
  const coverId = playlist?.coverArt || firstSong?.coverArt || firstSong?.albumId
  const songs = displayEntries.map((e) => e.song)

  if (reordering) {
    return (
      <DragList
        style={styles.container}
        contentContainerStyle={styles.content}
        items={entries}
        keyOf={entryKey}
        rowHeight={REORDER_ROW}
        onMove={handleMove}
        gripColor={colors.textSecondary}
        activeBackground={colors.raised}
        header={
          <View style={styles.reorderHeader}>
            <Text style={styles.reorderHint}>Maintenez la poignée d’un titre et faites-le glisser à sa nouvelle place.</Text>
            <Pressable style={({ pressed }) => [styles.doneButton, pressed && styles.pressed]} onPress={() => setReordering(false)} accessibilityRole="button">
              <Text style={styles.doneText}>Terminé</Text>
            </Pressable>
          </View>
        }
        renderRow={(entry) => (
          <View style={styles.reorderRow}>
            <View style={styles.reorderInfo}>
              <Text style={styles.reorderTitle} numberOfLines={1}>
                {entry.song.title}
              </Text>
              <Text style={styles.reorderArtist} numberOfLines={1}>
                {entry.song.artist}
              </Text>
            </View>
          </View>
        )}
      />
    )
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      initialNumToRender={14}
      maxToRenderPerBatch={14}
      windowSize={7}
      removeClippedSubviews
      ListHeaderComponent={
        <View style={styles.header}>
          <CoverImage
            uri={coverId ? client.coverArtUrl(coverId, 600) : null}
            style={styles.cover}
            icon={ListMusic}
            iconSize={40}
            recyclingKey={playlist?.id}
          />
          <Text style={styles.name} numberOfLines={2}>
            {playlist?.name}
          </Text>
          <Text style={styles.meta}>{plural(displayEntries.length, 'titre', 'titres')}</Text>
          <View style={styles.actions}>
            <Pressable
              style={({ pressed }) => [styles.playButton, pressed && styles.pressed]}
              onPress={() => playQueue(songs, 0)}
              accessibilityRole="button"
              accessibilityLabel="Lire la playlist"
            >
              <Play size={16} color="#000" fill="#000" />
              <Text style={styles.playButtonText}>Lecture</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              onPress={() => downloadTracks(songs, client)}
              accessibilityRole="button"
              accessibilityLabel="Télécharger pour l'écoute hors ligne"
            >
              <HardDriveDownload size={16} color={colors.textSecondary} />
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              onPress={confirmDelete}
              accessibilityRole="button"
              accessibilityLabel="Supprimer la playlist"
            >
              <Trash2 size={16} color={colors.danger} />
            </Pressable>
          </View>
          <View style={styles.keepRow}>
            <View style={styles.keepText}>
              <Text style={styles.keepTitle}>Garder sur le téléphone</Text>
              <Text style={styles.keepHint}>Les titres ajoutés plus tard se téléchargent tout seuls, en Wi-Fi.</Text>
            </View>
            <Switch
              value={kept}
              onValueChange={toggleKept}
              trackColor={{ false: colors.hover, true: colors.accent }}
              thumbColor="#fff"
              accessibilityLabel="Garder la playlist sur le téléphone"
            />
          </View>
          <View style={styles.sortRow}>
            {SORT_OPTIONS.map((opt) => (
              <Pressable
                key={opt.key}
                onPress={() => setSortMode(opt.key)}
                style={[styles.sortPill, sortMode === opt.key && styles.sortPillActive]}
              >
                <Text style={[styles.sortPillText, sortMode === opt.key && styles.sortPillTextActive]}>{opt.label}</Text>
              </Pressable>
            ))}
            {entries.length > 1 && (
              <Pressable
                onPress={() => {
                  setSortMode('default')
                  setReordering(true)
                }}
                style={styles.sortPill}
                accessibilityRole="button"
                accessibilityLabel="Réorganiser la playlist"
              >
                <Text style={styles.sortPillText}>Réorganiser</Text>
              </Pressable>
            )}
          </View>
        </View>
      }
      data={displayEntries}
      keyExtractor={(e) => e.key}
      renderItem={({ item, index }) => (
        <TrackRow
          song={item.song}
          client={client}
          isCurrent={item.song.id === currentSongId}
          isPlaying={isPlaying}
          onPress={() => playQueue(songs, index)}
          onRemove={() => handleRemove(item.key)}
        />
      )}
    />
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.base },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.base },
  content: { paddingHorizontal: spacing.lg, paddingBottom: layout.contentBottom },
  header: { alignItems: 'center', marginBottom: spacing.lg },
  cover: {
    width: 200,
    height: 200,
    borderRadius: radius.lg,
    marginBottom: spacing.lg,
    elevation: 12,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 }
  },
  name: { color: colors.text, fontSize: 22, fontWeight: '800', textAlign: 'center', letterSpacing: -0.4 },
  meta: { color: colors.textSecondary, fontSize: 13, marginTop: spacing.xs },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg, alignItems: 'center' },
  pressed: { opacity: 0.6 },
  playButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md
  },
  playButtonText: { color: '#000', fontWeight: '700', fontSize: 14 },
  secondaryButton: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center'
  },
  sortRow: { flexDirection: 'row', gap: spacing.xs, marginTop: spacing.lg },
  sortPill: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.full, backgroundColor: colors.elevated },
  sortPillActive: { backgroundColor: colors.accent },
  sortPillText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  sortPillTextActive: { color: '#000' },
  keepRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.lg,
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  keepText: { flex: 1, minWidth: 0 },
  keepTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  keepHint: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  reorderHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  reorderHint: { flex: 1, color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  doneButton: { backgroundColor: colors.accent, borderRadius: radius.full, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  doneText: { color: '#000', fontWeight: '700', fontSize: 13 },
  reorderRow: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.sm },
  reorderInfo: { flex: 1, minWidth: 0 },
  reorderTitle: { color: colors.text, fontSize: 14, fontWeight: '500' },
  reorderArtist: { color: colors.textSecondary, fontSize: 12, marginTop: 2 }
})
