import { useState } from 'react'
import { View, Text, ScrollView, FlatList, Pressable, RefreshControl, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { ListMusic, Music } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useHistoryStore, HistoryEntry } from '@/store/historyStore'
import { NDPlaylist } from '@/services/navidrome'
import NavidromeGate from '@/components/navidrome/NavidromeGate'
import AlbumTile from '@/components/navidrome/AlbumTile'
import CoverImage from '@/components/CoverImage'
import { Screen, ScreenHeader, SectionTitle, EmptyState } from '@/components/Screen'
import { colors, layout, radius, spacing } from '@/constants/theme'

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 6) return 'Bonne nuit'
  if (hour < 18) return 'Bonjour'
  return 'Bonsoir'
}

/** Compact two-up row used for the quick-access grid at the top of the screen. */
function PlaylistChip({ playlist }: { playlist: NDPlaylist }) {
  const router = useRouter()
  const client = useNavidromeStore((s) => s.client)

  return (
    <Pressable
      style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
      onPress={() => router.push({ pathname: '/playlist/[id]', params: { id: playlist.id } })}
      accessibilityRole="button"
      accessibilityLabel={playlist.name}
    >
      <CoverImage
        uri={playlist.coverArt && client ? client.coverArtUrl(playlist.coverArt, 100) : null}
        style={styles.chipCover}
        icon={ListMusic}
        iconSize={18}
        recyclingKey={playlist.id}
      />
      <Text style={styles.chipText} numberOfLines={2}>
        {playlist.name}
      </Text>
    </Pressable>
  )
}

function HistoryTile({ entry }: { entry: HistoryEntry }) {
  const client = useNavidromeStore((s) => s.client)
  const playQueue = useNavidromeStore((s) => s.playQueue)
  const coverId = entry.coverArt || entry.albumId

  return (
    <Pressable
      style={({ pressed }) => [styles.historyTile, pressed && styles.pressed]}
      onPress={() => playQueue([entry], 0)}
      accessibilityRole="button"
      accessibilityLabel={`${entry.title}, ${entry.artist}`}
    >
      <CoverImage
        uri={coverId && client ? client.coverArtUrl(coverId, 200) : null}
        style={styles.historyCover}
        iconSize={20}
        recyclingKey={entry.id}
      />
      <Text style={styles.historyTitle} numberOfLines={1}>
        {entry.title}
      </Text>
      <Text style={styles.historyArtist} numberOfLines={1}>
        {entry.artist}
      </Text>
    </Pressable>
  )
}

function ArtistBubble({ id, name, coverArt }: { id: string; name: string; coverArt?: string }) {
  const router = useRouter()
  const client = useNavidromeStore((s) => s.client)

  return (
    <Pressable
      style={({ pressed }) => [styles.bubble, pressed && styles.pressed]}
      onPress={() => router.push({ pathname: '/artist/[id]', params: { id } })}
      accessibilityRole="button"
      accessibilityLabel={name}
    >
      <CoverImage
        uri={coverArt && client ? client.coverArtUrl(coverArt, 200) : null}
        style={styles.bubbleAvatar}
        iconSize={22}
        recyclingKey={id}
      />
      <Text style={styles.bubbleName} numberOfLines={1}>
        {name}
      </Text>
    </Pressable>
  )
}

function HomeContent() {
  const username = useNavidromeStore((s) => s.username)
  const recentAlbums = useNavidromeStore((s) => s.recentAlbums)
  const playlists = useNavidromeStore((s) => s.playlists)
  const artists = useNavidromeStore((s) => s.artists)
  const loadLibrary = useNavidromeStore((s) => s.loadLibrary)
  const history = useHistoryStore((s) => s.entries)
  const [refreshing, setRefreshing] = useState(false)

  async function handleRefresh(): Promise<void> {
    setRefreshing(true)
    await loadLibrary()
    setRefreshing(false)
  }

  const quickPlaylists = playlists.slice(0, 6)
  const isEmpty = recentAlbums.length === 0 && playlists.length === 0 && artists.length === 0

  return (
    <Screen>
      <ScreenHeader title={username ? `${greeting()}, ${username}` : greeting()} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} colors={[colors.accent]} />
        }
      >
        {isEmpty && <EmptyState icon={Music} title="Bibliothèque vide" hint="Tirez vers le bas pour recharger depuis le serveur." />}

        {quickPlaylists.length > 0 && (
          <View style={styles.quickGrid}>
            {quickPlaylists.map((p) => (
              <PlaylistChip key={p.id} playlist={p} />
            ))}
          </View>
        )}

        {history.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <SectionTitle>Récemment écouté</SectionTitle>
            </View>
            <FlatList
              horizontal
              data={history.slice(0, 15)}
              keyExtractor={(h, i) => `${h.id}-${i}`}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.rail}
              renderItem={({ item }) => <HistoryTile entry={item} />}
            />
          </View>
        )}

        {recentAlbums.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <SectionTitle>Ajouts récents</SectionTitle>
            </View>
            <FlatList
              horizontal
              data={recentAlbums}
              keyExtractor={(a) => a.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.rail}
              renderItem={({ item }) => <AlbumTile album={item} variant="rail" />}
            />
          </View>
        )}

        {artists.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <SectionTitle>Artistes</SectionTitle>
            </View>
            <FlatList
              horizontal
              data={artists.slice(0, 20)}
              keyExtractor={(a) => a.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.rail}
              renderItem={({ item }) => <ArtistBubble id={item.id} name={item.name} coverArt={item.coverArt} />}
            />
          </View>
        )}
      </ScrollView>
    </Screen>
  )
}

export default function HomeTab() {
  return (
    <NavidromeGate>
      <HomeContent />
    </NavidromeGate>
  )
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: layout.contentBottom },
  section: { marginTop: spacing.lg },
  // The rails bleed to the screen edge, so horizontal padding sits on the rail
  // content and the section heading rather than on the scroll container.
  sectionHead: { paddingHorizontal: spacing.lg },
  rail: { paddingHorizontal: spacing.lg },
  quickGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    gap: spacing.sm
  },
  chip: {
    width: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.elevated,
    borderRadius: radius.sm,
    overflow: 'hidden',
    paddingRight: spacing.sm
  },
  chipCover: { width: 48, height: 48 },
  chipText: { flex: 1, color: colors.text, fontSize: 12, fontWeight: '600' },
  bubble: { width: 84, marginRight: spacing.md, alignItems: 'center', gap: spacing.xs },
  bubbleAvatar: { width: 72, height: 72, borderRadius: radius.full },
  bubbleName: { color: colors.textSecondary, fontSize: 11, textAlign: 'center' },
  historyTile: { width: 110, marginRight: spacing.md },
  historyCover: { width: 110, height: 110, borderRadius: radius.sm, marginBottom: spacing.xs },
  historyTitle: { color: colors.text, fontSize: 12, fontWeight: '600' },
  historyArtist: { color: colors.textMuted, fontSize: 11, marginTop: 1 },
  pressed: { opacity: 0.6 }
})
