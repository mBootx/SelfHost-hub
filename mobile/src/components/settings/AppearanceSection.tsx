import { useState } from 'react'
import { View, Text, Pressable, TextInput, StyleSheet, Alert } from 'react-native'
import { reloadAppAsync } from 'expo'
import { Check } from 'lucide-react-native'
import { SectionTitle } from '@/components/Screen'
import {
  ACCENT_PRESETS,
  BACKGROUNDS,
  BackgroundId,
  DEFAULT_APPEARANCE,
  appearance,
  readableAccent,
  saveAppearance,
  colors,
  radius,
  spacing
} from '@/constants/theme'

const HEX = /^#[0-9a-f]{6}$/i

export default function AppearanceSection() {
  const [accent, setAccent] = useState(appearance.accent)
  const [background, setBackground] = useState<BackgroundId>(appearance.background)
  const isPreset = ACCENT_PRESETS.some((p) => p.hex.toLowerCase() === accent.toLowerCase())
  const [hexDraft, setHexDraft] = useState(isPreset ? '' : accent)
  const changed = accent.toLowerCase() !== appearance.accent.toLowerCase() || background !== appearance.background

  function applyTheme(): void {
    Alert.alert('Appliquer le theme', "L'application va redemarrer pour appliquer les couleurs ; la lecture en cours s'arretera.", [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Redemarrer',
        onPress: () => {
          saveAppearance({ accent, background })
          reloadAppAsync('Theme change').catch(() =>
            Alert.alert('Theme enregistre', "Fermez puis rouvrez l'application pour l'appliquer.")
          )
        }
      }
    ])
  }

  return (
    <>
      <View style={styles.sectionGap}>
        <SectionTitle>Apparence</SectionTitle>
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>Couleur d'accent</Text>
        <View style={styles.swatches}>
          {ACCENT_PRESETS.map((preset) => {
            const selected = preset.hex.toLowerCase() === accent.toLowerCase()
            return (
              <Pressable
                key={preset.hex}
                onPress={() => {
                  setAccent(preset.hex)
                  setHexDraft('')
                }}
                style={[styles.swatch, { backgroundColor: preset.hex }, selected && styles.swatchSelected]}
                accessibilityRole="button"
                accessibilityLabel={preset.label}
                accessibilityState={{ selected }}
              >
                {selected && <Check size={16} color="#000" />}
              </Pressable>
            )
          })}
        </View>
        <View style={styles.customRow}>
          <View style={[styles.preview, { backgroundColor: readableAccent(accent) }]} />
          <TextInput
            value={hexDraft}
            onChangeText={(text) => {
              const value = text.startsWith('#') ? text : `#${text}`
              setHexDraft(value)
              if (HEX.test(value)) setAccent(value)
            }}
            placeholder="Couleur perso : #RRGGBB"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={7}
            style={styles.input}
          />
        </View>

        <Text style={[styles.label, styles.labelSpaced]}>Fond</Text>
        <View style={styles.backgrounds}>
          {(Object.keys(BACKGROUNDS) as BackgroundId[]).map((id) => {
            const surfaces = BACKGROUNDS[id]
            const selected = id === background
            return (
              <Pressable
                key={id}
                onPress={() => setBackground(id)}
                style={[styles.background, selected && { borderColor: colors.accent }]}
                accessibilityRole="button"
                accessibilityState={{ selected }}
              >
                <View style={styles.stripes}>
                  <View style={[styles.stripe, { backgroundColor: surfaces.base }]} />
                  <View style={[styles.stripe, { backgroundColor: surfaces.elevated }]} />
                  <View style={[styles.stripe, { backgroundColor: surfaces.hover }]} />
                </View>
                <Text style={styles.backgroundLabel}>{surfaces.label}</Text>
              </Pressable>
            )
          })}
        </View>

        <View style={styles.actions}>
          <Pressable
            onPress={() => {
              setAccent(DEFAULT_APPEARANCE.accent)
              setBackground(DEFAULT_APPEARANCE.background)
              setHexDraft('')
            }}
            hitSlop={8}
          >
            <Text style={styles.reset}>Theme d'origine</Text>
          </Pressable>
          <Pressable
            onPress={applyTheme}
            disabled={!changed}
            style={({ pressed }) => [styles.apply, !changed && styles.applyDisabled, pressed && styles.pressed]}
          >
            <Text style={styles.applyText}>Appliquer</Text>
          </Pressable>
        </View>
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  sectionGap: { marginTop: spacing.lg },
  card: { backgroundColor: colors.elevated, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  label: { color: colors.text, fontSize: 14, fontWeight: '600', marginBottom: spacing.sm },
  labelSpaced: { marginTop: spacing.lg },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  swatch: { width: 34, height: 34, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
  swatchSelected: { borderWidth: 2, borderColor: '#fff' },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  preview: { width: 34, height: 34, borderRadius: radius.full },
  input: {
    flex: 1,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: 14
  },
  backgrounds: { flexDirection: 'row', gap: spacing.sm },
  background: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.xs },
  stripes: { flexDirection: 'row', height: 32, borderRadius: 4, overflow: 'hidden', marginBottom: spacing.xs },
  stripe: { flex: 1 },
  backgroundLabel: { color: colors.textSecondary, fontSize: 11, textAlign: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.lg },
  reset: { color: colors.textSecondary, fontSize: 13 },
  apply: { backgroundColor: colors.accent, borderRadius: radius.full, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  applyDisabled: { opacity: 0.4 },
  applyText: { color: '#000', fontWeight: '700', fontSize: 13 },
  pressed: { opacity: 0.7 }
})
