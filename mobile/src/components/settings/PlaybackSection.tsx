import { useMemo } from 'react'
import { View, Text, Switch, Pressable, StyleSheet } from 'react-native'
import Slider from '@react-native-community/slider'
import { SectionTitle } from '@/components/Screen'
import { CROSSFADE_MAX_S, EQ_PRESETS, useAudioSettingsStore } from '@/store/audioSettingsStore'
import { colors, radius, spacing } from '@/constants/theme'

function formatFrequency(hz: number): string {
  return hz >= 1000 ? `${Math.round(hz / 100) / 10} kHz` : `${Math.round(hz)} Hz`
}

function ToggleRow({ title, hint, value, onChange }: { title: string; hint?: string; value: boolean; onChange: (on: boolean) => void }) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleText}>
        <Text style={styles.label}>{title}</Text>
        {hint && <Text style={styles.hint}>{hint}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.hover, true: colors.accent }}
        thumbColor="#ffffff"
        accessibilityLabel={title}
      />
    </View>
  )
}

export default function PlaybackSection() {
  const crossfadeSeconds = useAudioSettingsStore((s) => s.crossfadeSeconds)
  const gapless = useAudioSettingsStore((s) => s.gapless)
  const eqEnabled = useAudioSettingsStore((s) => s.eqEnabled)
  const eqPreset = useAudioSettingsStore((s) => s.eqPreset)
  const eqCustomGains = useAudioSettingsStore((s) => s.eqCustomGains)
  const eqBands = useAudioSettingsStore((s) => s.eqBands)
  const setCrossfade = useAudioSettingsStore((s) => s.setCrossfade)
  const setGapless = useAudioSettingsStore((s) => s.setGapless)
  const setEqEnabled = useAudioSettingsStore((s) => s.setEqEnabled)
  const applyEqPreset = useAudioSettingsStore((s) => s.applyEqPreset)
  const setEqBand = useAudioSettingsStore((s) => s.setEqBand)
  // Derived here rather than in a selector: a selector returning a fresh array every call re-renders forever.
  const gains = useMemo(() => useAudioSettingsStore.getState().deviceGains(), [eqBands, eqPreset, eqCustomGains])

  return (
    <>
      <View style={styles.sectionGap}>
        <SectionTitle>Lecture</SectionTitle>
      </View>
      <View style={styles.card}>
        <View style={styles.labelRow}>
          <Text style={styles.label}>Fondu enchaine</Text>
          <Text style={styles.value}>{crossfadeSeconds === 0 ? 'Desactive' : `${crossfadeSeconds} s`}</Text>
        </View>
        <Slider
          value={crossfadeSeconds}
          minimumValue={0}
          maximumValue={CROSSFADE_MAX_S}
          step={1}
          onValueChange={setCrossfade}
          minimumTrackTintColor={colors.accent}
          maximumTrackTintColor={colors.hover}
          thumbTintColor="#ffffff"
          accessibilityLabel="Duree du fondu enchaine"
        />
        <Text style={styles.hint}>
          Quand un titre se termine, le suivant commence en fondu par-dessus. Les changements manuels restent instantanes.
        </Text>
        <View style={styles.divider} />
        <ToggleRow
          title="Lecture sans blanc"
          hint="Precharge le titre suivant pour l'enchainer sans silence quand le fondu est desactive."
          value={gapless}
          onChange={setGapless}
        />
      </View>

      <View style={styles.sectionGap}>
        <SectionTitle>Egaliseur</SectionTitle>
      </View>
      <View style={styles.card}>
        {eqBands ? (
          <>
            <ToggleRow title="Activer l'egaliseur" value={eqEnabled} onChange={setEqEnabled} />
            <View style={styles.presets}>
              {EQ_PRESETS.map((preset) => {
                const selected = eqEnabled && eqPreset === preset.id
                return (
                  <Pressable key={preset.id} onPress={() => applyEqPreset(preset.id)} style={[styles.chip, selected && styles.chipSelected]}>
                    <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{preset.label}</Text>
                  </Pressable>
                )
              })}
              {eqPreset === 'custom' && (
                <View style={[styles.chip, eqEnabled && styles.chipSelected]}>
                  <Text style={[styles.chipText, eqEnabled && styles.chipTextSelected]}>Personnalise</Text>
                </View>
              )}
            </View>
            <View style={!eqEnabled && styles.dimmed}>
              {eqBands.frequencies.map((frequency, i) => (
                <View key={frequency} style={styles.band}>
                  <Text style={styles.bandLabel}>{formatFrequency(frequency)}</Text>
                  <Slider
                    style={styles.bandSlider}
                    value={gains[i] ?? 0}
                    minimumValue={eqBands.minDb}
                    maximumValue={eqBands.maxDb}
                    step={1}
                    onValueChange={(db) => setEqBand(i, db)}
                    minimumTrackTintColor={colors.accent}
                    maximumTrackTintColor={colors.hover}
                    thumbTintColor="#ffffff"
                    accessibilityLabel={formatFrequency(frequency)}
                  />
                  <Text style={styles.bandValue}>
                    {(gains[i] ?? 0) > 0 ? '+' : ''}
                    {Math.round(gains[i] ?? 0)} dB
                  </Text>
                </View>
              ))}
            </View>
          </>
        ) : (
          <Text style={styles.hint}>L'egaliseur du systeme n'est pas disponible sur cet appareil.</Text>
        )}
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  sectionGap: { marginTop: spacing.lg },
  card: { backgroundColor: colors.elevated, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { color: colors.text, fontSize: 14, fontWeight: '600' },
  value: { color: colors.textSecondary, fontSize: 12 },
  hint: { color: colors.textMuted, fontSize: 12, marginTop: 3 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  toggleText: { flex: 1 },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginVertical: spacing.md },
  chip: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.full, backgroundColor: colors.hover },
  chipSelected: { backgroundColor: colors.accent },
  chipText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  chipTextSelected: { color: '#000' },
  dimmed: { opacity: 0.5 },
  band: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  bandLabel: { width: 58, color: colors.textSecondary, fontSize: 12 },
  bandSlider: { flex: 1, height: 36 },
  bandValue: { width: 48, color: colors.textSecondary, fontSize: 12, textAlign: 'right' }
})
