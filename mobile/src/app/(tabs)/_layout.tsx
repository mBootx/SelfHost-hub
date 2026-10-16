import { useMemo } from 'react'
import { View, StyleSheet, Easing } from 'react-native'
import { Tabs } from 'expo-router/js-tabs'
import TabBar from '@/components/TabBar'
import { useKeyboardVisible } from '@/hooks/useKeyboardVisible'
import { useTabAnimationStore } from '@/store/tabAnimationStore'
import { colors } from '@/constants/theme'

/**
 * Only the tab bar lives here. The mini player, upload toast and track sheet are
 * mounted at the root instead, so they stay put when an album, playlist or artist
 * screen is pushed over the tabs.
 */
export default function TabsLayout() {
  const keyboardVisible = useKeyboardVisible()
  const animationType = useTabAnimationStore((s) => s.animationType)
  const durationMs = useTabAnimationStore((s) => s.durationMs)

  const screenOptions = useMemo(() => {
    if (animationType === 'none') {
      return {
        headerShown: false,
        sceneStyle: { backgroundColor: colors.base },
        animation: 'none' as const,
        transitionSpec: {
          animation: 'timing' as const,
          config: { duration: 0 }
        }
      }
    }

    return {
      headerShown: false,
      sceneStyle: { backgroundColor: colors.base },
      animation: animationType,
      transitionSpec: {
        animation: 'timing' as const,
        config: {
          duration: durationMs,
          easing: Easing.bezier(0.25, 0.1, 0.25, 1)
        }
      }
    }
  }, [animationType, durationMs])

  return (
    <View style={styles.root}>
      <Tabs
        tabBar={(props) => (keyboardVisible ? null : <TabBar {...props} />)}
        screenOptions={screenOptions}
      >
        <Tabs.Screen name="index" options={{ title: 'Accueil' }} />
        <Tabs.Screen name="library" options={{ title: 'Bibliothèque' }} />
        <Tabs.Screen name="favorites" options={{ title: 'Favoris' }} />
        <Tabs.Screen name="search" options={{ title: 'Recherche' }} />
        <Tabs.Screen name="files" options={{ title: 'Fichiers' }} />
        <Tabs.Screen name="photos" options={{ title: 'Photos' }} />
        <Tabs.Screen name="settings" options={{ title: 'Réglages' }} />
      </Tabs>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base }
})
