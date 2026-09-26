import { useEffect, useState } from 'react'
import { Modal, View, Text, TextInput, Pressable, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native'
import { colors, radius, spacing } from '@/constants/theme'

interface Props {
  visible: boolean
  title: string
  initialValue?: string
  confirmLabel?: string
  onCancel: () => void
  onConfirm: (value: string) => void
}

export default function PromptModal({ visible, title, initialValue = '', confirmLabel = 'Valider', onCancel, onConfirm }: Props) {
  const [value, setValue] = useState(initialValue)

  useEffect(() => {
    if (visible) setValue(initialValue)
  }, [visible, initialValue])

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          <TextInput
            style={styles.input}
            value={value}
            onChangeText={setValue}
            autoFocus
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.actions}>
            <Pressable style={styles.cancelButton} onPress={onCancel}>
              <Text style={styles.cancelText}>Annuler</Text>
            </Pressable>
            <Pressable
              style={styles.confirmButton}
              onPress={() => {
                if (value.trim()) onConfirm(value.trim())
              }}
            >
              <Text style={styles.confirmText}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  card: { width: '100%', backgroundColor: colors.elevated, borderRadius: radius.lg, padding: spacing.lg },
  title: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: spacing.md },
  input: {
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: 14
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.lg },
  cancelButton: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  cancelText: { color: colors.textSecondary, fontSize: 14 },
  confirmButton: { backgroundColor: colors.accent, borderRadius: radius.full, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  confirmText: { color: '#000', fontWeight: '700', fontSize: 14 }
})
