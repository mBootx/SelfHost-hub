import { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, Alert, StyleSheet, ScrollView } from 'react-native'
import Slider from '@react-native-community/slider'
import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  ChevronDown,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Repeat1,
  ListMusic,
  Sparkles,
  Cast,
  ChevronUp,
  X
} from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useOfflineStore } from '@/store/offlineStore'
import { useArtworkStore } from '@/store/artworkStore'
import { useRemoteStore, LOCAL_DEVICE_ID } from '@/store/remoteStore'
import { useToastStore } from '@/store/toastStore'
import { seekTo } from '@/services/playbackEngine'
import { fetchLyrics, LyricsResult } from '@/services/lyrics'
import OfflineButton from '@/components/navidrome/OfflineButton'
import LyricsView from '@/components/navidrome/LyricsView'
import CoverImage from '@/components/CoverImage'
import { colors, radius, spacing } from '@/constants/theme'

type NowPlayingView = 'player' | 'queue'

const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75]

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Owns the playhead subscription so the artwork, title and transport buttons
 * above it stop re-rendering four times a second. Follows whichever device is
 * selected: local ticks come straight from the store, a remote device's
 * progress comes from its last reported state.
 */
function PlayerProgress() {
  const selectedDeviceId = useRemoteStore((s) => s.selectedDeviceId)
  const isRemote = selectedDeviceId !== LOCAL_DEVICE_ID
  const localCurrentTime = useNavidromeStore((s) => s.currentTime)
  const localDuration = useNavidromeStore((s) => s.duration)
  const remote = useRemoteStore((s) => (isRemote ? s.devices[selectedDeviceId] : undefined))
  const setProgress = useNavidromeStore((s) => s.setProgress)
  const sendCommand = useRemoteStore((s) => s.sendCommand)

  const currentTime = isRemote ? remote?.currentTime ?? 0 : localCurrentTime
  const duration = isRemote ? remote?.duration ?? 0 : localDuration

  return (
    <>
      <Slider
        style={styles.slider}
        minimumValue={0}
        maximumValue={duration || 0}
        value={currentTime}
        minimumTrackTintColor={colors.accent}
        maximumTrackTintColor={colors.hover}
        thumbTintColor={colors.text}
        onSlidingComplete={(value) => {
          if (isRemote) {
            sendCommand('seek', { seconds: value })
          } else {
            seekTo(value)
            setProgress(value, duration)
          }
        }}
      />
      <View style={styles.timeRow}>
        <Text style={styles.time}>{formatTime(currentTime)}</Text>
        <Text style={styles.time}>{formatTime(duration)}</Text>
      </View>
    </>
  )
}

export default function NowPlayingScreen() {
  const router = useRouter()
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
  // Deliberately not subscribing to currentTime/duration here: PlayerProgress and
  // LyricsView own that subscription so this screen doesn't redraw on every tick.
  const setProgress = useNavidromeStore((s) => s.setProgress)
  const playQueue = useNavidromeStore((s) => s.playQueue)
  const playbackRate = useNavidromeStore((s) => s.playbackRate)
  const setPlaybackRate = useNavidromeStore((s) => s.setPlaybackRate)
  const removeFromQueueAt = useNavidromeStore((s) => s.removeFromQueueAt)
  const reorderQueue = useNavidromeStore((s) => s.reorderQueue)
  const clearQueue = useNavidromeStore((s) => s.clearQueue)
  const showToast = useToastStore((s) => s.show)

  const selectedDeviceId = useRemoteStore((s) => s.selectedDeviceId)
  const sendCommand = useRemoteStore((s) => s.sendCommand)
  const deviceList = useRemoteStore((s) => s.deviceList)
  const remoteDevice = useRemoteStore((s) =>
    s.selectedDeviceId !== LOCAL_DEVICE_ID ? s.devices[s.selectedDeviceId] : undefined
  )
  const isRemote = selectedDeviceId !== LOCAL_DEVICE_ID

  const [view, setView] = useState<NowPlayingView>('player')
  const [confirmClearQueue, setConfirmClearQueue] = useState(false)
  const [lyrics, setLyrics] = useState<LyricsResult | null>(null)
  const [loadingLyrics, setLoadingLyrics] = useState(false)
  const [searching, setSearching] = useState(false)

  // The lyrics no longer own their own bounded scroll area - the whole player
  // view is one ScrollView now, so following the active line has to scroll this
  // page using the lyrics section's own offset within it (see LyricsView).
  const scrollRef = useRef<ScrollView>(null)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [lyricsOffset, setLyricsOffset] = useState(0)

  const localSong = queue[queueIndex] || null
  // Local playback, unless a remote device is the active output - see
  // remoteStore.selectDevice, which pauses local audio the moment that happens.
  const song = isRemote ? remoteDevice?.song ?? null : localSong
  const isPlaying = isRemote ? !!remoteDevice?.isPlaying : localIsPlaying
  const shuffle = isRemote ? !!remoteDevice?.shuffle : localShuffle
  const repeatMode = isRemote ? remoteDevice?.repeatMode ?? 'off' : localRepeatMode
  const isOffline = useOfflineStore((s) => (song ? !!s.tracks[song.id] : false))

  const artworkKey = song?.albumId || song?.id
  const override = useArtworkStore((s) => (artworkKey ? s.overrides[artworkKey] : undefined))
  const searchArtwork = useArtworkStore((s) => s.search)

  // Lyrics follow the track. The exact LRCLIB lookup is cheap and cached, so it
  // runs on its own; the wider search stays behind the button.
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
          found.push(res.synced ? 'paroles synchronisees' : 'paroles')
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
    Alert.alert(
      'Recherche automatique',
      found.length > 0 ? `Trouve : ${found.join(' et ')}.` : 'Rien trouve pour ce titre.'
    )
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

  if (!song || !client) {
    return (
      <SafeAreaView edges={['top']} style={styles.center}>
        <Pressable onPress={() => router.back()} style={styles.closeIcon} hitSlop={12} accessibilityLabel="Fermer">
          <ChevronDown size={26} color={colors.text} />
        </Pressable>
        <Text style={styles.emptyText}>Aucune lecture en cours</Text>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.container}>
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Fermer">
          <ChevronDown size={26} color={colors.text} />
        </Pressable>
        {isOffline && (
          <View style={styles.offlineBadge}>
            <Text style={styles.offlineBadgeText}>Hors-ligne</Text>
          </View>
        )}
        {isRemote && (
          <Pressable
            style={styles.castBadge}
            onPress={() => router.push('/devices')}
            accessibilityRole="button"
            accessibilityLabel="Changer d'appareil de sortie"
          >
            <Cast size={12} color={colors.accent} />
            <Text style={styles.castBadgeText} numberOfLines={1}>
              {deviceList.find((d) => d.deviceId === selectedDeviceId)?.deviceName || 'Appareil distant'}
            </Text>
          </Pressable>
        )}
        <Pressable
          onPress={handleAutoSearch}
          hitSlop={12}
          disabled={searching}
          accessibilityRole="button"
          accessibilityLabel="Recherche automatique des paroles et de la pochette"
        >
          <Sparkles size={21} color={searching ? colors.accent : colors.textSecondary} />
        </Pressable>
        <Pressable
          onPress={() => setView((v) => (v === 'queue' ? 'player' : 'queue'))}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="File de lecture"
        >
          <ListMusic size={21} color={view === 'queue' ? colors.accent : colors.text} />
        </Pressable>
      </View>

      {view === 'queue' ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md }}>
          <View style={styles.queueHeader}>
            <Text style={styles.queueTitle}>File de lecture - {queue.length} titres</Text>
            {queue.length > 0 &&
              (confirmClearQueue ? (
                <View style={styles.confirmRow}>
                  <Text style={styles.confirmText}>Vider ?</Text>
                  <Pressable
                    onPress={() => {
                      clearQueue()
                      setConfirmClearQueue(false)
                      showToast('File de lecture videe')
                    }}
                    hitSlop={8}
                  >
                    <Text style={styles.confirmYes}>Oui</Text>
                  </Pressable>
                  <Pressable onPress={() => setConfirmClearQueue(false)} hitSlop={8}>
                    <Text style={styles.confirmCancel}>Annuler</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable onPress={() => setConfirmClearQueue(true)} hitSlop={8}>
                  <Text style={styles.clearLink}>Vider</Text>
                </Pressable>
              ))}
          </View>
          {queue.map((s, i) => (
            <View key={`${s.id}-${i}`} style={[styles.queueRow, i === queueIndex && styles.queueRowActive]}>
              <Pressable style={styles.queueRowMain} onPress={() => playQueue(queue, i)}>
                <Text style={[styles.queueRowText, i === queueIndex && styles.queueRowTextActive]} numberOfLines={1}>
                  {s.title} <Text style={styles.queueRowArtist}>- {s.artist}</Text>
                </Text>
              </Pressable>
              <Pressable onPress={() => reorderQueue(i, i - 1)} disabled={i === 0} hitSlop={8}>
                <ChevronUp size={16} color={i === 0 ? colors.hover : colors.textMuted} />
              </Pressable>
              <Pressable onPress={() => reorderQueue(i, i + 1)} disabled={i === queue.length - 1} hitSlop={8}>
                <ChevronDown size={16} color={i === queue.length - 1 ? colors.hover : colors.textMuted} />
              </Pressable>
              <Pressable
                onPress={() => removeFromQueueAt(i)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Retirer de la file"
              >
                <X size={16} color={colors.textMuted} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={styles.content}
          contentContainerStyle={styles.contentInner}
          showsVerticalScrollIndicator={false}
          onLayout={(e) => setViewportHeight(e.nativeEvent.layout.height)}
        >
          <View style={styles.headerRow}>
            <CoverImage
              uri={
                song.coverArt || song.albumId
                  ? client.coverArtUrl(song.coverArt || song.albumId || song.id, 600)
                  : override || null
              }
              style={styles.coverSmall}
              iconSize={26}
              recyclingKey={song.id}
            />
            <View style={styles.headerInfo}>
              <Text style={styles.title} numberOfLines={2}>
                {song.title}
              </Text>
              <Text style={styles.artist} numberOfLines={1}>
                {song.artist}
              </Text>
            </View>
            <OfflineButton song={song} client={client} />
          </View>

          <PlayerProgress />

          <View style={styles.controls}>
            <Pressable onPress={handleToggleShuffle} hitSlop={10}>
              <Shuffle size={20} color={shuffle ? colors.accent : colors.textSecondary} />
            </Pressable>
            <Pressable onPress={handlePrev} hitSlop={10}>
              <SkipBack size={28} color={colors.text} fill={colors.text} />
            </Pressable>
            <Pressable style={styles.playButton} onPress={handleTogglePlay}>
              {isPlaying ? <Pause size={28} color="#000" fill="#000" /> : <Play size={28} color="#000" fill="#000" />}
            </Pressable>
            <Pressable onPress={handleNext} hitSlop={10}>
              <SkipForward size={28} color={colors.text} fill={colors.text} />
            </Pressable>
            <Pressable onPress={cycleRepeat} hitSlop={10}>
              {repeatMode === 'one' ? (
                <Repeat1 size={20} color={colors.accent} />
              ) : (
                <Repeat size={20} color={repeatMode === 'all' ? colors.accent : colors.textSecondary} />
              )}
            </Pressable>
          </View>

          {!isRemote && (
            <Pressable onPress={cycleSpeed} style={styles.speedButton} hitSlop={10}>
              <Text style={[styles.speedButtonText, playbackRate !== 1 && styles.speedButtonTextActive]}>
                {playbackRate}x
              </Text>
            </Pressable>
          )}

          {/* Live lyrics live on this same screen now, not behind a separate tab -
              they follow the playhead directly below the transport controls, and
              the whole screen scrolls so a long lyric sheet has room to breathe
              instead of being squeezed into whatever space was left over. */}
          <View style={styles.lyricsSection} onLayout={(e) => setLyricsOffset(e.nativeEvent.layout.y)}>
            <LyricsView
              lines={lyrics?.synced ?? null}
              plain={lyrics?.plain ?? null}
              loading={loadingLyrics}
              searching={searching}
              onSeek={(seconds) => {
                seekTo(seconds)
                setProgress(seconds, useNavidromeStore.getState().duration)
              }}
              onAutoSearch={handleAutoSearch}
              scrollRef={scrollRef}
              sectionOffset={lyricsOffset}
              viewportHeight={viewportHeight}
            />
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.base, paddingTop: spacing.sm },
  center: { flex: 1, backgroundColor: colors.base, alignItems: 'center', justifyContent: 'center' },
  closeIcon: { position: 'absolute', top: spacing.lg, left: spacing.lg },
  emptyText: { color: colors.textSecondary },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg
  },
  offlineBadge: { backgroundColor: colors.hover, borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  offlineBadgeText: { color: colors.accent, fontSize: 11, fontWeight: '600' },
  castBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: 120,
    backgroundColor: colors.hover,
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2
  },
  castBadgeText: { color: colors.accent, fontSize: 11, fontWeight: '600' },
  content: { flex: 1 },
  contentInner: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl, flexGrow: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg },
  coverSmall: {
    width: 64,
    height: 64,
    borderRadius: radius.md,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 }
  },
  headerInfo: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  artist: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  slider: { width: '100%', height: 32 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -spacing.xs },
  time: { color: colors.textMuted, fontSize: 11 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.lg },
  speedButton: { alignSelf: 'center', marginTop: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.full, backgroundColor: colors.raised },
  speedButtonText: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  speedButtonTextActive: { color: colors.accent },
  lyricsSection: {
    flex: 1,
    marginTop: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.hover
  },
  playButton: {
    width: 64,
    height: 64,
    borderRadius: radius.full,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center'
  },
  queueHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  queueTitle: { color: colors.textMuted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  clearLink: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  confirmText: { color: colors.textSecondary, fontSize: 12 },
  confirmYes: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  confirmCancel: { color: colors.textMuted, fontSize: 12 },
  queueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm
  },
  queueRowMain: { flex: 1, minWidth: 0 },
  queueRowActive: { backgroundColor: colors.hover },
  queueRowText: { color: colors.text, fontSize: 14 },
  queueRowTextActive: { color: colors.accent },
  queueRowArtist: { color: colors.textMuted }
})
