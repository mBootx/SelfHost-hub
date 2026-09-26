import { Modal, View, Text, Pressable, StyleSheet } from 'react-native'
import { colors, radius, spacing } from '@/constants/theme'

export interface ActionSheetItem {
  label: string
  icon: React.ComponentType<{ size?: number; color?: string }>
  onPress: () => void
  danger?: boolean
}

interface Props {
  visible: boolean
  title?: string
  items: ActionSheetItem[]
  onClose: () => void
}

export default function ActionSheet({ visible, title, items, onClose }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.sheet} onStartShouldSetResponder={() => true}>
          {title && (
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
          )}
          {items.map((item, i) => (
            <Pressable
              key={i}
              style={styles.row}
              onPress={() => {
                onClose()
                item.onPress()
              }}
            >
              <item.icon size={18} color={item.danger ? colors.danger : colors.text} />
              <Text style={[styles.rowText, item.danger && { color: colors.danger }]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.elevated,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingBottom: spacing.xl
  },
  title: { color: colors.textMuted, fontSize: 12, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  rowText: { color: colors.text, fontSize: 15 }
})
