import { View, Text, Pressable, StyleSheet } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import BottomSheet from '@/components/BottomSheet'
import { colors, radius, spacing, tint } from '@/constants/theme'

export interface ActionSheetItem {
  label: string
  icon: React.ComponentType<{ size?: number; color?: string }>
  onPress: () => void
  danger?: boolean
}

interface Props {
  visible: boolean
  title?: string
  subtitle?: string
  /** Something left of the title: a cover, usually. */
  leading?: React.ReactNode
  items: ActionSheetItem[]
  onClose: () => void
}

/** A menu in a bottom sheet: each action has an icon tile in the accent colour (red for the dangerous one). */
export default function ActionSheet({ visible, title, subtitle, leading, items, onClose }: Props) {
  return (
    <BottomSheet visible={visible} onClose={onClose} title={title} subtitle={subtitle} leading={leading}>
      <View style={styles.list}>
        {items.map((item, i) => {
          const tone = item.danger ? colors.danger : colors.accent
          return (
            <Pressable
              key={i}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              onPress={() => {
                onClose()
                item.onPress()
              }}
              accessibilityRole="button"
              accessibilityLabel={item.label}
            >
              <View style={[styles.tile, { backgroundColor: tint(tone, 0.14) }]}>
                <item.icon size={18} color={tone} />
              </View>
              <Text style={[styles.rowText, item.danger && { color: colors.danger }]} numberOfLines={1}>
                {item.label}
              </Text>
              <ChevronRight size={16} color={colors.textMuted} />
            </Pressable>
          )
        })}
      </View>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: spacing.sm, paddingBottom: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2, borderRadius: radius.md },
  pressed: { backgroundColor: colors.hover },
  tile: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '600' }
})
