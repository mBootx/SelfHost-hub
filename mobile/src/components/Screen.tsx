import { View, Text, Pressable, StyleSheet, StyleProp, ViewStyle } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors, radius, spacing } from '@/constants/theme'

type IconComponent = React.ComponentType<{ size?: number; color?: string }>

/**
 * Every tab screen runs without a navigation header, and the app draws edge to
 * edge, so each one has to claim the status bar inset itself or its first row of
 * content ends up underneath the clock.
 */
export function Screen({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <SafeAreaView edges={['top']} style={[styles.screen, style]}>
      {children}
    </SafeAreaView>
  )
}

export function ScreenHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <View style={styles.header}>
      <Text style={styles.headerTitle} numberOfLines={1}>
        {title}
      </Text>
      {action}
    </View>
  )
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{children}</Text>
      {action}
    </View>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action
}: {
  icon: IconComponent
  title: string
  hint?: string
  /** A button under the text ("Réessayer"). */
  action?: { label: string; onPress: () => void }
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon size={26} color={colors.textMuted} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {!!hint && <Text style={styles.emptyHint}>{hint}</Text>}
      {action && (
        <Pressable
          style={({ pressed }) => [styles.emptyButton, pressed && styles.emptyButtonPressed]}
          onPress={action.onPress}
          accessibilityRole="button"
        >
          <Text style={styles.emptyButtonText}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.base },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md
  },
  headerTitle: { flex: 1, color: colors.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm
  },
  sectionTitle: { flex: 1, color: colors.text, fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl, paddingHorizontal: spacing.xl, gap: spacing.sm },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.elevated,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emptyTitle: { color: colors.textSecondary, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  emptyHint: { color: colors.textMuted, fontSize: 12, textAlign: 'center', lineHeight: 17 },
  emptyButton: {
    marginTop: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm
  },
  emptyButtonPressed: { opacity: 0.6 },
  emptyButtonText: { color: '#000', fontWeight: '700', fontSize: 13 }
})
