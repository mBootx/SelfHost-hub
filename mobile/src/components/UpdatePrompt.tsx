import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Download, X } from 'lucide-react-native'
import { useUpdateStore } from '@/store/updateStore'
import { colors, radius, spacing } from '@/constants/theme'

/** Floats at the top, clear of the mini player and toasts stacked at the bottom. */
export default function UpdatePrompt() {
  const insets = useSafeAreaInsets()
  const update = useUpdateStore((s) => s.update)
  const phase = useUpdateStore((s) => s.phase)
  const progress = useUpdateStore((s) => s.progress)
  const error = useUpdateStore((s) => s.error)
  const dismissed = useUpdateStore((s) => s.dismissed)
  const install = useUpdateStore((s) => s.install)
  const dismiss = useUpdateStore((s) => s.dismiss)

  if (!update || dismissed || phase === 'idle' || phase === 'checking') return null
  const downloading = phase === 'downloading'
  const sizeMb = Math.round(update.sizeBytes / (1024 * 1024))

  return (
    <View style={[styles.card, { top: insets.top + spacing.sm }]}>
      <View style={styles.row}>
        <Download size={16} color={colors.accent} />
        <Text style={styles.title} numberOfLines={1}>
          Mise a jour {update.version} disponible
        </Text>
        {!downloading && (
          <Pressable onPress={dismiss} hitSlop={10} accessibilityRole="button" accessibilityLabel="Plus tard">
            <X size={16} color={colors.textMuted} />
          </Pressable>
        )}
      </View>
      {downloading ? (
        <>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${progress}%` }]} />
          </View>
          <Text style={styles.meta}>Telechargement... {progress}%</Text>
        </>
      ) : (
        <>
          <Text style={phase === 'error' ? styles.error : styles.meta} numberOfLines={2}>
            {phase === 'error' ? error : `${sizeMb} Mo - Android vous demandera de confirmer l'installation.`}
          </Text>
          <Pressable style={({ pressed }) => [styles.button, pressed && styles.pressed]} onPress={install}>
            <Text style={styles.buttonText}>{phase === 'error' ? 'Reessayer' : 'Mettre a jour'}</Text>
          </Pressable>
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    elevation: 12,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 }
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '700' },
  meta: { color: colors.textSecondary, fontSize: 12, marginTop: spacing.xs },
  error: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
  track: { height: 4, borderRadius: radius.full, backgroundColor: colors.hover, overflow: 'hidden', marginTop: spacing.sm },
  fill: { height: 4, backgroundColor: colors.accent },
  button: {
    alignSelf: 'flex-start',
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginTop: spacing.sm
  },
  pressed: { opacity: 0.7 },
  buttonText: { color: '#000', fontWeight: '700', fontSize: 13 }
})
