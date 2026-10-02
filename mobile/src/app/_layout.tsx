import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import PlaybackController from '@/components/PlaybackController'
import PlayerOverlay from '@/components/PlayerOverlay'
import ShareSheet from '@/components/ShareSheet'
import UpdatePrompt from '@/components/UpdatePrompt'
import WhatsNewModal from '@/components/WhatsNewModal'
import LockScreen from '@/components/lock/LockScreen'
import { pruneStaleDownloads } from '@/services/appUpdate'
import { installErrorLogging } from '@/services/diagnostics'
import { startPlaybackMemory } from '@/services/playbackMemory'
import { startScrobbler } from '@/services/scrobbler'
import { startDownloadWatcher } from '@/services/downloadWatcher'
import { startCameraBackup } from '@/services/cameraBackup'
import { startShareIntake } from '@/services/shareIntake'
import { initSleepTimer } from '@/services/sleepTimer'
import { startWidget } from '@/services/widget'
import { useUpdateStore } from '@/store/updateStore'
import { useWhatsNewStore } from '@/store/whatsNewStore'
import { startAppLock } from '@/store/appLockStore'
import { useAudioSettingsStore } from '@/store/audioSettingsStore'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { useDowntifyStore } from '@/store/downtifyStore'
import { useOfflineStore } from '@/store/offlineStore'
import { useArtworkStore } from '@/store/artworkStore'
import { useDownloadStore } from '@/store/downloadStore'
import { useRemoteStore } from '@/store/remoteStore'
import { useHistoryStore } from '@/store/historyStore'
import { colors } from '@/constants/theme'
import { ConnectionStatus } from '@/types'

// As soon as this file loads, so a crash while the screens are being built is written down too.
installErrorLogging()

/** A quick hop to another app shouldn't re-check every service on the way back. */
const RESUME_REVALIDATE_MS = 30_000

function isDown(status: ConnectionStatus): boolean {
  return status !== 'connected' && status !== 'connecting'
}

/**
 * The detail screens keep a back button but no title bar colour of their own, so
 * the header melts into the content instead of banding across the top.
 */
const detailHeader = {
  headerShown: true,
  title: '',
  headerShadowVisible: false,
  headerStyle: { backgroundColor: colors.base },
  headerTintColor: colors.text,
  headerTitleStyle: { color: colors.text }
} as const

export default function RootLayout() {
  const restoreNavidrome = useNavidromeStore((s) => s.restoreSession)
  const loadPlaybackPrefs = useNavidromeStore((s) => s.loadPlaybackPrefs)
  const restoreFileBrowser = useFileBrowserStore((s) => s.restoreSession)
  const revalidateFileBrowser = useFileBrowserStore((s) => s.revalidate)
  const restoreDowntify = useDowntifyStore((s) => s.restoreSession)
  const loadOfflineTracks = useOfflineStore((s) => s.loadFromDisk)
  const loadArtworkOverrides = useArtworkStore((s) => s.loadFromDisk)
  const loadDownloads = useDownloadStore((s) => s.loadFromDisk)
  const initRemote = useRemoteStore((s) => s.init)
  const loadHistory = useHistoryStore((s) => s.loadFromDisk)
  const checkForUpdate = useUpdateStore((s) => s.check)
  const loadAudioSettings = useAudioSettingsStore((s) => s.load)
  const checkWhatsNew = useWhatsNewStore((s) => s.check)

  useEffect(() => {
    startAppLock()
    restoreNavidrome()
    restoreFileBrowser()
    restoreDowntify()
    loadOfflineTracks()
    loadArtworkOverrides()
    loadDownloads()
    initRemote()
    loadHistory()
    loadPlaybackPrefs()
    loadAudioSettings()
    startPlaybackMemory()
    startScrobbler()
    startDownloadWatcher()
    startCameraBackup()
    startShareIntake()
    initSleepTimer()
    startWidget()
    // Keeps a downloaded APK that is still newer than this install, so retrying an update doesn't re-download it.
    pruneStaleDownloads()
    checkForUpdate()
    checkWhatsNew()
  }, [])

  // Keyed on a real 'background' event, not AppState.currentState, which Android can
  // report as 'background' at launch. Only services that are actually down reconnect:
  // replacing a working client makes every open screen reload its data.
  const backgroundedAt = useRef<number | null>(null)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        backgroundedAt.current = Date.now()
      } else if (next === 'active' && backgroundedAt.current !== null) {
        const awayMs = Date.now() - backgroundedAt.current
        backgroundedAt.current = null
        if (awayMs > RESUME_REVALIDATE_MS) {
          if (isDown(useNavidromeStore.getState().status)) restoreNavidrome()
          if (isDown(useDowntifyStore.getState().status)) restoreDowntify()
          revalidateFileBrowser()
          checkForUpdate()
        }
      }
    })
    return () => sub.remove()
  }, [restoreNavidrome, restoreDowntify, revalidateFileBrowser, checkForUpdate])

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.base }}>
      <StatusBar style="light" />
      <PlaybackController />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.base } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="album/[id]" options={detailHeader} />
        <Stack.Screen name="artist/[id]" options={detailHeader} />
        <Stack.Screen name="genre/[name]" options={detailHeader} />
        <Stack.Screen name="playlist/[id]" options={detailHeader} />
        <Stack.Screen name="downtify/queue" options={detailHeader} />
        <Stack.Screen name="downtify/connect" options={detailHeader} />
        <Stack.Screen name="devices/index" options={detailHeader} />
        <Stack.Screen name="server/index" options={detailHeader} />
        <Stack.Screen name="shares" options={detailHeader} />
        <Stack.Screen name="diagnostics" options={detailHeader} />
        <Stack.Screen name="trash" options={detailHeader} />
        <Stack.Screen name="now-playing" options={{ presentation: 'modal' }} />
      </Stack>
      <PlayerOverlay />
      <UpdatePrompt />
      <WhatsNewModal />
      <ShareSheet />
      {/* Last, so it opens above every other window. */}
      <LockScreen />
    </GestureHandlerRootView>
  )
}
