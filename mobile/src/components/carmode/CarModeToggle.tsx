import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Car, ChevronRight } from 'lucide-react-native'
import { useCarModeStore } from '@/store/carModeStore'
import { colors, radius, spacing } from '@/constants/theme'

/**
 * Opens the car mode. The first time, Android is asked for the camera (the gestures need it); whatever the answer, the
 * car mode opens: without the camera it keeps its big buttons, and says how to allow it.
 */
export async function openCarMode(push: (path: '/car-mode') => void): Promise<void> {
  const store = useCarModeStore.getState()
  const permission = await store.refreshPermission()
  if (permission === 'unknown') await store.requestPermission()
  push('/car-mode')
}

/** The settings' way into the car mode. */
export default function CarModeToggle() {
  const router = useRouter()
  const isOpen = useCarModeStore((s) => s.isCarModeEnabled)
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={() => openCarMode((path) => router.push(path))}
      disabled={isOpen}
      accessibilityRole="button"
      accessibilityLabel="Démarrer le mode voiture"
    >
      <View style={styles.icon}>
        <Car size={22} color="#000" />
      </View>
      <View style={styles.text}>
        <Text style={styles.title}>Démarrer le mode voiture</Text>
        <Text style={styles.meta}>Plein écran, gros boutons, gestes de la main devant la caméra</Text>
      </View>
      <ChevronRight size={18} color={colors.textMuted} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.elevated, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  pressed: { opacity: 0.6 },
  icon: { width: 40, height: 40, borderRadius: radius.full, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 14, fontWeight: '600' },
  meta: { color: colors.textSecondary, fontSize: 12, marginTop: 3 }
})
