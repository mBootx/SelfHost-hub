import { View, Text, Pressable, StyleSheet } from 'react-native'
import { ChartColumn, ChevronRight } from 'lucide-react-native'
import { SectionTitle } from '@/components/Screen'
import { useListeningStore } from '@/services/listeningLog'
import { durationLabel, totalSeconds, weekKey } from '@/services/wrapped'
import { useWrappedStore } from '@/store/wrappedStore'
import { colors, radius, spacing } from '@/constants/theme'

/** Settings → Écoute: the weekly Wrapped, open at any time. */
export default function WrappedSection() {
  const open = useWrappedStore((s) => s.open)
  const thisWeek = useListeningStore((s) => Math.round(totalSeconds(s.weeks[weekKey(Date.now())]) / 60))

  return (
    <View style={styles.section}>
      <SectionTitle>Écoute</SectionTitle>
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel="Récap de la semaine"
      >
        <View style={styles.iconWrap}>
          <ChartColumn size={20} color={colors.textSecondary} />
        </View>
        <View style={styles.rowInfo}>
          <Text style={styles.rowTitle}>Récap de la semaine</Text>
          <Text style={styles.rowMeta}>
            {thisWeek > 0 ? `${durationLabel(thisWeek)} cette semaine` : 'Top titres, minutes et artistes'} · tous les lundis à 10 h
          </Text>
        </View>
        <ChevronRight size={18} color={colors.textMuted} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm
  },
  iconWrap: { width: 40, height: 40, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.hover },
  rowInfo: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  rowMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 3 },
  pressed: { opacity: 0.6 }
})
