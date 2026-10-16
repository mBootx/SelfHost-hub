import { View, Text, Pressable, StyleSheet } from 'react-native'
import type { BottomTabBarProps } from 'expo-router/js-tabs'
import { Home, Library, Heart, Search, FolderOpen, Images, Settings } from 'lucide-react-native'
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated'
import { useTabAnimationStore } from '@/store/tabAnimationStore'
import { colors, layout, radius, spacing, tint } from '@/constants/theme'

type IconComponent = React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>

/**
 * Seven labels won't all fit at phone widths, so only the active tab is labelled -
 * it has the whole slot to itself - and the rest just go from muted to accent.
 * `name` is the untruncated screen reader text.
 */
const TABS: Record<string, { icon: IconComponent; label: string; name: string }> = {
  index: { icon: Home, label: 'Accueil', name: 'Accueil' },
  library: { icon: Library, label: 'Biblio', name: 'Bibliothèque' },
  favorites: { icon: Heart, label: 'Favoris', name: 'Favoris' },
  search: { icon: Search, label: 'Recherche', name: 'Recherche' },
  files: { icon: FolderOpen, label: 'Fichiers', name: 'Fichiers' },
  photos: { icon: Images, label: 'Photos', name: 'Photos' },
  settings: { icon: Settings, label: 'Réglages', name: 'Réglages' }
}

interface TabItemProps {
  routeKey: string
  routeName: string
  focused: boolean
  tab: { icon: IconComponent; label: string; name: string }
  duration: number
  animationType: string
  onPress: () => void
}

function TabItem({ focused, tab, duration, animationType, onPress }: TabItemProps) {
  const Icon = tab.icon

  const pillStyle = useAnimatedStyle(() => {
    if (animationType === 'none') {
      return { opacity: focused ? 1 : 0 }
    }
    return {
      opacity: withTiming(focused ? 1 : 0, { duration: Math.min(duration, 220) })
    }
  }, [focused, animationType, duration])

  const iconStyle = useAnimatedStyle(() => {
    if (animationType === 'none') {
      return { transform: [{ scale: 1 }] }
    }
    return {
      transform: [
        {
          scale: withTiming(focused ? 1.08 : 1.0, { duration: Math.min(duration, 220) })
        }
      ]
    }
  }, [focused, animationType, duration])

  const labelStyle = useAnimatedStyle(() => {
    if (animationType === 'none') {
      return { opacity: focused ? 1 : 0, transform: [{ translateY: 0 }] }
    }
    return {
      opacity: withTiming(focused ? 1 : 0, { duration: Math.min(duration, 200) }),
      transform: [
        {
          translateY: withTiming(focused ? 0 : 2, { duration: Math.min(duration, 200) })
        }
      ]
    }
  }, [focused, animationType, duration])

  return (
    <Pressable
      style={styles.item}
      onPress={onPress}
      android_ripple={{ color: colors.hover, borderless: true, radius: 30 }}
      accessibilityRole="button"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={tab.name}
    >
      <View style={styles.iconWrap}>
        <Animated.View style={[styles.pill, pillStyle]} />
        <Animated.View style={iconStyle}>
          <Icon size={23} color={focused ? colors.accent : colors.textMuted} strokeWidth={focused ? 2.4 : 1.9} />
        </Animated.View>
      </View>
      {focused && (
        <Animated.View style={labelStyle}>
          <Text style={styles.label} numberOfLines={1}>
            {tab.label}
          </Text>
        </Animated.View>
      )}
    </Pressable>
  )
}

export default function TabBar({ state, navigation, insets }: BottomTabBarProps) {
  const animationType = useTabAnimationStore((s) => s.animationType)
  const durationMs = useTabAnimationStore((s) => s.durationMs)

  return (
    <View style={[styles.bar, { height: layout.tabBar + insets.bottom, paddingBottom: insets.bottom }]}>
      {state.routes.map((route, index) => {
        const tab = TABS[route.name]
        if (!tab) return null

        const focused = state.index === index

        function onPress(): void {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })
          if (!focused && !event.defaultPrevented) {
            navigation.navigate(route.name, route.params)
          }
        }

        return (
          <TabItem
            key={route.key}
            routeKey={route.key}
            routeName={route.name}
            focused={focused}
            tab={tab}
            duration={durationMs}
            animationType={animationType}
            onPress={onPress}
          />
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
  pill: {
    position: 'absolute',
    width: 38,
    height: 26,
    borderRadius: radius.full,
    backgroundColor: tint(colors.accent, 0.14)
  },
  /** Only the active tab is labelled, so it never has to compete for width. */
  label: { color: colors.accent, fontSize: 9, fontWeight: '700', letterSpacing: -0.1 }
})

