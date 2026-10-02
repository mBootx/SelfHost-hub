import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { Image } from 'expo-image'
import { useEventListener } from 'expo'
import { useVideoPlayer, VideoView } from 'expo-video'
import type { LucideIcon } from 'lucide-react-native'
import { Download, Play, Share2, X } from 'lucide-react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { FileBrowserClient } from '@/services/filebrowser'
import { saveToGallery, shareMedia } from '@/services/photoActions'
import { doubleTapTo, fitSize, pinchTo, panTo, ZOOMED_THRESHOLD } from '@/services/zoomMath'
import { colors, spacing } from '@/constants/theme'

/** What the viewer needs to know about a file: photos and the bin's files both fit. */
export interface ViewerMedia {
  path: string
  name: string
  kind: 'photo' | 'video'
  size: number
  modified: number
  hasPreview?: boolean
}

/** A button of the bottom bar, next to the viewer's own share and save buttons. */
export interface ViewerAction<T> {
  key: string
  label: string
  icon: LucideIcon
  destructive?: boolean
  onPress: (item: T) => void
}

interface Props<T extends ViewerMedia> {
  photos: T[]
  client: FileBrowserClient
  startIndex: number
  onClose: () => void
  /** The screen does what these ask (it confirms, moves, deletes); the viewer follows the list as it shrinks. */
  actions: ViewerAction<T>[]
  /** The line under the picture: where and when it comes from. */
  describe: (item: T) => string
}

const FLASH_MS = 2500
const SETTLE_MS = 160

interface ZoomProps {
  source: { uri: string; headers: Record<string, string>; cacheKey: string }
  width: number
  height: number
  active: boolean
  /** The paging list must not scroll while the picture is zoomed or being pinched. */
  onZoomChange: (zoomed: boolean) => void
  onTap: () => void
}

/**
 * A picture that zooms with two fingers or a double tap and can then be dragged around. The gestures run on
 * the UI thread; the arithmetic is in zoomMath. The detector sits on a box that does not move, so the
 * positions it reports don't shift as the picture inside it is scaled.
 */
function ZoomableImage({ source, width, height, active, onZoomChange, onTap }: ZoomProps) {
  const [failed, setFailed] = useState(false)
  const [panning, setPanning] = useState(false)
  const scale = useSharedValue(1)
  const x = useSharedValue(0)
  const y = useSharedValue(0)
  const startScale = useSharedValue(1)
  const startX = useSharedValue(0)
  const startY = useSharedValue(0)
  const focusX = useSharedValue(0)
  const focusY = useSharedValue(0)
  const naturalWidth = useSharedValue(0)
  const naturalHeight = useSharedValue(0)
  const boxWidth = useSharedValue(width)
  const boxHeight = useSharedValue(height)

  useEffect(() => {
    boxWidth.value = width
    boxHeight.value = height
  }, [width, height, boxWidth, boxHeight])

  // A page the pager has moved away from starts over.
  useEffect(() => {
    if (active) return
    scale.value = 1
    x.value = 0
    y.value = 0
    setPanning(false)
  }, [active, scale, x, y])

  const zoomChanged = useCallback(
    (zoomed: boolean) => {
      setPanning(zoomed)
      onZoomChange(zoomed)
    },
    [onZoomChange]
  )
  const lockPaging = useCallback(() => onZoomChange(true), [onZoomChange])

  const gesture = useMemo(() => {
    const shown = () => {
      'worklet'
      return fitSize(naturalWidth.value > 0 ? { width: naturalWidth.value, height: naturalHeight.value } : null, { width: boxWidth.value, height: boxHeight.value })
    }
    const box = () => {
      'worklet'
      return { width: boxWidth.value, height: boxHeight.value }
    }
    /** After a pinch: not zoomed any more means back to fit, and the pager may scroll again. */
    const settle = () => {
      'worklet'
      const zoomed = scale.value > ZOOMED_THRESHOLD
      if (!zoomed) {
        scale.value = withTiming(1, { duration: SETTLE_MS })
        x.value = withTiming(0, { duration: SETTLE_MS })
        y.value = withTiming(0, { duration: SETTLE_MS })
      }
      runOnJS(zoomChanged)(zoomed)
    }

    const pinch = Gesture.Pinch()
      .onStart((e) => {
        'worklet'
        startScale.value = scale.value
        startX.value = x.value
        startY.value = y.value
        focusX.value = e.focalX - boxWidth.value / 2
        focusY.value = e.focalY - boxHeight.value / 2
        runOnJS(lockPaging)()
      })
      .onUpdate((e) => {
        'worklet'
        const view = pinchTo(
          { scale: startScale.value, x: startX.value, y: startY.value },
          e.scale,
          { x: focusX.value, y: focusY.value },
          { x: e.focalX - boxWidth.value / 2, y: e.focalY - boxHeight.value / 2 },
          shown(),
          box()
        )
        scale.value = view.scale
        x.value = view.x
        y.value = view.y
      })
      .onEnd(() => {
        'worklet'
        settle()
      })

    // One finger drags a zoomed picture; with two, the pinch above moves it.
    const pan = Gesture.Pan()
      .maxPointers(1)
      .enabled(panning)
      .onStart(() => {
        'worklet'
        startX.value = x.value
        startY.value = y.value
      })
      .onUpdate((e) => {
        'worklet'
        const view = panTo({ scale: scale.value, x: startX.value, y: startY.value }, e.translationX, e.translationY, shown(), box())
        x.value = view.x
        y.value = view.y
      })

    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .maxDuration(250)
      .onEnd((e, success) => {
        'worklet'
        if (!success) return
        const view = doubleTapTo(
          { scale: scale.value, x: x.value, y: y.value },
          e.x - boxWidth.value / 2,
          e.y - boxHeight.value / 2,
          shown(),
          box()
        )
        scale.value = withTiming(view.scale, { duration: 220 })
        x.value = withTiming(view.x, { duration: 220 })
        y.value = withTiming(view.y, { duration: 220 })
        runOnJS(zoomChanged)(view.scale > ZOOMED_THRESHOLD)
      })

    const singleTap = Gesture.Tap()
      .numberOfTaps(1)
      .maxDuration(250)
      .onEnd((_e, success) => {
        'worklet'
        if (success) runOnJS(onTap)()
      })

    // A tap waits to see whether it is the first of two; a drag or a pinch cancels both taps.
    return Gesture.Race(Gesture.Simultaneous(pinch, pan), Gesture.Exclusive(doubleTap, singleTap))
  }, [panning, zoomChanged, lockPaging, onTap, scale, x, y, startScale, startX, startY, focusX, focusY, naturalWidth, naturalHeight, boxWidth, boxHeight])

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }]
  }))

  return (
    <GestureDetector gesture={gesture}>
      <View style={{ width, height, overflow: 'hidden' }} collapsable={false}>
        <ActivityIndicator style={StyleSheet.absoluteFill} color={colors.accent} />
        {failed ? (
          <View style={styles.failed}>
            <Text style={styles.failedText}>Impossible d&apos;afficher cette photo</Text>
          </View>
        ) : (
          <Animated.View style={[StyleSheet.absoluteFill, style]}>
            <Image
              // The original, at full size. Keyed on the file, not the URL: the URL embeds nothing, but the key must outlive a session.
              source={source}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              cachePolicy="memory-disk"
              transition={120}
              onLoad={(e) => {
                naturalWidth.value = e.source.width
                naturalHeight.value = e.source.height
              }}
              onError={() => setFailed(true)}
            />
          </Animated.View>
        )}
      </View>
    </GestureDetector>
  )
}

/** The player of the video on show. Only mounted once play was asked for: swiping past a video costs no data. */
function VideoSurface({ item, client }: { item: ViewerMedia; client: FileBrowserClient }) {
  const [problem, setProblem] = useState<string | null>(null)
  const source = useMemo(() => ({ uri: client.rawUrl(item.path), headers: client.getAuthHeaders() }), [client, item.path])
  const player = useVideoPlayer(source, (created) => {
    created.loop = false
    created.play()
  })
  useEventListener(player, 'statusChange', ({ status, error }) => {
    if (status === 'error') setProblem(error?.message || 'Lecture impossible')
  })
  return (
    <>
      <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls />
      {problem ? (
        <View style={styles.failed} pointerEvents="none">
          <Text style={styles.failedText}>{problem}</Text>
        </View>
      ) : null}
    </>
  )
}

function VideoPage({ item, client, width, height, active, onTap }: { item: ViewerMedia; client: FileBrowserClient; width: number; height: number; active: boolean; onTap: () => void }) {
  const [started, setStarted] = useState(false)
  const [posterFailed, setPosterFailed] = useState(false)
  useEffect(() => {
    if (!active) setStarted(false)
  }, [active])
  const poster = useMemo(() => client.previewUrls(item.path, 'large')[0], [client, item.path])
  return (
    <View style={{ width, height, backgroundColor: '#000000' }}>
      {started ? (
        <VideoSurface item={item} client={client} />
      ) : (
        <Pressable style={StyleSheet.absoluteFill} onPress={onTap} accessibilityLabel={`Vidéo ${item.name}`}>
          {item.hasPreview !== false && !posterFailed ? (
            <Image
              source={client.imageSource(poster, `fb:${client.getSourceName()}:poster:${item.path}:${item.modified}`)}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              cachePolicy="memory-disk"
              onError={() => setPosterFailed(true)}
            />
          ) : null}
          <View style={styles.playWrap} pointerEvents="box-none">
            <Pressable style={styles.play} onPress={() => setStarted(true)} hitSlop={20} accessibilityRole="button" accessibilityLabel="Lire la vidéo">
              <Play size={34} color="#ffffff" fill="#ffffff" />
            </Pressable>
          </View>
        </Pressable>
      )}
    </View>
  )
}

export default function PhotoViewer<T extends ViewerMedia>({ photos, client, startIndex, onClose, actions, describe }: Props<T>) {
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const list = useRef<FlatList<T>>(null)
  const [index, setIndex] = useState(Math.min(startIndex, Math.max(0, photos.length - 1)))
  const [chrome, setChrome] = useState(true)
  const [zoomed, setZoomed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const mounted = useRef(false)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current)
    },
    []
  )

  // The list shrinks when the photo on show is deleted: stay on the one that took its place, or the last.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    if (photos.length === 0) {
      onClose()
      return
    }
    const clamped = Math.min(index, photos.length - 1)
    setIndex(clamped)
    list.current?.scrollToIndex({ index: clamped, animated: false })
  }, [photos.length])

  const toggleChrome = useCallback(() => setChrome((on) => !on), [])

  /** The message shown over the picture for a moment: the screen's own toasts sit under this window. */
  function flash(message: string): void {
    setNote(message)
    if (noteTimer.current) clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNote(null), FLASH_MS)
  }

  const photo = photos[index]
  if (!photo) return null

  async function share(): Promise<void> {
    if (busy) return
    setBusy('Préparation du partage…')
    try {
      if (!(await shareMedia(client, photo))) flash("Le partage n'est pas disponible sur ce téléphone")
    } catch (err) {
      Alert.alert('Partage impossible', err instanceof Error && err.message ? err.message : 'Le fichier n’a pas pu être téléchargé.')
    } finally {
      setBusy(null)
    }
  }

  async function save(): Promise<void> {
    if (busy) return
    setBusy('Enregistrement…')
    try {
      const report = await saveToGallery(client, [photo])
      flash(report.saved > 0 ? 'Enregistré dans la galerie du téléphone' : `Enregistrement impossible${report.message ? ` : ${report.message}` : ''}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.backdrop}>
        <FlatList
          ref={list}
          data={photos}
          extraData={index}
          keyExtractor={(p) => p.path}
          horizontal
          pagingEnabled
          scrollEnabled={!zoomed}
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={index}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          initialNumToRender={1}
          maxToRenderPerBatch={1}
          windowSize={3}
          onMomentumScrollEnd={(e) => {
            setIndex(Math.round(e.nativeEvent.contentOffset.x / width))
            setZoomed(false)
          }}
          renderItem={({ item, index: position }) =>
            item.kind === 'video' ? (
              <VideoPage item={item} client={client} width={width} height={height} active={position === index} onTap={toggleChrome} />
            ) : (
              <ZoomableImage
                // The original, at full size. Keyed on the file, not the URL: the key must outlive a session.
                source={client.imageSource(client.rawUrl(item.path), `fb:${client.getSourceName()}:${item.path}:${item.modified}`)}
                width={width}
                height={height}
                active={position === index}
                onZoomChange={setZoomed}
                onTap={toggleChrome}
              />
            )
          }
        />

        {chrome && (
          <>
            <View style={[styles.bar, styles.top, { paddingTop: insets.top + spacing.sm }]} pointerEvents="box-none">
              <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Fermer">
                <X size={24} color="#ffffff" />
              </Pressable>
              <Text style={styles.title} numberOfLines={1}>
                {photo.name}
              </Text>
              <Text style={styles.counter}>
                {index + 1} / {photos.length}
              </Text>
            </View>
            <View style={[styles.bar, styles.bottom, { paddingBottom: insets.bottom + spacing.md }]} pointerEvents="box-none">
              <Text style={styles.info} numberOfLines={2}>
                {describe(photo)}
              </Text>
              <Pressable onPress={() => void share()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Partager">
                <Share2 size={22} color="#ffffff" />
              </Pressable>
              <Pressable onPress={() => void save()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Enregistrer sur le téléphone">
                <Download size={22} color="#ffffff" />
              </Pressable>
              {actions.map((action) => (
                <Pressable key={action.key} onPress={() => action.onPress(photo)} hitSlop={12} accessibilityRole="button" accessibilityLabel={action.label}>
                  <action.icon size={22} color={action.destructive ? colors.danger : '#ffffff'} />
                </Pressable>
              ))}
            </View>
          </>
        )}

        {busy ? (
          <View style={styles.busy} pointerEvents="auto">
            <ActivityIndicator color="#ffffff" />
            <Text style={styles.busyText}>{busy}</Text>
          </View>
        ) : null}
        {note && !busy ? (
          <View style={[styles.note, { bottom: insets.bottom + 72 }]} pointerEvents="none">
            <Text style={styles.noteText}>{note}</Text>
          </View>
        ) : null}
      </GestureHandlerRootView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000' },
  bar: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingHorizontal: spacing.lg, backgroundColor: 'rgba(0,0,0,0.55)' },
  top: { top: 0, paddingBottom: spacing.md },
  bottom: { bottom: 0, paddingTop: spacing.md },
  title: { flex: 1, color: '#ffffff', fontSize: 14, fontWeight: '600' },
  counter: { color: 'rgba(255,255,255,0.75)', fontSize: 13 },
  info: { flex: 1, color: 'rgba(255,255,255,0.85)', fontSize: 13, lineHeight: 17 },
  failed: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  failedText: { color: colors.textSecondary, fontSize: 13, paddingHorizontal: spacing.xl, textAlign: 'center' },
  playWrap: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  play: { width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', paddingLeft: 4 },
  busy: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: spacing.md, backgroundColor: 'rgba(0,0,0,0.5)' },
  busyText: { color: '#ffffff', fontSize: 14 },
  note: { position: 'absolute', alignSelf: 'center', maxWidth: '85%', borderRadius: 18, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, backgroundColor: 'rgba(40,40,40,0.95)' },
  noteText: { color: '#ffffff', fontSize: 13, textAlign: 'center' }
})
