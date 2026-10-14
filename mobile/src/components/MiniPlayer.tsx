import { useMemo } from 'react'
import { useRouter } from 'expo-router'
import { Pressable, View, Text, StyleSheet } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { Play, Pause, SkipForward, Cast } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useArtworkStore } from '@/store/artworkStore'
import { useRemoteStore, LOCAL_DEVICE_ID } from '@/store/remoteStore'
import CoverImage from '@/components/CoverImage'
import { colors, radius, spacing } from '@/constants/theme'
import { swipeSkip } from '@/services/dragMath'

/**
 * Split out so the playhead - which ticks four times a second - only re-renders
 * these two <View>s. Subscribing to it from MiniPlayer itself redrew the artwork,
 * titles and buttons at the same rate, on every tab, for the whole track.
 */
function MiniPlayerProgress() {
  const selectedDeviceId = useRemoteStore((s) => s.selectedDeviceId)
  const isRemote = selectedDeviceId !== LOCAL_DEVICE_ID
  const localCurrentTime = useNavidromeStore((s) => s.currentTime)
  const localDuration = useNavidromeStore((s) => s.duration)
  const remote = useRemoteStore((s) => (isRemote ? s.devices[selectedDeviceId] : undefined))
  const currentTime = isRemote ? remote?.currentTime ?? 0 : localCurrentTime
  const duration = isRemote ? remote?.duration ?? 0 : localDuration
  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0

  return (
    <View style={styles.progressTrack} pointerEvents="none">
      <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
    </View>
  )
}

export default function MiniPlayer() {
  const router = useRouter()
  const client = useNavidromeStore((s) => s.client)
  const queue = useNavidromeStore((s) => s.queue)
  const queueIndex = useNavidromeStore((s) => s.queueIndex)

  const selectedDeviceId = useRemoteStore((s) => s.selectedDeviceId)
  const sendCommand = useRemoteStore((s) => s.sendCommand)
  const remoteDevice = useRemoteStore((s) =>
    s.selectedDeviceId !== LOCAL_DEVICE_ID ? s.devices[s.selectedDeviceId] : undefined
  )
  const isRemote = selectedDeviceId !== LOCAL_DEVICE_ID

  const localIsPlaying = useNavidromeStore((s) => s.isPlaying)
  const togglePlay = useNavidromeStore((s) => s.togglePlay)
  const next = useNavidromeStore((s) => s.next)
  const prev = useNavidromeStore((s) => s.prev)

  const localSong = queue[queueIndex] || null
  // Local playback, unless a remote device is the active output - see
  // remoteStore.selectDevice, which pauses local audio the moment that happens.
  const song = isRemote ? remoteDevice?.song ?? null : localSong
  const isPlaying = isRemote ? !!remoteDevice?.isPlaying : localIsPlaying

  const override = useArtworkStore((s) => {
    const key = song?.albumId || song?.id
    return key ? s.overrides[key] : undefined
  })

  // Swiped left: the next song; right: the one before. The card follows the finger, then springs back.
  const offset = useSharedValue(0)
  const skip = (direction: 'next' | 'prev'): void => {
    if (direction === 'next') {
      if (isRemote) sendCommand('next')
      else next()
    } else if (isRemote) {
      sendCommand('prev')
    } else {
      prev()
    }
  }
  const swipe = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-14, 14])
        .failOffsetY([-12, 12])
        .onUpdate((e) => {
          offset.value = e.translationX * 0.6
        })
        .onEnd((e) => {
          const direction = swipeSkip(e.translationX, e.velocityX)
          if (direction) {
            offset.value = withTiming(direction === 'next' ? -40 : 40, { duration: 90 }, () => {
              offset.value = withSpring(0, { damping: 18, stiffness: 220 })
            })
            runOnJS(skip)(direction)
          } else {
            offset.value = withSpring(0, { damping: 18, stiffness: 220 })
          }
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isRemote, next, prev, sendCommand]
  )
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }))

  if (!song || !client) return null

  const coverId = song.coverArt || song.albumId

  function handleTogglePlay(): void {
    if (isRemote) sendCommand('toggle')
    else togglePlay()
  }
  function handleNext(): void {
    if (isRemote) sendCommand('next')
    else next()
  }

  return (
    <GestureDetector gesture={swipe}>
    <Animated.View style={slide}>
    <Pressable
      style={styles.card}
      onPress={() => router.push('/now-playing')}
      android_ripple={{ color: colors.hover }}
      accessibilityRole="button"
      accessibilityLabel={`Lecture en cours : ${song.title}, ${song.artist}`}
      accessibilityHint="Glisser vers la gauche pour le titre suivant, vers la droite pour le précédent"
      accessibilityActions={[
        { name: 'next', label: 'Titre suivant' },
        { name: 'previous', label: 'Titre précédent' }
      ]}
      onAccessibilityAction={(e) => skip(e.nativeEvent.actionName === 'next' ? 'next' : 'prev')}
    >
      <CoverImage
        uri={coverId ? client.coverArtUrl(coverId, 100) : override || null}
        style={styles.cover}
        iconSize={16}
        recyclingKey={song.id}
      />
      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={1}>
          {song.title}
        </Text>
        <View style={styles.artistRow}>
          {isRemote && <Cast size={11} color={colors.accent} />}
          <Text style={styles.artist} numberOfLines={1}>
            {song.artist}
          </Text>
        </View>
      </View>
      <Pressable
        style={styles.playButton}
        onPress={handleTogglePlay}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? 'Pause' : 'Lecture'}
      >
        {isPlaying ? <Pause size={18} color="#000" fill="#000" /> : <Play size={18} color="#000" fill="#000" />}
      </Pressable>
      <Pressable style={styles.skipButton} onPress={handleNext} hitSlop={8} accessibilityRole="button" accessibilityLabel="Titre suivant">
        <SkipForward size={20} color={colors.text} fill={colors.text} />
      </Pressable>

      <MiniPlayerProgress />
    </Pressable>
    </Animated.View>
    </GestureDetector>
  )
}

const styles = StyleSheet.create({
  /**
   * A floating card rather than a full-width bar glued to the tab bar: the inset
   * keeps the two strips of chrome visually separate instead of one thick slab.
   */
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.sm,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 }
  },
  cover: { width: 40, height: 40, borderRadius: radius.sm },
  info: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 13, fontWeight: '600' },
  artistRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
  artist: { color: colors.textSecondary, fontSize: 11 },
  playButton: {
    width: 34,
    height: 34,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center'
  },
  skipButton: { paddingHorizontal: spacing.xs },
  progressTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, backgroundColor: colors.hover },
  progressFill: { height: 2, backgroundColor: colors.accent }
})
