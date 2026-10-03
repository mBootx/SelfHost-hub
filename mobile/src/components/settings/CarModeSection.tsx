import { useEffect } from 'react'
import { Linking, Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import Slider from '@react-native-community/slider'
import { SectionTitle } from '@/components/Screen'
import CarModeToggle from '@/components/carmode/CarModeToggle'
import { GESTURE_INFO } from '@/components/carmode/GestureIndicator'
import { GESTURES } from '@/services/gestureRecognizer'
import { CameraPermission, CarOrientation, NORMAL_FPS, SAVER_FPS, useCarModeStore } from '@/store/carModeStore'
import { colors, radius, spacing } from '@/constants/theme'

const PERMISSION_TEXT: Record<CameraPermission, string> = {
  granted: 'Autorisée',
  denied: 'Refusée',
  blocked: 'Refusée (à changer dans les réglages du téléphone)',
  unknown: 'Pas encore demandée',
  unavailable: "Indisponible dans cette version de l'application"
}

const ORIENTATIONS: { id: CarOrientation; label: string }[] = [
  { id: 'auto', label: 'Automatique' },
  { id: 'portrait', label: 'Portrait' },
  { id: 'landscape', label: 'Paysage' }
]

function ToggleRow({ title, hint, value, onChange }: { title: string; hint?: string; value: boolean; onChange: (on: boolean) => void }) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleText}>
        <Text style={styles.label}>{title}</Text>
        {hint && <Text style={styles.hint}>{hint}</Text>}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ false: colors.hover, true: colors.accent }} thumbColor="#ffffff" accessibilityLabel={title} />
    </View>
  )
}

/** Réglages → Mode voiture: the way in, the camera permission, how sensitive the gestures are, which ones are on. */
export default function CarModeSection() {
  const permission = useCarModeStore((s) => s.permission)
  const sensitivity = useCarModeStore((s) => s.sensitivity)
  const thresholds = useCarModeStore((s) => s.gestureThresholds)
  const gestures = useCarModeStore((s) => s.gestures)
  const testMode = useCarModeStore((s) => s.testMode)
  const batterySaver = useCarModeStore((s) => s.batterySaver)
  const orientation = useCarModeStore((s) => s.orientation)
  const haptics = useCarModeStore((s) => s.haptics)
  const sunBoost = useCarModeStore((s) => s.sunBoost)
  const refreshPermission = useCarModeStore((s) => s.refreshPermission)
  const requestPermission = useCarModeStore((s) => s.requestPermission)
  const setSensitivity = useCarModeStore((s) => s.setSensitivity)
  const setGestureEnabled = useCarModeStore((s) => s.setGestureEnabled)
  const setTestMode = useCarModeStore((s) => s.setTestMode)
  const setBatterySaver = useCarModeStore((s) => s.setBatterySaver)
  const setOrientation = useCarModeStore((s) => s.setOrientation)
  const setHaptics = useCarModeStore((s) => s.setHaptics)
  const setSunBoost = useCarModeStore((s) => s.setSunBoost)

  useEffect(() => {
    refreshPermission()
  }, [refreshPermission])

  const permissionAction =
    permission === 'blocked'
      ? { label: 'Réglages', run: () => Linking.openSettings() }
      : permission === 'denied' || permission === 'unknown'
        ? { label: 'Autoriser', run: () => requestPermission() }
        : null

  return (
    <>
      <View style={styles.sectionGap}>
        <SectionTitle>Mode voiture</SectionTitle>
      </View>
      <CarModeToggle />
      <View style={styles.card}>
        <View style={styles.labelRow}>
          <View style={styles.toggleText}>
            <Text style={styles.label}>Caméra</Text>
            <Text style={styles.hint}>{PERMISSION_TEXT[permission]}</Text>
          </View>
          {permissionAction && (
            <Pressable
              onPress={permissionAction.run}
              style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`${permissionAction.label} la caméra`}
            >
              <Text style={styles.pillText}>{permissionAction.label}</Text>
            </Pressable>
          )}
        </View>
        <Text style={styles.hint}>
          Les gestes sont reconnus sur le téléphone, par la caméra frontale, seulement pendant que le mode voiture est à l&apos;écran. Aucune image n&apos;est enregistrée ni envoyée.
        </Text>

        <View style={styles.divider} />
        <View style={styles.labelRow}>
          <Text style={styles.label}>Sensibilité des gestes</Text>
          <Text style={styles.value}>{Math.round(sensitivity * 100)} %</Text>
        </View>
        <Slider
          value={sensitivity}
          minimumValue={0}
          maximumValue={1}
          step={0.05}
          onSlidingComplete={setSensitivity}
          minimumTrackTintColor={colors.accent}
          maximumTrackTintColor={colors.hover}
          thumbTintColor="#ffffff"
          accessibilityLabel="Sensibilité des gestes"
        />
        <View style={styles.labelRow}>
          <Text style={styles.hint}>Stricte</Text>
          <Text style={styles.hint}>Souple</Text>
        </View>
        <Text style={styles.hint}>
          Pince sous {Math.round(thresholds.pinchDistance * 100)} % de la main, vague sur {Math.round(thresholds.swipeMinDistance * 100)} % de l&apos;image, main vue dans{' '}
          {Math.round(thresholds.swipeConfidenceThreshold * 100)} % des images.
        </Text>

        <View style={styles.divider} />
        <Text style={styles.label}>Gestes</Text>
        {GESTURES.map((g) => (
          <ToggleRow key={g} title={GESTURE_INFO[g].action} hint={GESTURE_INFO[g].how} value={gestures[g]} onChange={(on) => setGestureEnabled(g, on)} />
        ))}

        <View style={styles.divider} />
        <Text style={styles.label}>Orientation</Text>
        <View style={styles.chips}>
          {ORIENTATIONS.map((o) => {
            const selected = orientation === o.id
            return (
              <Pressable
                key={o.id}
                onPress={() => setOrientation(o.id)}
                style={[styles.chip, selected && styles.chipSelected]}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`Orientation : ${o.label}`}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{o.label}</Text>
              </Pressable>
            )
          })}
        </View>

        <View style={styles.divider} />
        <ToggleRow title="Vibration à chaque geste" value={haptics} onChange={setHaptics} />
        <ToggleRow title="Plein soleil" hint="Luminosité au maximum quand le capteur de lumière voit le soleil." value={sunBoost} onChange={setSunBoost} />
        <ToggleRow
          title="Économie de batterie"
          hint={`${SAVER_FPS} images par seconde au lieu de ${NORMAL_FPS} : un peu moins réactif.`}
          value={batterySaver}
          onChange={setBatterySaver}
        />
        <ToggleRow title="Mode test" hint="Montre la caméra, les points de la main et la vitesse d'analyse." value={testMode} onChange={setTestMode} />
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  sectionGap: { marginTop: spacing.lg },
  card: { backgroundColor: colors.elevated, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, gap: spacing.xs },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  label: { color: colors.text, fontSize: 14, fontWeight: '600' },
  value: { color: colors.textSecondary, fontSize: 12 },
  hint: { color: colors.textMuted, fontSize: 12, marginTop: 3 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 4 },
  toggleText: { flex: 1 },
  pill: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.full, backgroundColor: colors.accent },
  pillText: { color: '#000', fontSize: 12, fontWeight: '700' },
  pressed: { opacity: 0.6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  chip: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.full, backgroundColor: colors.hover },
  chipSelected: { backgroundColor: colors.accent },
  chipText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  chipTextSelected: { color: '#000' }
})
