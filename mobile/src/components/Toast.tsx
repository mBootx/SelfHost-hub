import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useToastStore } from '@/store/toastStore'
import { colors, radius, spacing } from '@/constants/theme'

/** Mounted once near the tab navigator, like UploadToast. */
export default function Toast({ bottomOffset = 0 }: { bottomOffset?: number }) {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  if (toasts.length === 0) return null

  return (
    <View style={[styles.container, { bottom: bottomOffset }]} pointerEvents="box-none">
      {toasts.slice(-3).map((t) => (
        <Pressable key={t.id} style={styles.card} onPress={() => dismiss(t.id)}>
          <Text style={styles.text} numberOfLines={2}>
            {t.message}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { position: 'absolute', left: spacing.md, right: spacing.md, alignItems: 'center', gap: spacing.xs },
  card: {
    backgroundColor: colors.elevated,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  text: { color: colors.text, fontSize: 13, fontWeight: '500', textAlign: 'center' }
})
