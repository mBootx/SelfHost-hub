import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Linking, Pressable, StyleSheet, Text, useWindowDimensions, Vibration, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Camera, CameraOff, Cast, Hand, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react-native'
import CoverImage from '@/components/CoverImage'
import CameraFeed from '@/components/carmode/CameraFeed'
import GestureIndicator, { GESTURE_INFO } from '@/components/carmode/GestureIndicator'
import HoldButton from '@/components/carmode/HoldButton'
import { useHandGestureDetection } from '@/hooks/useHandGestureDetection'
import { ACTION_FOR, CarAction, runCarAction } from '@/services/carActions'
import { GESTURES, GestureEvent, GestureName } from '@/services/gestureRecognizer'
import { useAppLockStore } from '@/store/appLockStore'
import { useArtworkStore } from '@/store/artworkStore'
import { sunnyAfter, useCarModeStore } from '@/store/carModeStore'
import { useNavidromeStore } from '@/store/navidromeStore'
import { LOCAL_DEVICE_ID, useRemoteStore } from '@/store/remoteStore'
import { colors } from '@/constants/theme'
import SelfHostNative from '../../../modules/selfhost-native'

/** A quick double buzz: felt through a phone in a mount without looking at it. */
const BUZZ = [0, 50, 100, 50]
/** The gesture stays named this long (it fades out meanwhile). */
const SHOWN_MS = 1000
const EXIT_RED = '#dc2626'

/** The gesture each fallback button stands for, so a button shows the same feedback as its gesture. */
const BUTTON_GESTURE: Partial<Record<CarAction, GestureName>> = { toggle: 'PINCH', next: 'WAVE_RIGHT', prev: 'WAVE_LEFT' }

function playingNow(): boolean {
  const remote = useRemoteStore.getState()
  if (remote.selectedDeviceId !== LOCAL_DEVICE_ID) return !!remote.devices[remote.selectedDeviceId]?.isPlaying
  return useNavidromeStore.getState().isPlaying
}

/** Whether the app is on screen. It starts true: this screen is only ever opened from the app in hand. */
function useAppActive(): boolean {
  const [active, setActive] = useState(true)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setActive(state === 'active'))
    return () => subscription.remove()
  }, [])
  return active
}

/**
 * The car mode: a black full screen that the driver can read at a glance, driven by hand gestures in front of the front
 * camera, with three big buttons (held a moment) when the hands are better on the wheel. Big white type on black for
 * the sun; when the light sensor reads sunshine the screen goes to full brightness. The screen stays on, turns the way
 * the settings say, and is put back as it was on the way out. The camera runs only while this screen is up, the app on
 * screen and unlocked.
 */
export default function CarModeOverlay({ onExit }: { onExit: () => void }) {
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  const landscape = width > height

  const permission = useCarModeStore((s) => s.permission)
  const testMode = useCarModeStore((s) => s.testMode)
  const orientation = useCarModeStore((s) => s.orientation)
  const sunBoost = useCarModeStore((s) => s.sunBoost)
  const enabledGestures = useCarModeStore((s) => s.gestures)
  const lastGesture = useCarModeStore((s) => s.lastDetectedGesture)
  const lastConfidence = useCarModeStore((s) => s.lastConfidence)
  const gestureCount = useCarModeStore((s) => s.gestureCount)
  const setCarModeEnabled = useCarModeStore((s) => s.setCarModeEnabled)
  const refreshPermission = useCarModeStore((s) => s.refreshPermission)
  const requestPermission = useCarModeStore((s) => s.requestPermission)

  const client = useNavidromeStore((s) => s.client)
  const localSong = useNavidromeStore((s) => s.queue[s.queueIndex] ?? null)
  const localPlaying = useNavidromeStore((s) => s.isPlaying)
  const selectedDeviceId = useRemoteStore((s) => s.selectedDeviceId)
  const remoteDevice = useRemoteStore((s) => (s.selectedDeviceId !== LOCAL_DEVICE_ID ? s.devices[s.selectedDeviceId] : undefined))
  const deviceList = useRemoteStore((s) => s.deviceList)
  const isRemote = selectedDeviceId !== LOCAL_DEVICE_ID
  const song = isRemote ? remoteDevice?.song ?? null : localSong
  const isPlaying = isRemote ? !!remoteDevice?.isPlaying : localPlaying
  const deviceName = deviceList.find((d) => d.deviceId === selectedDeviceId)?.deviceName || 'Appareil distant'
  const override = useArtworkStore((s) => {
    const key = song?.albumId || song?.id
    return key ? s.overrides[key] : undefined
  })
  const coverId = song?.coverArt || song?.albumId
  const coverUrl = song && client ? (coverId ? client.coverArtUrl(coverId, 300) : override || null) : null

  const appActive = useAppActive()
  const locked = useAppLockStore((s) => s.status === 'locked')
  const [sunny, setSunny] = useState(false)
  const [feedback, setFeedback] = useState<{ label: string | null; outcome: string | null; fromCamera: boolean }>({
    label: null,
    outcome: null,
    fromCamera: false
  })
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Open while mounted; the screen stays awake, turned the way the settings say, and is put back on the way out.
  useEffect(() => {
    setCarModeEnabled(true)
    refreshPermission()
    SelfHostNative?.setKeepScreenOn?.(true)
    return () => {
      setCarModeEnabled(false)
      useCarModeStore.getState().setLastGesture(null)
      if (clearTimer.current) clearTimeout(clearTimer.current)
      SelfHostNative?.restoreCarScreen?.()
    }
  }, [setCarModeEnabled, refreshPermission])

  useEffect(() => {
    SelfHostNative?.setScreenOrientation?.(orientation)
  }, [orientation])

  // Coming back from the phone's settings may have changed the answer.
  useEffect(() => {
    if (appActive) refreshPermission()
  }, [appActive, refreshPermission])

  // Full brightness in the sun, read from the light sensor.
  useEffect(() => {
    if (!sunBoost || !SelfHostNative?.startLightSensor || !SelfHostNative.addListener) return
    let bright = false
    const subscription = SelfHostNative.addListener('onAmbientLight', ({ lux }) => {
      const next = sunnyAfter(bright, lux)
      if (next === bright) return
      bright = next
      setSunny(next)
      SelfHostNative?.setScreenBrightness?.(next ? 1 : -1)
    })
    SelfHostNative.startLightSensor()
    return () => {
      subscription.remove()
      SelfHostNative?.stopLightSensor?.()
      if (bright) SelfHostNative?.setScreenBrightness?.(-1)
      setSunny(false)
    }
  }, [sunBoost])

  const perform = useCallback((action: CarAction, gesture: GestureName, confidence: number, fromCamera: boolean) => {
    const store = useCarModeStore.getState()
    setFeedback({ label: action === 'toggle' ? (playingNow() ? 'Pause' : 'Lecture') : null, outcome: null, fromCamera })
    store.setLastGesture(gesture, confidence)
    if (store.haptics) Vibration.vibrate(BUZZ)
    if (clearTimer.current) clearTimeout(clearTimer.current)
    clearTimer.current = setTimeout(() => useCarModeStore.getState().setLastGesture(null), SHOWN_MS)
    const count = useCarModeStore.getState().gestureCount
    runCarAction(action)
      .then((outcome) => {
        // A later gesture has its own feedback by now.
        if (outcome && useCarModeStore.getState().gestureCount === count) setFeedback((f) => ({ ...f, outcome }))
      })
      .catch(() => {})
  }, [])

  const onGesture = useCallback((event: GestureEvent) => perform(ACTION_FOR[event.gesture], event.gesture, event.confidence, true), [perform])
  const pressButton = (action: CarAction): void => perform(action, BUTTON_GESTURE[action] ?? 'PINCH', 1, false)

  const cameraAllowed = permission === 'granted'
  const detection = useHandGestureDetection(cameraAllowed && appActive && !locked, onGesture)

  const soft = sunny ? '#ffffff' : '#c8c8c8'
  const accent = colors.accent

  const banner =
    detection.status === 'unavailable' || permission === 'unavailable'
      ? { text: "Gestes indisponibles dans cette version de l'application : les boutons restent.", action: null }
      : permission === 'blocked'
        ? { text: 'Caméra refusée : gestes désactivés.', action: { label: 'Réglages', run: () => Linking.openSettings() } }
        : permission === 'denied' || permission === 'unknown'
          ? { text: 'Les gestes ont besoin de la caméra.', action: { label: 'Autoriser', run: () => requestPermission() } }
          : detection.status === 'error'
            ? { text: detection.error || 'Caméra indisponible', action: null }
            : null

  const cameraOn = detection.status === 'running'
  const hints = GESTURES.filter((g) => enabledGestures[g])

  const nowPlaying = (
    <View style={styles.nowPlaying}>
      <CoverImage uri={coverUrl} style={styles.cover} iconSize={28} recyclingKey={song?.id} />
      <View style={styles.songText}>
        <Text style={styles.title} numberOfLines={2}>
          {song?.title ?? 'Aucune lecture'}
        </Text>
        {!!song && (
          <Text style={[styles.artist, { color: soft }]} numberOfLines={1}>
            {song.artist}
          </Text>
        )}
        {isRemote && (
          <View style={styles.deviceRow}>
            <Cast size={14} color={accent} />
            <Text style={[styles.device, { color: accent }]} numberOfLines={1}>
              {deviceName}
            </Text>
          </View>
        )}
      </View>
    </View>
  )

  const gestureZone = (
    <View style={styles.zone}>
      {testMode && cameraAllowed && detection.status !== 'unavailable' ? (
        <CameraFeed detection={detection} accent={accent} />
      ) : (
        <View style={styles.hints}>
          {cameraOn &&
            hints.map((g) => {
              const Icon = GESTURE_INFO[g].icon
              return (
                <View key={g} style={styles.hint}>
                  <Icon size={26} color="#ffffff" />
                  <Text style={styles.hintHow} numberOfLines={1}>
                    {GESTURE_INFO[g].how}
                  </Text>
                  <Text style={[styles.hintAction, { color: soft }]} numberOfLines={1}>
                    {GESTURE_INFO[g].action}
                  </Text>
                </View>
              )
            })}
        </View>
      )}
      {cameraOn && (
        <View style={[styles.handPill, detection.isHand && { borderColor: accent }]}>
          <Hand size={16} color={detection.isHand ? accent : soft} />
          <Text style={[styles.handText, { color: detection.isHand ? accent : soft }]}>{detection.isHand ? 'Main vue' : 'Aucune main'}</Text>
        </View>
      )}
      {lastGesture && (
        <View style={styles.feedback} pointerEvents="none">
          <GestureIndicator
            gesture={lastGesture}
            count={gestureCount}
            label={feedback.label}
            outcome={feedback.outcome}
            confidence={lastConfidence}
            showConfidence={feedback.fromCamera}
            style={styles.feedbackBackdrop}
          />
        </View>
      )}
    </View>
  )

  const buttons = (
    <View style={styles.buttons}>
      <HoldButton icon={SkipBack} label="Précédent" onActivate={() => pressButton('prev')} accent={accent} />
      <HoldButton icon={isPlaying ? Pause : Play} label={isPlaying ? 'Pause' : 'Lecture'} onActivate={() => pressButton('toggle')} primary accent={accent} />
      <HoldButton icon={SkipForward} label="Suivant" onActivate={() => pressButton('next')} accent={accent} />
    </View>
  )

  return (
    <View style={[styles.root, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 12, paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}>
      <View style={styles.topBar}>
        <View
          style={styles.cameraChip}
          accessibilityLabel={cameraOn ? 'Caméra active' : 'Caméra coupée'}
          accessibilityRole="text"
        >
          {cameraOn ? <Camera size={18} color={accent} /> : <CameraOff size={18} color={soft} />}
          {cameraOn && <View style={[styles.liveDot, { backgroundColor: accent }]} />}
        </View>
        <Text style={[styles.heading, { color: soft }]}>Mode voiture</Text>
        <Pressable
          onPress={onExit}
          style={({ pressed }) => [styles.exit, pressed && { opacity: 0.7 }]}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Quitter le mode voiture"
        >
          <X size={34} color="#ffffff" strokeWidth={3} />
        </Pressable>
      </View>

      {banner && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{banner.text}</Text>
          {banner.action && (
            <Pressable onPress={banner.action.run} style={styles.bannerButton} accessibilityRole="button" accessibilityLabel={banner.action.label}>
              <Text style={styles.bannerButtonText}>{banner.action.label}</Text>
            </Pressable>
          )}
        </View>
      )}

      {landscape ? (
        <View style={styles.landscape}>
          {gestureZone}
          <View style={styles.side}>
            {nowPlaying}
            {buttons}
          </View>
        </View>
      ) : (
        <>
          {nowPlaying}
          {gestureZone}
          {buttons}
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000', gap: 14 },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cameraChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: 32, borderRadius: 16, backgroundColor: '#141414' },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  heading: { flex: 1, fontSize: 16, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  exit: { width: 64, height: 64, borderRadius: 32, backgroundColor: EXIT_RED, alignItems: 'center', justifyContent: 'center' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#1c1917', borderRadius: 14, borderWidth: 1, borderColor: '#facc15', padding: 12 },
  bannerText: { flex: 1, color: '#ffffff', fontSize: 15, fontWeight: '600' },
  bannerButton: { backgroundColor: '#facc15', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  bannerButtonText: { color: '#000000', fontWeight: '800', fontSize: 14 },
  nowPlaying: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  cover: { width: 76, height: 76, borderRadius: 10 },
  songText: { flex: 1, minWidth: 0 },
  title: { color: '#ffffff', fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  artist: { fontSize: 20, fontWeight: '600', marginTop: 2 },
  deviceRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  device: { fontSize: 14, fontWeight: '700' },
  zone: { flex: 1, minHeight: 160, justifyContent: 'center' },
  hints: { gap: 10, justifyContent: 'center', flex: 1 },
  hint: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  hintHow: { color: '#ffffff', fontSize: 19, fontWeight: '700', flexShrink: 1 },
  hintAction: { fontSize: 17, fontWeight: '600', marginLeft: 'auto' },
  handPill: {
    position: 'absolute',
    top: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#3a3a3a',
    backgroundColor: 'rgba(0,0,0,0.6)'
  },
  handText: { fontSize: 13, fontWeight: '700' },
  feedback: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  // Opaque: the hints behind would only blur the one word that matters.
  feedbackBackdrop: { flex: 1, backgroundColor: '#000000' },
  buttons: { flexDirection: 'row', gap: 12 },
  landscape: { flex: 1, flexDirection: 'row', gap: 20 },
  side: { width: '42%', justifyContent: 'space-between', gap: 14 }
})
