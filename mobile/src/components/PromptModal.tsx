import { useEffect, useState } from 'react'
import { Modal, View, Text, TextInput, Pressable, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native'
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated'
import { colors, radius, spacing } from '@/constants/theme'

interface Props {
  visible: boolean
  title: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  onCancel: () => void
  onConfirm: (value: string) => void
}

/** A single line of text asked for in a small card: the field lights up in the accent colour, Valider is greyed until there is something. */
export default function PromptModal({ visible, title, initialValue = '', placeholder, confirmLabel = 'Valider', onCancel, onConfirm }: Props) {
  const [value, setValue] = useState(initialValue)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (visible) setValue(initialValue)
  }, [visible, initialValue])

  const ready = value.trim().length > 0
  const submit = (): void => {
    if (ready) onConfirm(value.trim())
  }

  return (
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent onRequestClose={onCancel}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} style={StyleSheet.absoluteFill}>
          <Pressable style={[StyleSheet.absoluteFill, styles.dim]} onPress={onCancel} accessibilityLabel="Annuler" accessibilityRole="button" />
        </Animated.View>
        <Animated.View entering={ZoomIn.duration(200)} style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          <TextInput
            style={[styles.input, focused && styles.inputFocused]}
            value={value}
            onChangeText={setValue}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onSubmitEditing={submit}
            returnKeyType="done"
            autoFocus
            selectTextOnFocus
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
            selectionColor={colors.accent}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={title}
          />
          <View style={styles.actions}>
            <Pressable style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]} onPress={onCancel} accessibilityRole="button">
              <Text style={styles.cancelText}>Annuler</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.confirmButton, !ready && styles.confirmOff, pressed && ready && styles.pressed]}
              onPress={submit}
              disabled={!ready}
              accessibilityRole="button"
              accessibilityState={{ disabled: !ready }}
            >
              <Text style={[styles.confirmText, !ready && styles.confirmTextOff]}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dim: { backgroundColor: 'rgba(0,0,0,0.62)' },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.elevated,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.xl,
    elevation: 24
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.3, marginBottom: spacing.lg },
  input: {
    backgroundColor: colors.raised,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    color: colors.text,
    fontSize: 16
  },
  inputFocused: { borderColor: colors.accent },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xl },
  cancelButton: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.full },
  cancelText: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
  confirmButton: { backgroundColor: colors.accent, borderRadius: radius.full, paddingHorizontal: spacing.xl, paddingVertical: spacing.md },
  confirmOff: { backgroundColor: colors.hover },
  confirmText: { color: colors.onAccent, fontWeight: '800', fontSize: 14 },
  confirmTextOff: { color: colors.textMuted },
  pressed: { opacity: 0.7 }
})
