import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import PlaybackController from '@/components/PlaybackController'
import PlayerOverlay from '@/components/PlayerOverlay'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { useDowntifyStore } from '@/store/downtifyStore'
import { useOfflineStore } from '@/store/offlineStore'
import { useArtworkStore } from '@/store/artworkStore'
import { useDownloadStore } from '@/store/downloadStore'
import { useRemoteStore } from '@/store/remoteStore'
import { useHistoryStore } from '@/store/historyStore'
import { colors } from '@/constants/theme'

/** A quick hop to another app shouldn't redo three logins on the way back. */
const RESUME_REVALIDATE_MS = 30_000

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
  const restoreDowntify = useDowntifyStore((s) => s.restoreSession)
  const loadOfflineTracks = useOfflineStore((s) => s.loadFromDisk)
  const loadArtworkOverrides = useArtworkStore((s) => s.loadFromDisk)
  const loadDownloads = useDownloadStore((s) => s.loadFromDisk)
  const initRemote = useRemoteStore((s) => s.init)
  const loadHistory = useHistoryStore((s) => s.loadFromDisk)

  useEffect(() => {
    restoreNavidrome()
    restoreFileBrowser()
    restoreDowntify()
    loadOfflineTracks()
    loadArtworkOverrides()
    loadDownloads()
    initRemote()
    loadHistory()
    loadPlaybackPrefs()
  }, [])

  // A session can go stale over a long pause in the background with nothing in
  // these stores noticing, so re-run the cold-start handshakes when the app
  // comes back after a while. Keyed on a real 'background' event rather than
  // AppState.currentState: Android reports 'background' as the initial state
  // whenever JS loads before the activity resumes, which made the launch itself
  // look like a resume and ran every login twice, racing the mount effect above.
  const backgroundedAt = useRef<number | null>(null)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        backgroundedAt.current = Date.now()
      } else if (next === 'active' && backgroundedAt.current !== null) {
        const awayMs = Date.now() - backgroundedAt.current
        backgroundedAt.current = null
        if (awayMs > RESUME_REVALIDATE_MS) {
          restoreNavidrome()
          restoreFileBrowser()
          restoreDowntify()
        }
      }
    })
    return () => sub.remove()
  }, [restoreNavidrome, restoreFileBrowser, restoreDowntify])

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.base }}>
      <StatusBar style="light" />
      <PlaybackController />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.base } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="album/[id]" options={detailHeader} />
        <Stack.Screen name="artist/[id]" options={detailHeader} />
        <Stack.Screen name="playlist/[id]" options={detailHeader} />
        <Stack.Screen name="downtify/queue" options={detailHeader} />
        <Stack.Screen name="downtify/connect" options={detailHeader} />
        <Stack.Screen name="devices/index" options={detailHeader} />
        <Stack.Screen name="now-playing" options={{ presentation: 'modal' }} />
      </Stack>
      <PlayerOverlay />
    </GestureHandlerRootView>
  )
}
