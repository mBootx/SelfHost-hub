import { Pressable, StyleSheet, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import { colors, spacing } from '@/constants/theme'

export interface SelectionAction {
  label: string
  icon: React.ComponentType<{ size?: number; color?: string }>
  onPress: () => void
  danger?: boolean
}

/** Replaces the top bar while files are selected: how many, and what can be done with them. */
export default function FilesSelectionBar({ count, actions, onClear }: { count: number; actions: SelectionAction[]; onClear: () => void }) {
  return (
    <View style={styles.bar}>
      <Pressable onPress={onClear} hitSlop={12} accessibilityRole="button" accessibilityLabel="Annuler la sélection">
        <X size={22} color={colors.text} />
      </Pressable>
      <Text style={styles.count}>{count > 1 ? `${count} éléments` : '1 élément'}</Text>
      {actions.map((action) => (
        <Pressable key={action.label} onPress={action.onPress} hitSlop={10} accessibilityRole="button" accessibilityLabel={action.label}>
          <action.icon size={21} color={action.danger ? colors.danger : colors.text} />
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, minHeight: 44 },
  count: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '700' }
})
