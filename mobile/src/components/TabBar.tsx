import { View, Text, Pressable, StyleSheet } from 'react-native'
import type { BottomTabBarProps } from 'expo-router/js-tabs'
import { Home, Library, Heart, Search, FolderOpen, Settings } from 'lucide-react-native'
import { colors, layout, spacing } from '@/constants/theme'

type IconComponent = React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>

/**
 * Six labels won't all fit at phone widths, so only the active tab is labelled -
 * it has the whole slot to itself - and the rest just go from muted to accent.
 * `name` is the untruncated screen reader text.
 */
const TABS: Record<string, { icon: IconComponent; label: string; name: string }> = {
  index: { icon: Home, label: 'Accueil', name: 'Accueil' },
  library: { icon: Library, label: 'Biblio', name: 'Bibliotheque' },
  favorites: { icon: Heart, label: 'Favoris', name: 'Favoris' },
  search: { icon: Search, label: 'Recherche', name: 'Recherche' },
  files: { icon: FolderOpen, label: 'Fichiers', name: 'Fichiers' },
  settings: { icon: Settings, label: 'Reglages', name: 'Reglages' }
}

export default function TabBar({ state, navigation, insets }: BottomTabBarProps) {
  return (
    <View style={[styles.bar, { height: layout.tabBar + insets.bottom, paddingBottom: insets.bottom }]}>
      {state.routes.map((route, index) => {
        const tab = TABS[route.name]
        if (!tab) return null

        const focused = state.index === index
        const Icon = tab.icon

        function onPress(): void {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })
          if (!focused && !event.defaultPrevented) {
            navigation.navigate(route.name, route.params)
          }
        }

        return (
          <Pressable
            key={route.key}
            style={styles.item}
            onPress={onPress}
            android_ripple={{ color: colors.hover, borderless: true, radius: 30 }}
            accessibilityRole="button"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={tab.name}
          >
            <View style={styles.iconWrap}>
              <Icon size={23} color={focused ? colors.accent : colors.textMuted} strokeWidth={focused ? 2.4 : 1.9} />
            </View>
            {focused && (
              <Text style={styles.label} numberOfLines={1}>
                {tab.label}
              </Text>
            )}
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.raised,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.sm
  },
  item: { flex: 1, alignItems: 'center', justifyContent: 'flex-start', gap: 2, paddingHorizontal: 2 },
  iconWrap: { height: 30, alignItems: 'center', justifyContent: 'center' },
  /** Only the active tab is labelled, so it never has to compete for width. */
  label: { color: colors.accent, fontSize: 9, fontWeight: '700', letterSpacing: -0.1 }
})
