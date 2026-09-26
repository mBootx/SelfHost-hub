import { useEffect, useRef } from 'react'
import { AppState, AppStateStatus } from 'react-native'
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

  // Android can kill and recreate the whole JS engine while the app sits in the
  // background (or a session can simply go stale over a long pause) with nothing
  // in these stores ever noticing - the user just finds everything logged out
  // next time they look. Re-run the same handshakes used at cold start whenever
  // the app comes back to the foreground so that self-heals instead.
  const appState = useRef<AppStateStatus>(AppState.currentState)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (appState.current.match(/inactive|background/) && next === 'active') {
        restoreNavidrome()
        restoreFileBrowser()
        restoreDowntify()
      }
      appState.current = next
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
