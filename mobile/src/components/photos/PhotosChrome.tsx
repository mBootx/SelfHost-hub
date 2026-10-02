import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import type { LucideIcon } from 'lucide-react-native'
import { Search, X } from 'lucide-react-native'
import { colors, radius, spacing } from '@/constants/theme'

export interface BarAction {
  key: string
  label: string
  icon: LucideIcon
  destructive?: boolean
  onPress: () => void
}

/** Replaces the header while photos are selected: how many, and what to do with them. */
export function SelectionBar({ count, onClear, actions }: { count: number; onClear: () => void; actions: BarAction[] }) {
  return (
    <View style={styles.selection}>
      <Pressable onPress={onClear} hitSlop={12} accessibilityRole="button" accessibilityLabel="Annuler la sélection">
        <X size={24} color={colors.text} />
      </Pressable>
      <Text style={styles.count}>
        {count} sélectionné{count > 1 ? 's' : ''}
      </Text>
      {actions.map((action) => (
        <Pressable key={action.key} onPress={action.onPress} hitSlop={12} accessibilityRole="button" accessibilityLabel={action.label}>
          <action.icon size={22} color={action.destructive ? colors.danger : colors.text} />
        </Pressable>
      ))}
    </View>
  )
}

export interface ChipItem {
  id: string
  label: string
  count?: number
}

/** A row of pills to filter by; the chosen one is filled. Scrolls sideways when there are many. */
export function Chips({ items, value, onChange, label }: { items: ChipItem[]; value: string; onChange: (id: string) => void; label: string }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chips}
      style={styles.chipsScroll}
      accessibilityLabel={label}
    >
      {items.map((item) => {
        const selected = item.id === value
        return (
          <Pressable
            key={item.id}
            onPress={() => onChange(item.id)}
            style={[styles.chip, selected && styles.chipOn]}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={item.label}
          >
            <Text style={[styles.chipText, selected && styles.chipTextOn]} numberOfLines={1}>
              {item.label}
              {item.count !== undefined ? ` · ${item.count}` : ''}
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

export function SearchField({
  value,
  onChange,
  onClose,
  placeholder = 'Rechercher par nom',
  label = 'Rechercher une photo par son nom'
}: {
  value: string
  onChange: (text: string) => void
  onClose: () => void
  placeholder?: string
  label?: string
}) {
  return (
    <View style={styles.search}>
      <Search size={16} color={colors.textMuted} />
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={label}
      />
      <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Fermer la recherche">
        <X size={16} color={colors.textMuted} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  selection: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md, minHeight: 56 },
  count: { flex: 1, color: colors.text, fontSize: 17, fontWeight: '700' },
  chipsScroll: { flexGrow: 0, flexShrink: 0, marginBottom: spacing.sm },
  chips: { gap: spacing.sm, paddingHorizontal: spacing.lg },
  chip: { borderRadius: radius.full, borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2 },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  chipTextOn: { color: '#000000', fontWeight: '700' },
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
