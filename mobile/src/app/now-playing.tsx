import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, BackHandler, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Cast,
  ChevronDown,
  Disc3,
  Ellipsis,
  Heart,
  ListMusic,
  ListPlus,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Sparkles
} from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useArtworkStore } from '@/store/artworkStore'
import { useRemoteStore, LOCAL_DEVICE_ID } from '@/store/remoteStore'
import { useToastStore } from '@/store/toastStore'
import { useStarStore, isStarred } from '@/store/starStore'
import { usePlaylistPickerStore } from '@/store/playlistPickerStore'
import { seekTo } from '@/services/playbackEngine'
import { fetchLyrics, LyricsResult } from '@/services/lyrics'
import { lookFor } from '@/services/coverColor'
import { useCoverColor } from '@/hooks/useCoverColor'
import ActionSheet, { ActionSheetItem } from '@/components/ActionSheet'
import CoverImage from '@/components/CoverImage'
import OfflineButton from '@/components/navidrome/OfflineButton'
import Backdrop from '@/components/nowplaying/Backdrop'
import LyricsCard from '@/components/nowplaying/LyricsCard'
import LyricsOverlay, { Box } from '@/components/nowplaying/LyricsOverlay'
import QueueView from '@/components/nowplaying/QueueView'
import SeekBar from '@/components/nowplaying/SeekBar'
import { colors, spacing } from '@/constants/theme'

type View_ = 'player' | 'queue'

const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75]

/** Page margin, and the height of the bar at the top. */
const SIDE = 24
const TOP_BAR = 52
/** How much of the lyrics card shows under the player before you scroll: its title and the first lines. */
const PEEK = 150
/** On a short phone the peek gives way to the cover, but never shrinks below the card's top edge. */
const MIN_PEEK = 24
/** Everything in the player block that isn't the cover: title, seek bar, buttons and the gaps between them. */
const PLAYER_CHROME = 306
const MIN_COVER = 180
const SOFT_WHITE = 'rgba(255,255,255,0.75)'

/**
 * The full-screen player, laid out like Spotify's: the cover as large as the phone allows, title and heart,
 * seek bar, transport buttons - and, just under the fold, the lyrics card, which opens into the full lyrics.
 * The whole page takes its colour from the cover.
 */
export default function NowPlayingScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()

  const client = useNavidromeStore((s) => s.client)
  const queue = useNavidromeStore((s) => s.queue)
  const queueIndex = useNavidromeStore((s) => s.queueIndex)
  const localIsPlaying = useNavidromeStore((s) => s.isPlaying)
  const togglePlay = useNavidromeStore((s) => s.togglePlay)
  const next = useNavidromeStore((s) => s.next)
  const prev = useNavidromeStore((s) => s.prev)
  const localShuffle = useNavidromeStore((s) => s.shuffle)
  const toggleShuffle = useNavidromeStore((s) => s.toggleShuffle)
  const localRepeatMode = useNavidromeStore((s) => s.repeatMode)
  const setRepeatMode = useNavidromeStore((s) => s.setRepeatMode)
  // Not subscribing to currentTime/duration here: SeekBar and the lyrics own that, so this screen stays still.
  const setProgress = useNavidromeStore((s) => s.setProgress)
  const playQueue = useNavidromeStore((s) => s.playQueue)
  const playbackRate = useNavidromeStore((s) => s.playbackRate)
  const setPlaybackRate = useNavidromeStore((s) => s.setPlaybackRate)
  const removeFromQueueAt = useNavidromeStore((s) => s.removeFromQueueAt)
  const reorderQueue = useNavidromeStore((s) => s.reorderQueue)
  const clearQueue = useNavidromeStore((s) => s.clearQueue)
  const showToast = useToastStore((s) => s.show)
  const openPlaylistPicker = usePlaylistPickerStore((s) => s.open)
  const toggleStar = useStarStore((s) => s.toggle)

  const selectedDeviceId = useRemoteStore((s) => s.selectedDeviceId)
  const sendCommand = useRemoteStore((s) => s.sendCommand)
  const deviceList = useRemoteStore((s) => s.deviceList)
  const remoteDevice = useRemoteStore((s) =>
    s.selectedDeviceId !== LOCAL_DEVICE_ID ? s.devices[s.selectedDeviceId] : undefined
  )
  const isRemote = selectedDeviceId !== LOCAL_DEVICE_ID

  const [view, setView] = useState<View_>('player')
  const [menuOpen, setMenuOpen] = useState(false)
  const [lyrics, setLyrics] = useState<LyricsResult | null>(null)
  const [loadingLyrics, setLoadingLyrics] = useState(false)
  const [searching, setSearching] = useState(false)
  // The full lyrics page: mounted while it is on screen or animating away, open while it is meant to be there.
  const [lyricsMounted, setLyricsMounted] = useState(false)
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const [origin, setOrigin] = useState<Box | null>(null)
  const [bounds, setBounds] = useState({ width, height })
  const [viewport, setViewport] = useState(0)
  const rootRef = useRef<View>(null)
  const cardRef = useRef<View>(null)

  const localSong = queue[queueIndex] || null
  // Local playback, unless a remote device is the active output - see remoteStore.selectDevice.
  const song = isRemote ? remoteDevice?.song ?? null : localSong
  const isPlaying = isRemote ? !!remoteDevice?.isPlaying : localIsPlaying
  const shuffle = isRemote ? !!remoteDevice?.shuffle : localShuffle
  const repeatMode = isRemote ? remoteDevice?.repeatMode ?? 'off' : localRepeatMode
  const starred = useStarStore((s) => (song ? isStarred(s, song) : false))

  const artworkKey = song?.albumId || song?.id
  const override = useArtworkStore((s) => (artworkKey ? s.overrides[artworkKey] : undefined))
  const searchArtwork = useArtworkStore((s) => s.search)

  const coverUrl = song && client ? (song.coverArt || song.albumId ? client.coverArtUrl(song.coverArt || song.albumId || song.id, 600) : override || null) : null
  const tint = useCoverColor(coverUrl)
  const look = useMemo(() => lookFor(tint), [tint])

  // The cover is as wide as the page allows, unless the phone is too short to also fit the controls; the
  // player block then fills the screen except for the lyrics card's peek (a sliver on a short phone).
  const scrollHeight = viewport || height - insets.top - TOP_BAR
  const coverSize = Math.max(MIN_COVER, Math.min(width - SIDE * 2, scrollHeight - PLAYER_CHROME - MIN_PEEK))
  const playerHeight = Math.max(scrollHeight - PEEK, coverSize + PLAYER_CHROME)

  // Lyrics follow the track. The exact LRCLIB lookup is cheap and cached, so it runs on its own; the wider
  // search stays behind the button.
  useEffect(() => {
    if (!song) return
    let cancelled = false
    setLyrics(null)
    setLoadingLyrics(true)
    fetchLyrics(song)
      .then((res) => {
        if (!cancelled) setLyrics(res)
      })
      .finally(() => {
        if (!cancelled) setLoadingLyrics(false)
      })
    return () => {
      cancelled = true
    }
  }, [song?.id])

  // A song with no lyrics leaves nothing to show on the full page: it folds back into the player.
  useEffect(() => {
    if (lyricsOpen && !loadingLyrics && !lyrics) setLyricsOpen(false)
  }, [lyricsOpen, loadingLyrics, lyrics])

  // Back closes what is on top - the lyrics, then the queue - before it leaves the screen.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (lyricsOpen) {
        setLyricsOpen(false)
        return true
      }
      if (view === 'queue') {
        setView('player')
        return true
      }
      return false
    })
    return () => subscription.remove()
  }, [lyricsOpen, view])

  const openLyrics = useCallback(() => {
    const show = (box: Box | null): void => {
      setOrigin(box)
      setLyricsMounted(true)
      setLyricsOpen(true)
    }
    const root = rootRef.current
    const card = cardRef.current
    if (!root || !card) return show(null)
    // The page grows out of the card, so where the card is on screen is measured against the page itself.
    root.measureInWindow((rootX, rootY) =>
      card.measureInWindow((x, y, w, h) => show({ x: x - rootX, y: y - rootY, width: w, height: h }))
    )
  }, [])
  const closeLyrics = useCallback(() => setLyricsOpen(false), [])
  const lyricsClosed = useCallback(() => setLyricsMounted(false), [])

  const seekToLine = useCallback(
    (seconds: number) => {
      if (isRemote) {
        sendCommand('seek', { seconds })
        return
      }
      seekTo(seconds)
      setProgress(seconds, useNavidromeStore.getState().duration)
    },
    [isRemote, sendCommand, setProgress]
  )

  async function handleAutoSearch(): Promise<void> {
    if (!song || !client) return
    setSearching(true)
    const found: string[] = []
    try {
      if (!lyrics) {
        const res = await fetchLyrics(song, {
          wide: true,
          navidromeLookup: (artist, title) => client.getLyrics(artist, title)
        })
        if (res) {
          setLyrics(res)
          found.push(res.synced ? 'paroles synchronisées' : 'paroles')
        }
      }
      // Navidrome already having art wins; only go looking when it has none and
      // we haven't previously found one for this album.
      const hasServerArt = !!(song.coverArt || song.albumId)
      if (!hasServerArt && !override && artworkKey && song.album) {
        const url = await searchArtwork(artworkKey, song.artist, song.album)
        if (url) found.push('pochette')
      }
    } catch {
      // the providers are best-effort; the alert below reports the outcome
    } finally {
      setSearching(false)
    }
    Alert.alert('Recherche automatique', found.length > 0 ? `Trouvé : ${found.join(' et ')}.` : 'Rien trouvé pour ce titre.')
  }

  function cycleRepeat(): void {
    const mode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off'
    if (isRemote) sendCommand('setRepeatMode', { mode })
    else setRepeatMode(mode)
  }
  function cycleSpeed(): void {
    const idx = SPEEDS.indexOf(playbackRate)
    setPlaybackRate(SPEEDS[(idx + 1) % SPEEDS.length])
  }
  function handleTogglePlay(): void {
    if (isRemote) sendCommand('toggle')
    else togglePlay()
  }
  function handleNext(): void {
    if (isRemote) sendCommand('next')
    else next()
  }
  function handlePrev(): void {
    if (isRemote) sendCommand('prev')
    else prev()
  }
  function handleToggleShuffle(): void {
    if (isRemote) sendCommand('toggleShuffle')
    else toggleShuffle()
  }
  function toggleHeart(): void {
    if (song && client) toggleStar(song, client)
  }

  if (!song || !client) {
    return (
      <View style={[styles.root, styles.centered]}>
        <Pressable
          onPress={() => router.back()}
          style={[styles.closeIcon, { top: insets.top + spacing.lg }]}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Fermer"
        >
          <ChevronDown size={28} color={colors.text} />
        </Pressable>
        <Text style={styles.emptyText}>Aucune lecture en cours</Text>
      </View>
    )
  }

  const deviceName = deviceList.find((d) => d.deviceId === selectedDeviceId)?.deviceName || 'Appareil distant'
  const menuItems: ActionSheetItem[] = [
    { label: 'Ajouter à une playlist', icon: ListPlus, onPress: () => openPlaylistPicker(song) },
    { label: starred ? 'Retirer des favoris' : 'Ajouter aux favoris', icon: Heart, onPress: toggleHeart },
    ...(song.albumId
      ? [{ label: "Voir l'album", icon: Disc3, onPress: () => router.push({ pathname: '/album/[id]', params: { id: song.albumId! } }) }]
      : []),
    { label: 'Recherche auto (paroles, pochette)', icon: Sparkles, onPress: handleAutoSearch }
  ]

  return (
    <View ref={rootRef} collapsable={false} style={styles.root} onLayout={(e) => setBounds(e.nativeEvent.layout)}>
      <Backdrop look={look} />

      <View style={[styles.topBar, { marginTop: insets.top }]}>
        <Pressable
          onPress={() => (view === 'queue' ? setView('player') : router.back())}
          hitSlop={12}
          style={styles.topButton}
          accessibilityRole="button"
          accessibilityLabel={view === 'queue' ? 'Retour au lecteur' : 'Fermer'}
        >
          <ChevronDown size={28} color="#ffffff" />
        </Pressable>
        <View style={styles.topCenter}>
          {view === 'queue' ? (
            <Text style={styles.topTitle}>{"File d'attente"}</Text>
          ) : song.album ? (
            <>
              <Text style={styles.topLabel} numberOfLines={1}>
                {"LECTURE DEPUIS L'ALBUM"}
              </Text>
              <Text style={styles.topTitle} numberOfLines={1}>
                {song.album}
              </Text>
            </>
          ) : null}
        </View>
        {view === 'player' ? (
          <Pressable onPress={() => setMenuOpen(true)} hitSlop={12} style={styles.topButton} accessibilityRole="button" accessibilityLabel="Plus d'options">
            <Ellipsis size={24} color="#ffffff" />
          </Pressable>
        ) : (
          <View style={styles.topButton} />
        )}
      </View>

      {view === 'queue' ? (
        <QueueView
          queue={queue}
          queueIndex={queueIndex}
          bottomInset={insets.bottom}
          onPlay={(i) => playQueue(queue, i)}
          onRemove={removeFromQueueAt}
          onMove={reorderQueue}
          onClear={() => {
            clearQueue()
            showToast('File de lecture vidée')
          }}
        />
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
          showsVerticalScrollIndicator={false}
          onLayout={(e) => setViewport(e.nativeEvent.layout.height)}
        >
          <View style={[styles.player, { minHeight: playerHeight }]}>
            <View style={styles.coverWrap}>
              <View style={[styles.coverShadow, { width: coverSize, height: coverSize }]}>
                <CoverImage uri={coverUrl} style={{ width: coverSize, height: coverSize, borderRadius: COVER_RADIUS }} iconSize={56} recyclingKey={song.id} />
              </View>
            </View>

            <View>
              <View style={styles.titleRow}>
                <View style={styles.titleText}>
                  <Text style={styles.title} numberOfLines={1}>
                    {song.title}
                  </Text>
                  <Text style={styles.artist} numberOfLines={1}>
                    {song.artist}
                  </Text>
                </View>
                <Pressable
                  onPress={toggleHeart}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel={starred ? 'Retirer des favoris' : 'Ajouter aux favoris'}
                >
                  <Heart size={28} color={starred ? colors.accent : '#ffffff'} fill={starred ? colors.accent : 'none'} />
                </Pressable>
              </View>
              <SeekBar />
            </View>

            <View>
              <View style={styles.controls}>
                <Pressable onPress={handleToggleShuffle} hitSlop={12} accessibilityRole="button" accessibilityLabel="Lecture aléatoire">
                  <Shuffle size={24} color={shuffle ? colors.accent : SOFT_WHITE} />
                </Pressable>
                <Pressable onPress={handlePrev} hitSlop={12} accessibilityRole="button" accessibilityLabel="Titre précédent">
                  <SkipBack size={34} color="#ffffff" fill="#ffffff" />
                </Pressable>
                <Pressable style={styles.playButton} onPress={handleTogglePlay} accessibilityRole="button" accessibilityLabel={isPlaying ? 'Pause' : 'Lecture'}>
                  {isPlaying ? <Pause size={30} color="#000000" fill="#000000" /> : <Play size={30} color="#000000" fill="#000000" />}
                </Pressable>
                <Pressable onPress={handleNext} hitSlop={12} accessibilityRole="button" accessibilityLabel="Titre suivant">
                  <SkipForward size={34} color="#ffffff" fill="#ffffff" />
                </Pressable>
                <Pressable onPress={cycleRepeat} hitSlop={12} accessibilityRole="button" accessibilityLabel="Répétition">
                  {repeatMode === 'one' ? (
                    <Repeat1 size={24} color={colors.accent} />
                  ) : (
                    <Repeat size={24} color={repeatMode === 'all' ? colors.accent : SOFT_WHITE} />
                  )}
                </Pressable>
              </View>

              <View style={styles.bottomRow}>
                <Pressable
                  style={styles.deviceButton}
                  onPress={() => router.push('/devices')}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Changer d'appareil de sortie"
                >
                  <Cast size={22} color={isRemote ? colors.accent : SOFT_WHITE} />
                  {isRemote && (
                    <Text style={styles.deviceName} numberOfLines={1}>
                      {deviceName}
                    </Text>
                  )}
                </Pressable>
                <View style={styles.bottomRight}>
                  {!isRemote && (
                    <Pressable onPress={cycleSpeed} hitSlop={10} accessibilityRole="button" accessibilityLabel="Vitesse de lecture">
                      <Text style={[styles.speed, playbackRate !== 1 && styles.speedActive]}>{playbackRate}x</Text>
                    </Pressable>
                  )}
                  <OfflineButton song={song} client={client} size={22} idleColor={SOFT_WHITE} />
                  <Pressable onPress={() => setView('queue')} hitSlop={10} accessibilityRole="button" accessibilityLabel="File de lecture">
                    <ListMusic size={22} color={SOFT_WHITE} />
                  </Pressable>
                </View>
              </View>
            </View>
          </View>

          <View style={styles.lyricsWrap}>
            <LyricsCard
              key={song.id}
              look={look}
              lines={lyrics?.synced ?? null}
              plain={lyrics?.plain ?? null}
              loading={loadingLyrics}
              searching={searching}
              onOpen={openLyrics}
              onAutoSearch={handleAutoSearch}
              cardRef={cardRef}
            />
          </View>
        </ScrollView>
      )}

      {lyricsMounted && (
        <LyricsOverlay
          open={lyricsOpen}
          songId={song.id}
          look={look}
          title={song.title}
          artist={song.artist}
          lines={lyrics?.synced ?? null}
          plain={lyrics?.plain ?? null}
          bounds={bounds}
          origin={origin}
          insets={insets}
          isPlaying={isPlaying}
          onTogglePlay={handleTogglePlay}
          onPrev={handlePrev}
          onNext={handleNext}
          onSeek={seekToLine}
          onClose={closeLyrics}
          onClosed={lyricsClosed}
        />
      )}

      <ActionSheet visible={menuOpen} title={song.title} items={menuItems} onClose={() => setMenuOpen(false)} />
    </View>
  )
}

const COVER_RADIUS = 10

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base },
  centered: { alignItems: 'center', justifyContent: 'center' },
  closeIcon: { position: 'absolute', left: spacing.lg },
  emptyText: { color: colors.textSecondary },
  topBar: { height: TOP_BAR, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg },
  topButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  topCenter: { flex: 1, alignItems: 'center', paddingHorizontal: spacing.sm },
  topLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  topTitle: { color: '#ffffff', fontSize: 13, fontWeight: '800', marginTop: 1 },
  scroll: { flex: 1 },
  player: { paddingHorizontal: SIDE, paddingTop: spacing.sm, justifyContent: 'space-between' },
  coverWrap: { alignItems: 'center' },
  coverShadow: {
    borderRadius: COVER_RADIUS,
    backgroundColor: colors.elevated,
    elevation: 18,
    shadowColor: '#000000',
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 }
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm },
  titleText: { flex: 1, minWidth: 0 },
  title: { color: '#ffffff', fontSize: 23, fontWeight: '800' },
  artist: { color: 'rgba(255,255,255,0.7)', fontSize: 16, marginTop: 2 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.lg },
  playButton: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center' },
  bottomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.xl, minHeight: 32 },
  deviceButton: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  deviceName: { color: colors.accent, fontSize: 12, fontWeight: '700', flexShrink: 1 },
  bottomRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  speed: { color: SOFT_WHITE, fontSize: 13, fontWeight: '800', minWidth: 32, textAlign: 'center' },
  speedActive: { color: colors.accent },
  lyricsWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md }
})
