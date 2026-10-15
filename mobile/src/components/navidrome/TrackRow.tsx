import { useRef } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import ReanimatedSwipeable, { SwipeableMethods, SwipeDirection } from 'react-native-gesture-handler/ReanimatedSwipeable'
import Animated, { Extrapolation, SharedValue, interpolate, useAnimatedStyle } from 'react-native-reanimated'
import { Check, ListStart, Play, X } from 'lucide-react-native'
import { NavidromeClient, NDSong } from '@/services/navidrome'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useTrackSheetStore } from '@/store/trackSheetStore'
import { useSelectionStore } from '@/store/selectionStore'
import { useToastStore } from '@/store/toastStore'
import CoverImage from '@/components/CoverImage'
import EqualizerBars from './EqualizerBars'
import OfflineButton from './OfflineButton'
import { colors, radius, spacing, tint } from '@/constants/theme'

interface Props {
  song: NDSong
  client: NavidromeClient
  isCurrent: boolean
  isPlaying: boolean
  onPress: () => void
  showArtist?: boolean
  /** Only passed by a playlist's own track list - renders a trailing remove button (there is no swipe for it). */
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

export default function TrackRow({ song, client, isCurrent, isPlaying, onPress, showArtist, onRemove }: Props) {
  const openSheet = useTrackSheetStore((s) => s.open)
  // While songs are being picked a tap picks (or unpicks) instead of playing, and the swipe is off.
  const selecting = useSelectionStore((s) => s.active)
  const picked = useSelectionStore((s) => !!s.ids[song.id])
  const toggleSelected = useSelectionStore((s) => s.toggle)
  const playNext = useNavidromeStore((s) => s.playNext)
  const showToast = useToastStore((s) => s.show)
  const swipeRef = useRef<SwipeableMethods>(null)
  const coverId = song.coverArt || song.albumId

  // Slots the song straight after the current track - whatever was next plays
  // after it - without replacing the queue or leaving the screen you're on.
  function queueNext(): void {
    const ahead = playNext(song)
    showToast(ahead === 0 ? `« ${song.title} » sera lu ensuite` : `« ${song.title} » sera lu après ${ahead === 1 ? 'le titre déjà ajouté' : `les ${ahead} titres déjà ajoutés`}`)
  }

  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      friction={1.5}
      enabled={!selecting}
      leftThreshold={SWIPE_THRESHOLD}
      overshootLeft={false}
      overshootRight={false}
      containerStyle={styles.swipeContainer}
      // Only one swipe: to the right, "play next". Removing from a playlist is the cross at the end of the row, so a
      // song is never taken out by a swipe meant to scroll or to queue it.
      renderLeftActions={(_progress, translation) => <PlayNextAction translation={translation} />}
      onSwipeableWillOpen={(direction) => {
        if (direction === SwipeDirection.RIGHT) queueNext()
      }}
      onSwipeableOpen={() => swipeRef.current?.close()}
    >
      <Pressable
        style={({ pressed }) => [styles.row, isCurrent && styles.rowActive, picked && styles.rowPicked, pressed && styles.pressed]}
        onPress={selecting ? () => toggleSelected(song) : onPress}
        onLongPress={() => (selecting ? toggleSelected(song) : openSheet(song))}
        delayLongPress={300}
        accessibilityRole={selecting ? 'checkbox' : 'button'}
        accessibilityState={selecting ? { checked: picked } : undefined}
        accessibilityLabel={`${song.title}, ${song.artist}`}
        accessibilityHint="Glisser vers la droite pour lire ensuite, appui long pour les options"
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
        {selecting && (
          <View style={[styles.check, picked && styles.checkOn]}>{picked && <Check size={14} color={colors.onAccent} strokeWidth={3.5} />}</View>
        )}
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
        {!selecting && <OfflineButton song={song} client={client} />}
        {onRemove && !selecting && (
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
  rowPicked: { backgroundColor: tint(colors.accent, 0.12) },
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.textMuted, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
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
