import { useEffect, useState } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useNavigation } from 'expo-router'
import { Play, HardDriveDownload, Download } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useOfflineStore } from '@/store/offlineStore'
import { useDowntifyStore } from '@/store/downtifyStore'
import { NDAlbum, NDSong } from '@/services/navidrome'
import { prefetchCoverArt } from '@/services/imagePrefetch'
import TrackRow from '@/components/navidrome/TrackRow'
import CoverImage from '@/components/CoverImage'
import { colors, layout, radius, spacing } from '@/constants/theme'

export default function AlbumScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const navigation = useNavigation()
  const client = useNavidromeStore((s) => s.client)
  const playQueue = useNavidromeStore((s) => s.playQueue)
  const currentSongId = useNavidromeStore((s) => s.queue[s.queueIndex]?.id)
  const isPlaying = useNavidromeStore((s) => s.isPlaying)
  const downloadTracks = useOfflineStore((s) => s.downloadTracks)
  const downtifyStatus = useDowntifyStore((s) => s.status)
  const requestDownload = useDowntifyStore((s) => s.requestDownload)

  const [album, setAlbum] = useState<NDAlbum | null>(null)
  const [songs, setSongs] = useState<NDSong[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!client || !id) return
    setLoading(true)
    client
      .getAlbum(id)
      .then((res) => {
        setAlbum(res.album)
        setSongs(res.songs)
        navigation.setOptions({ title: res.album?.name || 'Album' })
        // Beyond the FlatList's initial render window, a track's thumbnail
        // would otherwise only start loading once you scroll to it.
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

  const meta = [album?.artist, album?.year || null, `${songs.length} titres`].filter(Boolean).join(' · ')

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.content}
      data={songs}
      keyExtractor={(s) => s.id}
      showsVerticalScrollIndicator={false}
      ListHeaderComponent={
        <View style={styles.header}>
          <CoverImage
            uri={album?.coverArt ? client.coverArtUrl(album.coverArt, 600) : null}
            style={styles.cover}
            iconSize={40}
            recyclingKey={album?.id}
          />
          <Text style={styles.albumName} numberOfLines={2}>
            {album?.name}
          </Text>
          <Text style={styles.albumMeta}>{meta}</Text>
          <View style={styles.actions}>
            <Pressable
              style={({ pressed }) => [styles.playButton, pressed && styles.pressed]}
              onPress={() => playQueue(songs, 0)}
              accessibilityRole="button"
              accessibilityLabel="Lire l'album"
            >
              <Play size={16} color="#000" fill="#000" />
              <Text style={styles.playButtonText}>Lecture</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              onPress={() => downloadTracks(songs, client)}
              accessibilityRole="button"
              accessibilityLabel="Télécharger pour l'écoute hors-ligne"
            >
              <HardDriveDownload size={16} color={colors.textSecondary} />
            </Pressable>
            {downtifyStatus === 'connected' && (
              <Pressable
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                onPress={() => requestDownload(`${album?.artist} - ${album?.name}`, 'album')}
                accessibilityRole="button"
                accessibilityLabel="Envoyer à Downtify"
              >
                <Download size={16} color={colors.textSecondary} />
              </Pressable>
            )}
          </View>
        </View>
      }
      renderItem={({ item, index }) => (
        <TrackRow
          song={item}
          client={client}
          isCurrent={item.id === currentSongId}
          isPlaying={isPlaying}
          onPress={() => playQueue(songs, index)}
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
  albumName: { color: colors.text, fontSize: 22, fontWeight: '800', textAlign: 'center', letterSpacing: -0.4 },
  albumMeta: { color: colors.textSecondary, fontSize: 13, marginTop: spacing.xs, textAlign: 'center' },
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
  }
})
