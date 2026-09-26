import { View, Text, StyleSheet } from 'react-native'
import { HardDrive } from 'lucide-react-native'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { colors, radius, spacing } from '@/constants/theme'

function formatGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1)
}

export default function UsageMeter() {
  const usage = useFileBrowserStore((s) => s.usage)
  if (!usage || !usage.total) return null

  const barColor = usage.usedPercentage >= 90 ? colors.danger : usage.usedPercentage >= 75 ? colors.warning : colors.accent

  return (
    <View style={styles.container}>
      <HardDrive size={16} color={colors.textMuted} />
      <View style={{ flex: 1 }}>
        <View style={styles.headerRow}>
          <Text style={styles.name} numberOfLines={1}>
            {usage.name}
          </Text>
          <Text style={styles.value}>
            {formatGb(usage.used)} / {formatGb(usage.total)} Go
          </Text>
        </View>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${Math.min(100, usage.usedPercentage)}%`, backgroundColor: barColor }]} />
        </View>
      </View>
      <Text style={styles.percent}>{usage.usedPercentage}%</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.elevated,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  name: { color: colors.textMuted, fontSize: 11, flex: 1 },
  value: { color: colors.textSecondary, fontSize: 11, fontWeight: '600' },
  track: { height: 5, borderRadius: radius.full, backgroundColor: colors.hover, overflow: 'hidden' },
  fill: { height: 5, borderRadius: radius.full },
  percent: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' }
})
