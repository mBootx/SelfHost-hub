import { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator, Alert } from 'react-native'
import { useLocalSearchParams, useNavigation } from 'expo-router'
import { Play, HardDriveDownload, ListMusic, Trash2 } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useOfflineStore } from '@/store/offlineStore'
import { useToastStore } from '@/store/toastStore'
import { NDPlaylist, NDSong } from '@/services/navidrome'
import { prefetchCoverArt } from '@/services/imagePrefetch'
import TrackRow from '@/components/navidrome/TrackRow'
import CoverImage from '@/components/CoverImage'
import { colors, layout, radius, spacing } from '@/constants/theme'

type SortMode = 'default' | 'title' | 'artist' | 'duration'

const SORT_OPTIONS: { key: SortMode; label: string }[] = [
  { key: 'default', label: 'Ordre' },
  { key: 'title', label: 'Titre' },
  { key: 'artist', label: 'Artiste' },
  { key: 'duration', label: 'Duree' }
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
  const removeFromPlaylist = useNavidromeStore((s) => s.removeFromPlaylist)
  const deletePlaylist = useNavidromeStore((s) => s.deletePlaylist)
  const showToast = useToastStore((s) => s.show)

  const [playlist, setPlaylist] = useState<NDPlaylist | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [sortMode, setSortMode] = useState<SortMode>('default')
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
        showToast('Retire de la playlist')
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

  function confirmDelete(): void {
    if (!id || !playlist) return
    Alert.alert('Supprimer la playlist', `"${playlist.name}" sera definitivement supprimee.`, [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Supprimer',
        style: 'destructive',
        onPress: async () => {
          try {
            await deletePlaylist(id)
            showToast(`Playlist "${playlist.name}" supprimee`)
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
    setLoading(true)
    client
      .getPlaylist(id)
      .then((res) => {
        const loaded = res.songs.map((song, i) => ({ key: `${i}:${song.id}`, song }))
        serverEntries.current = loaded
        setPlaylist(res.playlist)
        setEntries(loaded)
        navigation.setOptions({ title: res.playlist?.name || 'Playlist' })
        prefetchCoverArt(client, res.songs.map((s) => s.coverArt || s.albumId), 100)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [id, client])

  if (!client) return <View style={styles.container} />
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    )
  }

  // Playlists don't always carry their own coverArt id on the server; fall back to the
  // first track's art (already fetched, no extra request) so the header isn't blank.
  const firstSong = entries[0]?.song
  const coverId = playlist?.coverArt || firstSong?.coverArt || firstSong?.albumId
  const songs = displayEntries.map((e) => e.song)

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
          <Text style={styles.meta}>{displayEntries.length} titres</Text>
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
              accessibilityLabel="Telecharger pour l'ecoute hors-ligne"
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
  sortPillTextActive: { color: '#000' }
})
