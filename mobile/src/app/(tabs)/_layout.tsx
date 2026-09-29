import { View, StyleSheet } from 'react-native'
import { Tabs } from 'expo-router/js-tabs'
import TabBar from '@/components/TabBar'
import { useKeyboardVisible } from '@/hooks/useKeyboardVisible'
import { colors } from '@/constants/theme'

/**
 * Only the tab bar lives here. The mini player, upload toast and track sheet are
 * mounted at the root instead, so they stay put when an album, playlist or artist
 * screen is pushed over the tabs.
 */
export default function TabsLayout() {
  const keyboardVisible = useKeyboardVisible()

  return (
    <View style={styles.root}>
      <Tabs
        tabBar={(props) => (keyboardVisible ? null : <TabBar {...props} />)}
        screenOptions={{
          headerShown: false,
          sceneStyle: { backgroundColor: colors.base }
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Accueil' }} />
        <Tabs.Screen name="library" options={{ title: 'Bibliothèque' }} />
        <Tabs.Screen name="favorites" options={{ title: 'Favoris' }} />
        <Tabs.Screen name="search" options={{ title: 'Recherche' }} />
        <Tabs.Screen name="files" options={{ title: 'Fichiers' }} />
        <Tabs.Screen name="settings" options={{ title: 'Réglages' }} />
      </Tabs>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base }
})
