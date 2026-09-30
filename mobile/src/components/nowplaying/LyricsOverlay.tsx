import { useEffect, useRef } from 'react'
import { Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { Minimize2, Pause, Play, SkipBack, SkipForward } from 'lucide-react-native'
import EdgeFade from './EdgeFade'
import LyricLines from './LyricLines'
import SeekBar from './SeekBar'
import type { LyricLine } from '@/services/lyrics'
import type { Look } from '@/services/coverColor'
import { radius, spacing } from '@/constants/theme'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Height of the play bar floating over the bottom of the page, without the bottom inset. */
const BAR_HEIGHT = 158

interface Props {
  /** False starts the exit animation; onClosed then fires and the screen unmounts this. */
  open: boolean
  /** The song on show: a new one resets the lyrics list to the top. */
  songId: string
  look: Look
  title: string
  artist: string
  lines: LyricLine[] | null
  plain: string | null
  /** The area to fill, and where the card it grows out of is inside it. */
  bounds: { width: number; height: number }
  origin: Box | null
  insets: { top: number; bottom: number }
  isPlaying: boolean
  onTogglePlay: () => void
  onPrev: () => void
  onNext: () => void
  onSeek: (seconds: number) => void
  onClose: () => void
  onClosed: () => void
}

/**
 * The full lyrics page. It grows out of the card on the player, then follows the song: the sung line is
 * white, the others dim, tapping one seeks to it, and the play bar stays at the bottom.
 */
export default function LyricsOverlay(props: Props) {
  const { open, look, title, artist, lines, plain, bounds, origin, insets, isPlaying } = props
  const progress = useRef(new Animated.Value(0)).current
  const closed = useRef(props.onClosed)
  closed.current = props.onClosed

  useEffect(() => {
    Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: open ? 300 : 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false
    }).start(({ finished }) => {
      if (finished && !open) closed.current()
    })
  }, [open, progress])

  const from: Box = origin ?? { x: 0, y: bounds.height, width: bounds.width, height: 0 }
  const lerp = (a: number, b: number) => progress.interpolate({ inputRange: [0, 1], outputRange: [a, b] })
  const barHeight = BAR_HEIGHT + insets.bottom

  return (
    <Animated.View
      style={[
        styles.box,
        {
          left: lerp(from.x, 0),
          top: lerp(from.y, 0),
          width: lerp(from.width, bounds.width),
          height: lerp(from.height, bounds.height),
          borderRadius: lerp(radius.lg, 0),
          backgroundColor: look.card
        }
      ]}
    >
      <Animated.View
        style={{ width: bounds.width, height: bounds.height, opacity: progress.interpolate({ inputRange: [0, 0.55, 1], outputRange: [0, 0, 1] }) }}
      >
        <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
          <View style={styles.headerText}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            <Text style={styles.artist} numberOfLines={1}>
              {artist}
            </Text>
          </View>
          <Pressable style={styles.close} onPress={props.onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Réduire les paroles">
            <Minimize2 size={20} color="#ffffff" />
          </Pressable>
        </View>

        <View style={styles.body}>
          {lines ? (
            <LyricLines key={props.songId} lines={lines} variant="full" onSeek={props.onSeek} bottomInset={barHeight} />
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: 8, paddingBottom: barHeight + spacing.xl }}>
              <Text style={styles.plain}>{plain}</Text>
            </ScrollView>
          )}
          {/* Lines slide out under the header instead of running into it. */}
          <EdgeFade color={look.card} edge="top" size={30} id="lyrics-top-fade" />
        </View>

        <View style={[styles.bar, { paddingBottom: insets.bottom + spacing.md }]} pointerEvents="box-none">
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <Svg width="100%" height="100%" preserveAspectRatio="none">
              <Defs>
                <LinearGradient id="lyrics-bar-fade" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={look.card} stopOpacity={0} />
                  <Stop offset="0.3" stopColor={look.card} stopOpacity={1} />
                  <Stop offset="1" stopColor={look.card} stopOpacity={1} />
                </LinearGradient>
              </Defs>
              <Rect x="0" y="0" width="100%" height="100%" fill="url(#lyrics-bar-fade)" />
            </Svg>
          </View>
          <SeekBar />
          <View style={styles.controls}>
            <Pressable onPress={props.onPrev} hitSlop={12} accessibilityRole="button" accessibilityLabel="Titre précédent">
              <SkipBack size={28} color="#ffffff" fill="#ffffff" />
            </Pressable>
            <Pressable style={styles.play} onPress={props.onTogglePlay} accessibilityRole="button" accessibilityLabel={isPlaying ? 'Pause' : 'Lecture'}>
              {isPlaying ? <Pause size={26} color="#000000" fill="#000000" /> : <Play size={26} color="#000000" fill="#000000" />}
            </Pressable>
            <Pressable onPress={props.onNext} hitSlop={12} accessibilityRole="button" accessibilityLabel="Titre suivant">
              <SkipForward size={28} color="#ffffff" fill="#ffffff" />
            </Pressable>
          </View>
        </View>
      </Animated.View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  box: { position: 'absolute', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.xl, paddingBottom: spacing.md },
  headerText: { flex: 1, minWidth: 0 },
  title: { color: '#ffffff', fontSize: 18, fontWeight: '800' },
  artist: { color: 'rgba(255,255,255,0.7)', fontSize: 14, marginTop: 2 },
  close: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(0,0,0,0.25)', alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, paddingHorizontal: spacing.xl },
  plain: { color: 'rgba(255,255,255,0.92)', fontSize: 22, lineHeight: 33, fontWeight: '800' },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 44, paddingHorizontal: spacing.xl },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 44, marginTop: spacing.sm },
  play: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center' }
})
