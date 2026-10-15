import { Pressable, StyleSheet, Text } from 'react-native'
import { ListChecks } from 'lucide-react-native'
import { useSelectionStore } from '@/store/selectionStore'
import { colors, radius, spacing } from '@/constants/theme'

/** Starts picking songs in the list on screen. `label` makes it a text button (for a section header); without, a round icon. */
export default function SelectButton({ label }: { label?: string }) {
  const start = useSelectionStore((s) => s.start)
  const active = useSelectionStore((s) => s.active)
  return (
    <Pressable
      style={({ pressed }) => [label ? styles.text : styles.round, active && styles.on, pressed && styles.pressed]}
      onPress={() => (active ? useSelectionStore.getState().clear() : start())}
      accessibilityRole="button"
      accessibilityLabel={active ? 'Annuler la sélection' : 'Sélectionner plusieurs titres'}
      accessibilityState={{ selected: active }}
    >
      <ListChecks size={16} color={active ? colors.accent : colors.textSecondary} />
      {!!label && <Text style={[styles.label, active && { color: colors.accent }]}>{label}</Text>}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  round: { width: 44, height: 44, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  text: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border },
  on: { borderColor: colors.accent },
  label: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  pressed: { opacity: 0.6 }
})
