import { useRef } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import ReanimatedSwipeable, { SwipeableMethods, SwipeDirection } from 'react-native-gesture-handler/ReanimatedSwipeable'
import Animated, { Extrapolation, SharedValue, interpolate, useAnimatedStyle } from 'react-native-reanimated'
import { ListStart, Play, Trash2, X } from 'lucide-react-native'
import { NavidromeClient, NDSong } from '@/services/navidrome'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useTrackSheetStore } from '@/store/trackSheetStore'
import { useToastStore } from '@/store/toastStore'
import CoverImage from '@/components/CoverImage'
import EqualizerBars from './EqualizerBars'
import OfflineButton from './OfflineButton'
import { colors, radius, spacing } from '@/constants/theme'

interface Props {
  song: NDSong
  client: NavidromeClient
  isCurrent: boolean
  isPlaying: boolean
  onPress: () => void
  showArtist?: boolean
  /** Only passed by a playlist's own track list - renders a trailing remove button. */
  onRemove?: () => void
}

const ACTION_WIDTH = 96
const SWIPE_THRESHOLD = 72

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Revealed behind the row while swiping right; the icon grows as the swipe nears the trigger point. */
function PlayNextAction({ translation }: { translation: SharedValue<number> }) {
  const iconStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translation.value, [0, 24, SWIPE_THRESHOLD], [0, 0.5, 1], Extrapolation.CLAMP),
    transform: [{ scale: interpolate(translation.value, [0, SWIPE_THRESHOLD], [0.6, 1], Extrapolation.CLAMP) }]
  }))

  return (
    <View style={styles.action}>
      <Animated.View style={[styles.actionContent, iconStyle]}>
        <ListStart size={20} color="#000" />
        <Text style={styles.actionText}>Lire ensuite</Text>
      </Animated.View>
    </View>
  )
}

/** Mirror of PlayNextAction for the left swipe; translation runs negative on this side. */
function RemoveAction({ translation }: { translation: SharedValue<number> }) {
  const iconStyle = useAnimatedStyle(() => ({
    opacity: interpolate(-translation.value, [0, 24, SWIPE_THRESHOLD], [0, 0.5, 1], Extrapolation.CLAMP),
    transform: [{ scale: interpolate(-translation.value, [0, SWIPE_THRESHOLD], [0.6, 1], Extrapolation.CLAMP) }]
  }))

  return (
    <View style={[styles.action, styles.actionDanger]}>
      <Animated.View style={[styles.actionContent, iconStyle]}>
        <Trash2 size={20} color="#000" />
        <Text style={styles.actionText}>Retirer</Text>
      </Animated.View>
    </View>
  )
}

export default function TrackRow({ song, client, isCurrent, isPlaying, onPress, showArtist, onRemove }: Props) {
  const openSheet = useTrackSheetStore((s) => s.open)
  const playNext = useNavidromeStore((s) => s.playNext)
  const showToast = useToastStore((s) => s.show)
  const swipeRef = useRef<SwipeableMethods>(null)
  const coverId = song.coverArt || song.albumId

  // Slots the song straight after the current track - whatever was next plays
  // after it - without replacing the queue or leaving the screen you're on.
  function queueNext(): void {
    playNext(song)
    showToast(`"${song.title}" sera lu ensuite`)
  }

  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      friction={1.5}
      leftThreshold={SWIPE_THRESHOLD}
      rightThreshold={SWIPE_THRESHOLD}
      overshootLeft={false}
      overshootRight={false}
      containerStyle={styles.swipeContainer}
      renderLeftActions={(_progress, translation) => <PlayNextAction translation={translation} />}
      renderRightActions={onRemove ? (_progress, translation) => <RemoveAction translation={translation} /> : undefined}
      onSwipeableWillOpen={(direction) => {
        if (direction === SwipeDirection.RIGHT) queueNext()
        else onRemove?.()
      }}
      onSwipeableOpen={() => swipeRef.current?.close()}
    >
      <Pressable
        style={({ pressed }) => [styles.row, isCurrent && styles.rowActive, pressed && styles.pressed]}
        onPress={onPress}
        onLongPress={() => openSheet(song)}
        delayLongPress={300}
        accessibilityRole="button"
        accessibilityLabel={`${song.title}, ${song.artist}`}
        accessibilityHint={
          onRemove
            ? 'Glisser vers la droite pour lire ensuite, vers la gauche pour retirer de la playlist'
            : 'Glisser vers la droite pour lire ensuite, appui long pour les options'
        }
        accessibilityActions={
          onRemove
            ? [
                { name: 'playNext', label: 'Lire ensuite' },
                { name: 'remove', label: 'Retirer de la playlist' }
              ]
            : [{ name: 'playNext', label: 'Lire ensuite' }]
        }
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'playNext') queueNext()
          else if (e.nativeEvent.actionName === 'remove') onRemove?.()
        }}
      >
        <View style={styles.thumbWrap}>
          <CoverImage
            uri={coverId ? client.coverArtUrl(coverId, 100) : null}
            style={styles.thumb}
            iconSize={16}
            recyclingKey={song.id}
          />
          {isCurrent && (
            <View style={styles.overlay}>{isPlaying ? <EqualizerBars /> : <Play size={14} color="#fff" fill="#fff" />}</View>
          )}
        </View>
        <View style={styles.info}>
          <Text style={[styles.title, isCurrent && styles.titleActive]} numberOfLines={1}>
            {song.title}
          </Text>
          {showArtist !== false && (
            <Text style={styles.artist} numberOfLines={1}>
              {song.artist}
            </Text>
          )}
        </View>
        <Text style={styles.duration}>{formatDuration(song.duration)}</Text>
        <OfflineButton song={song} client={client} />
        {onRemove && (
          <Pressable onPress={onRemove} hitSlop={10} accessibilityRole="button" accessibilityLabel="Retirer de la playlist">
            <X size={16} color={colors.textMuted} />
          </Pressable>
        )}
      </Pressable>
    </ReanimatedSwipeable>
  )
}

const styles = StyleSheet.create({
  swipeContainer: { borderRadius: radius.sm, overflow: 'hidden' },
  action: {
    width: ACTION_WIDTH,
    backgroundColor: colors.accent,
    justifyContent: 'center',
    alignItems: 'center'
  },
  actionDanger: { backgroundColor: colors.danger },
  actionContent: { alignItems: 'center', gap: 2 },
  actionText: { color: '#000', fontSize: 11, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: colors.base
  },
  rowActive: { backgroundColor: colors.raised },
  pressed: { opacity: 0.6 },
  thumbWrap: { width: 44, height: 44, borderRadius: radius.sm, overflow: 'hidden' },
  thumb: { width: '100%', height: '100%' },
  overlay: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  info: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 14, fontWeight: '500' },
  titleActive: { color: colors.accent },
  artist: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  duration: { color: colors.textMuted, fontSize: 12 }
})
