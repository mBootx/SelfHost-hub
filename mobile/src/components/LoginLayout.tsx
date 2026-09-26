import { forwardRef } from 'react'
import {
  View,
  Text,
  TextInput,
  TextInputProps,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  StyleSheet
} from 'react-native'
import { colors, radius, spacing } from '@/constants/theme'

type IconComponent = React.ComponentType<{ size?: number; color?: string }>

interface Props {
  icon: IconComponent
  accent: string
  iconColor?: string
  title: string
  subtitle: string
  error?: string | null
  loading?: boolean
  onSubmit: () => void
  submitLabel?: string
  children: React.ReactNode
}

/**
 * Shared shell for the three service logins. The KeyboardAvoidingView plus a
 * centring ScrollView is what actually lifts the form: `behavior` has to be set
 * explicitly on Android (the default does nothing there) and edge-to-edge mode
 * stops the manifest's adjustResize from doing the work for us.
 */
export default function LoginLayout({
  icon: Icon,
  accent,
  iconColor = '#fff',
  title,
  subtitle,
  error,
  loading,
  onSubmit,
  submitLabel = 'Se connecter',
  children
}: Props) {
  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.card}>
          <View style={[styles.iconWrap, { backgroundColor: accent }]}>
            <Icon size={28} color={iconColor} />
          </View>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>

          {children}

          {!!error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            style={({ pressed }) => [styles.button, { backgroundColor: accent }, (loading || pressed) && styles.buttonDim]}
            onPress={onSubmit}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel={submitLabel}
          >
            {loading ? (
              <ActivityIndicator color={iconColor} />
            ) : (
              <Text style={[styles.buttonText, { color: iconColor }]}>{submitLabel}</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

export const Field = forwardRef<TextInput, { label: string } & TextInputProps>(function Field({ label, ...props }, ref) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        ref={ref}
        style={styles.input}
        placeholderTextColor={colors.textMuted}
        accessibilityLabel={label}
        {...props}
      />
    </View>
  )
})

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.base },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  card: { backgroundColor: colors.elevated, borderRadius: radius.lg, padding: spacing.xl },
  iconWrap: {
    alignSelf: 'center',
    width: 56,
    height: 56,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md
  },
  title: { color: colors.text, fontSize: 20, fontWeight: '700', textAlign: 'center' },
  subtitle: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', marginBottom: spacing.lg },
  field: { marginBottom: spacing.md },
  label: { color: colors.textSecondary, fontSize: 12, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.text,
    fontSize: 15
  },
  error: { color: colors.danger, fontSize: 12, marginBottom: spacing.sm, textAlign: 'center' },
  button: { borderRadius: radius.full, paddingVertical: spacing.md, alignItems: 'center', marginTop: spacing.xs },
  buttonDim: { opacity: 0.6 },
  buttonText: { fontWeight: '700', fontSize: 15 }
})
