import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Search, Trash2, X } from 'lucide-react-native'
import { colors, radius, spacing } from '@/constants/theme'

/** Replaces the header while photos are selected: how many, and the two things to do with them. */
export function SelectionBar({ count, onClear, onDelete }: { count: number; onClear: () => void; onDelete: () => void }) {
  return (
    <View style={styles.selection}>
      <Pressable onPress={onClear} hitSlop={12} accessibilityRole="button" accessibilityLabel="Annuler la sélection">
        <X size={24} color={colors.text} />
      </Pressable>
      <Text style={styles.count}>
        {count} sélectionnée{count > 1 ? 's' : ''}
      </Text>
      <Pressable onPress={onDelete} hitSlop={12} accessibilityRole="button" accessibilityLabel="Supprimer la sélection">
        <Trash2 size={22} color={colors.danger} />
      </Pressable>
    </View>
  )
}

export function SearchField({ value, onChange, onClose }: { value: string; onChange: (text: string) => void; onClose: () => void }) {
  return (
    <View style={styles.search}>
      <Search size={16} color={colors.textMuted} />
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder="Rechercher par nom"
        placeholderTextColor={colors.textMuted}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel="Rechercher une photo par son nom"
      />
      <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Fermer la recherche">
        <X size={16} color={colors.textMuted} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  selection: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md, minHeight: 56 },
  count: { flex: 1, color: colors.text, fontSize: 17, fontWeight: '700' },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.elevated
  },
  input: { flex: 1, color: colors.text, fontSize: 14, paddingVertical: spacing.sm }
})
