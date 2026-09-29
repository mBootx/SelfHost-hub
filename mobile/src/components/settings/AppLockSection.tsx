import { useEffect, useState } from 'react'
import { View, Text, Switch, Pressable, StyleSheet } from 'react-native'
import { SectionTitle } from '@/components/Screen'
import LockSetupModal, { LockSetupStep } from '@/components/lock/LockSetupModal'
import { authenticateWithFingerprint, fingerprintAvailable, LockMethod } from '@/services/appLock'
import { LOCK_DELAYS, useAppLockStore } from '@/store/appLockStore'
import { useToastStore } from '@/store/toastStore'
import { colors, radius, spacing } from '@/constants/theme'

const METHODS: { method: LockMethod; label: string }[] = [
  { method: 'none', label: 'Désactivé' },
  { method: 'pin', label: 'Code' },
  { method: 'pattern', label: 'Schéma' }
]

/** What to do once the current code has been checked. */
type AfterVerify = { kind: 'disable' } | { kind: 'create'; method: 'pin' | 'pattern' }

export default function AppLockSection() {
  const config = useAppLockStore((s) => s.config)
  const disable = useAppLockStore((s) => s.disable)
  const setFingerprint = useAppLockStore((s) => s.setFingerprint)
  const setDelay = useAppLockStore((s) => s.setDelay)
  const showToast = useToastStore((s) => s.show)

  const [step, setStep] = useState<LockSetupStep | null>(null)
  const [afterVerify, setAfterVerify] = useState<AfterVerify | null>(null)
  const [hasFingerprint, setHasFingerprint] = useState(false)

  useEffect(() => {
    fingerprintAvailable().then(setHasFingerprint)
  }, [config.method])

  const enabled = config.method !== 'none'

  function start(action: AfterVerify): void {
    // Changing an existing lock needs its current code first.
    if (enabled) {
      setAfterVerify(action)
      setStep({ kind: 'verify' })
    } else if (action.kind === 'create') {
      setStep(action)
    }
  }

  function choose(method: LockMethod): void {
    if (method === config.method) return
    start(method === 'none' ? { kind: 'disable' } : { kind: 'create', method })
  }

  async function handleDone(): Promise<void> {
    if (step?.kind === 'verify' && afterVerify) {
      const next = afterVerify
      setAfterVerify(null)
      if (next.kind === 'disable') {
        setStep(null)
        await disable()
        showToast('Verrouillage désactivé')
      } else {
        setStep(next)
      }
      return
    }
    setStep(null)
    showToast(config.method === 'none' ? 'Verrouillage activé' : 'Verrouillage modifié')
  }

  async function toggleFingerprint(on: boolean): Promise<void> {
    // Turning it on asks for the fingerprint once, so it is known to work before the app relies on it.
    if (on && !(await authenticateWithFingerprint('Annuler'))) return
    await setFingerprint(on)
  }

  return (
    <>
      <View style={styles.sectionGap}>
        <SectionTitle>Verrouillage</SectionTitle>
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>Verrouiller l&apos;application</Text>
        <Text style={styles.hint}>Demande un code ou un schéma à l&apos;ouverture. La musique continue pendant ce temps.</Text>
        <View style={styles.chips}>
          {METHODS.map(({ method, label }) => {
            const selected = config.method === method
            return (
              <Pressable
                key={method}
                style={[styles.chip, selected && styles.chipSelected]}
                onPress={() => choose(method)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
              </Pressable>
            )
          })}
        </View>

        {enabled && (
          <>
            <Pressable
              style={({ pressed }) => [styles.pillButton, pressed && styles.pressed]}
              onPress={() => start({ kind: 'create', method: config.method as 'pin' | 'pattern' })}
              accessibilityRole="button"
            >
              <Text style={styles.pillText}>{config.method === 'pin' ? 'Modifier le code' : 'Modifier le schéma'}</Text>
            </Pressable>

            <View style={styles.divider} />
            <View style={styles.toggleRow}>
              <View style={styles.toggleText}>
                <Text style={styles.label}>Empreinte digitale</Text>
                <Text style={styles.hint}>
                  {hasFingerprint
                    ? 'Déverrouille avec le capteur d\'empreinte. La reconnaissance faciale n\'est jamais utilisée.'
                    : 'Aucune empreinte enregistrée sur ce téléphone.'}
                </Text>
              </View>
              <Switch
                value={config.fingerprint && hasFingerprint}
                onValueChange={toggleFingerprint}
                disabled={!hasFingerprint}
                trackColor={{ false: colors.hover, true: colors.accent }}
                thumbColor="#ffffff"
                accessibilityLabel="Déverrouiller avec l'empreinte digitale"
              />
            </View>

            <View style={styles.divider} />
            <Text style={styles.label}>Verrouiller après</Text>
            <View style={styles.chips}>
              {LOCK_DELAYS.map(({ label, ms }) => {
                const selected = config.delayMs === ms
                return (
                  <Pressable
                    key={ms}
                    style={[styles.chip, selected && styles.chipSelected]}
                    onPress={() => setDelay(ms)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                  >
                    <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
                  </Pressable>
                )
              })}
            </View>
            <Text style={styles.hint}>
              Code oublié : le mot de passe Navidrome ou FileBrowser enregistré sur ce téléphone permet de désactiver le
              verrouillage.
            </Text>
          </>
        )}
      </View>

      <LockSetupModal
        step={step}
        onDone={handleDone}
        onCancel={() => {
          setStep(null)
          setAfterVerify(null)
        }}
      />
    </>
  )
}

const styles = StyleSheet.create({
  sectionGap: { marginTop: spacing.lg },
  card: { backgroundColor: colors.elevated, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  label: { color: colors.text, fontSize: 14, fontWeight: '600' },
  hint: { color: colors.textMuted, fontSize: 12, marginTop: 3, lineHeight: 17 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginVertical: spacing.md },
  chip: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.full, backgroundColor: colors.hover },
  chipSelected: { backgroundColor: colors.accent },
  chipText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  chipTextSelected: { color: '#000' },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  toggleText: { flex: 1 },
  pillButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border
  },
  pillText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  pressed: { opacity: 0.6 }
})
