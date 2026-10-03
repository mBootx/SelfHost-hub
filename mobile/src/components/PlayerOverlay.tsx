import { View, StyleSheet } from 'react-native'
import { useSegments } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import MiniPlayer from '@/components/MiniPlayer'
import UploadToast from '@/components/UploadToast'
import Toast from '@/components/Toast'
import TrackOptionsSheet from '@/components/navidrome/TrackOptionsSheet'
import PlaylistPickerSheet from '@/components/navidrome/PlaylistPickerSheet'
import { useKeyboardVisible } from '@/hooks/useKeyboardVisible'
import { layout, spacing } from '@/constants/theme'

/**
 * The persistent chrome, mounted at the root rather than inside the tab layout.
 * Album, playlist and artist screens are siblings of the tabs, so anything drawn
 * inside the tab layout vanished the moment one of them was pushed - which is
 * why the mini player disappeared as soon as you opened a playlist.
 *
 * It sits above the tab bar on a tab screen and on the bottom edge elsewhere,
 * and steps aside for the full-screen player and the keyboard.
 */
export default function PlayerOverlay() {
  const segments = useSegments()
  const insets = useSafeAreaInsets()
  const keyboardVisible = useKeyboardVisible()

  const root = segments[0] as string | undefined
  const onTabs = root === '(tabs)'
  // The full-screen player and the car mode have their own controls.
  const fullScreen = root === 'now-playing' || root === 'car-mode'

  // The tab bar is only drawn on tab routes; elsewhere the overlay owns the
  // bottom inset itself.
  const bottom = onTabs ? layout.tabBar + insets.bottom : insets.bottom
  const hideChrome = fullScreen || keyboardVisible

  return (
    <>
      {!hideChrome && (
        <>
          <View style={[styles.floating, { bottom }]} pointerEvents="box-none">
            <MiniPlayer />
          </View>
          <UploadToast bottomOffset={bottom} />
        </>
      )}
      {/* Stays mounted regardless: a long-press can happen with the keyboard up,
          for instance on a search result. */}
      <TrackOptionsSheet />
      <PlaylistPickerSheet />
      <Toast bottomOffset={hideChrome ? insets.bottom + spacing.lg : bottom + layout.miniPlayer + spacing.sm} />
    </>
  )
}

const styles = StyleSheet.create({
  floating: { position: 'absolute', left: 0, right: 0 }
})
