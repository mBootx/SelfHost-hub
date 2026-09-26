import { useEffect, useMemo, useState } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useNavigation } from 'expo-router'
import { Play, HardDriveDownload, ListMusic } from 'lucide-react-native'
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

export default function PlaylistScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const navigation = useNavigation()
  const client = useNavidromeStore((s) => s.client)
  const playQueue = useNavidromeStore((s) => s.playQueue)
  const currentSongId = useNavidromeStore((s) => s.queue[s.queueIndex]?.id)
  const isPlaying = useNavidromeStore((s) => s.isPlaying)
  const downloadTracks = useOfflineStore((s) => s.downloadTracks)
  const removeFromPlaylist = useNavidromeStore((s) => s.removeFromPlaylist)
  const showToast = useToastStore((s) => s.show)

  const [playlist, setPlaylist] = useState<NDPlaylist | null>(null)
  const [songs, setSongs] = useState<NDSong[]>([])
  const [loading, setLoading] = useState(true)
  const [sortMode, setSortMode] = useState<SortMode>('default')

  // Sorting only changes what's displayed - removal still has to address the
  // song by its real position in the server's playlist, so each row keeps its
  // original index alongside wherever the sort puts it on screen.
  const displaySongs = useMemo(() => {
    const withIndex = songs.map((song, originalIndex) => ({ song, originalIndex }))
    if (sortMode === 'title') withIndex.sort((a, b) => a.song.title.localeCompare(b.song.title))
    else if (sortMode === 'artist') withIndex.sort((a, b) => a.song.artist.localeCompare(b.song.artist))
    else if (sortMode === 'duration') withIndex.sort((a, b) => a.song.duration - b.song.duration)
    return withIndex
  }, [songs, sortMode])

  async function handleRemove(index: number): Promise<void> {
    if (!id) return
    try {
      await removeFromPlaylist(id, index)
      setSongs((prev) => prev.filter((_, i) => i !== index))
      showToast('Retire de la playlist')
    } catch {
      showToast('Impossible de retirer ce titre')
    }
  }

  useEffect(() => {
    if (!client || !id) return
    setLoading(true)
    client
      .getPlaylist(id)
      .then((res) => {
        setPlaylist(res.playlist)
        setSongs(res.songs)
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
  const coverId = playlist?.coverArt || songs[0]?.coverArt || songs[0]?.albumId

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
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
          <Text style={styles.meta}>{songs.length} titres</Text>
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
      data={displaySongs}
      keyExtractor={(d) => `${d.song.id}-${d.originalIndex}`}
      renderItem={({ item, index }) => (
        <TrackRow
          song={item.song}
          client={client}
          isCurrent={item.song.id === currentSongId}
          isPlaying={isPlaying}
          onPress={() => playQueue(displaySongs.map((d) => d.song), index)}
          onRemove={() => handleRemove(item.originalIndex)}
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
