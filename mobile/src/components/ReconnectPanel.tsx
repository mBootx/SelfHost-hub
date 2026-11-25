import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { CloudOff } from 'lucide-react-native'
import { colors, radius, spacing } from '@/constants/theme'

interface Props {
  /** "Navidrome", "FileBrowser". */
  service: string
  /** Why the last try failed, as the service said it. */
  error: string | null
  /** Tries the saved login again. */
  onRetry: () => Promise<void>
  /** Shows the login form, to sign in to another server or account. */
  onSwitch: () => void
  /** Opens the screen in offline mode without waiting for the server. */
  onOffline?: () => void
  hint?: string
}

/**
 * A saved login whose server could not be reached (no network, the server asleep): rather than an empty login form,
 * which looked as if the account had been forgotten, this says so and offers to try again. The app also tries again
 * on its own when the network comes back.
 */
export default function ReconnectPanel({ service, error, onRetry, onSwitch, onOffline, hint }: Props) {
  const [retrying, setRetrying] = useState(false)

  async function retry(): Promise<void> {
    setRetrying(true)
    try {
      await onRetry()
    } finally {
      setRetrying(false)
    }
  }

  return (
    <View style={styles.root}>
      <View style={styles.icon}>
        <CloudOff size={28} color={colors.textSecondary} />
      </View>
      <Text style={styles.title}>{service} injoignable</Text>
      <Text style={styles.text}>{error || "Le serveur ne répond pas. Vérifiez qu'il est allumé et que le téléphone est connecté."}</Text>
      {!!hint && <Text style={styles.hint}>{hint}</Text>}
      <Pressable
        style={({ pressed }) => [styles.button, (pressed || retrying) && styles.pressed]}
        onPress={() => void retry()}
        disabled={retrying}
        accessibilityRole="button"
        accessibilityLabel="Réessayer"
      >
        {retrying ? <ActivityIndicator color="#000" /> : <Text style={styles.buttonText}>Réessayer</Text>}
      </Pressable>
      {onOffline && (
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          onPress={onOffline}
          accessibilityRole="button"
          accessibilityLabel="Accéder aux playlists et titres hors ligne"
        >
          <Text style={styles.secondaryButtonText}>Accéder aux playlists hors ligne</Text>
        </Pressable>
      )}
      <Pressable onPress={onSwitch} hitSlop={8} accessibilityRole="button" style={styles.switch}>
        <Text style={styles.switchText}>Se connecter à un autre serveur ou compte</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm, backgroundColor: colors.base },
  icon: {
    width: 64,
    height: 64,
    borderRadius: radius.full,
    backgroundColor: colors.elevated,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  text: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  hint: { color: colors.textMuted, fontSize: 12, textAlign: 'center', lineHeight: 17 },
  button: {
    marginTop: spacing.md,
    minWidth: 160,
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md
  },
  buttonText: { color: '#000', fontWeight: '700', fontSize: 14 },
  secondaryButton: {
    marginTop: spacing.xs,
    minWidth: 160,
    alignItems: 'center',
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.full,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md
  },
  secondaryButtonText: { color: colors.text, fontWeight: '700', fontSize: 13 },
  pressed: { opacity: 0.6 },
  switch: { marginTop: spacing.sm, paddingVertical: spacing.sm },
  switchText: { color: colors.textSecondary, fontSize: 13, textDecorationLine: 'underline' }
})
