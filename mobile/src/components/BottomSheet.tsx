import { ReactNode, useEffect, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { X } from 'lucide-react-native'
import { colors, radius, spacing } from '@/constants/theme'

interface Props {
  visible: boolean
  onClose: () => void
  title?: string
  subtitle?: string
  /** Something to the left of the title (a cover, an icon tile). */
  leading?: ReactNode
  /** The content scrolls inside the sheet; a list that scrolls by itself passes false. */
  scrollable?: boolean
  /** The share of the screen's height the sheet may take. */
  maxHeight?: number
  children: ReactNode
}

const ENTER_MS = 260
const EXIT_MS = 190
/** Dragged down this far, or flicked down this fast, the sheet closes. */
const CLOSE_DISTANCE = 90
const CLOSE_VELOCITY = 800

/**
 * The one bottom sheet of the app (track menu, playlist choice...): it slides up over a dimmed screen, has a handle to
 * drag it down by, and keeps to the theme (surfaces and accent come from `colors`, so a colour change reaches it).
 */
export default function BottomSheet({ visible, onClose, title, subtitle, leading, scrollable = true, maxHeight = 0.82, children }: Props) {
  const { height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  // Kept on screen while it slides away, then taken off.
  const [mounted, setMounted] = useState(visible)
  const progress = useSharedValue(0)
  const drag = useSharedValue(0)

  useEffect(() => {
    if (visible) {
      drag.value = 0
      setMounted(true)
      progress.value = withTiming(1, { duration: ENTER_MS, easing: Easing.out(Easing.cubic) })
    } else {
      progress.value = withTiming(0, { duration: EXIT_MS, easing: Easing.in(Easing.cubic) }, (finished) => {
        if (finished) runOnJS(setMounted)(false)
      })
    }
  }, [visible, progress, drag])

  const pan = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .onUpdate((e) => {
      drag.value = Math.max(0, e.translationY)
    })
    .onEnd((e) => {
      if (e.translationY > CLOSE_DISTANCE || e.velocityY > CLOSE_VELOCITY) {
        runOnJS(onClose)()
      } else {
        drag.value = withTiming(0, { duration: 160 })
      }
    })

  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value * (1 - Math.min(1, drag.value / (height * 0.5))) }))
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - progress.value) * height * 0.6 + drag.value }], opacity: Math.min(1, progress.value * 2.5) }))

  if (!mounted) return null

  const body = scrollable ? (
    <ScrollView bounces={false} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={styles.scroll}>
      {children}
    </ScrollView>
  ) : (
    children
  )

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.root}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Fermer" accessibilityRole="button" />
        </Animated.View>
        <Animated.View style={[styles.sheet, { maxHeight: height * maxHeight, paddingBottom: Math.max(insets.bottom, spacing.md) + spacing.sm }, sheetStyle]}>
          <GestureDetector gesture={pan}>
            <View collapsable={false}>
              <View style={styles.handleArea}>
                <View style={styles.handle} />
              </View>
              {(title || leading) && (
                <View style={styles.header}>
                  {leading}
                  <View style={styles.headerText}>
                    {!!title && (
                      <Text style={styles.title} numberOfLines={1}>
                        {title}
                      </Text>
                    )}
                    {!!subtitle && (
                      <Text style={styles.subtitle} numberOfLines={1}>
                        {subtitle}
                      </Text>
                    )}
                  </View>
                  <Pressable
                    onPress={onClose}
                    hitSlop={10}
                    style={({ pressed }) => [styles.close, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Fermer"
                  >
                    <X size={16} color={colors.textSecondary} />
                  </Pressable>
                </View>
              )}
            </View>
          </GestureDetector>
          {body}
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.62)' },
  sheet: {
    backgroundColor: colors.elevated,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
    elevation: 24
  },
  handleArea: { alignItems: 'center', paddingTop: spacing.sm, paddingBottom: spacing.xs },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.hover },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md },
  headerText: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
  subtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  close: { width: 32, height: 32, borderRadius: radius.full, backgroundColor: colors.hover, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  scroll: { flexGrow: 0 }
})
