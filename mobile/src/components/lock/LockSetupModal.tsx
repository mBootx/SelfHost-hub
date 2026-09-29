import { useEffect, useState } from 'react'
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import PinPad, { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '@/components/lock/PinPad'
import PatternPad, { PATTERN_MIN_DOTS } from '@/components/lock/PatternPad'
import { encodePattern } from '@/services/appLock'
import { useAppLockStore } from '@/store/appLockStore'
import { colors, spacing } from '@/constants/theme'

/** 'verify': prove the current code before changing the lock. 'create': choose a new one, twice. */
export type LockSetupStep = { kind: 'verify' } | { kind: 'create'; method: 'pin' | 'pattern' }

interface Props {
  step: LockSetupStep | null
  /** The current code was right ('verify'), or the new one is saved ('create'). */
  onDone: () => void
  onCancel: () => void
}

function formatWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')}`
}

export default function LockSetupModal({ step, onDone, onCancel }: Props) {
  const insets = useSafeAreaInsets()
  const config = useAppLockStore((s) => s.config)
  const lockoutUntil = useAppLockStore((s) => s.lockoutUntil)
  const check = useAppLockStore((s) => s.check)
  const setSecret = useAppLockStore((s) => s.setSecret)

  /** The first entry while choosing a new code, waiting for its confirmation. */
  const [first, setFirst] = useState<string | number[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [errorKey, setErrorKey] = useState(0)
  /** Remounts the pad between the two entries, so the second one starts blank. */
  const [round, setRound] = useState(0)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    setFirst(null)
    setMessage(null)
    setRound((r) => r + 1)
  }, [step])

  useEffect(() => {
    setNow(Date.now())
    if (lockoutUntil <= Date.now()) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [lockoutUntil])

  if (!step) return null
  const current = step

  const method = current.kind === 'create' ? current.method : config.method
  const isPin = method === 'pin'
  const lockedOut = current.kind === 'verify' && lockoutUntil > now

  function fail(text: string): void {
    setMessage(text)
    setErrorKey((k) => k + 1)
  }

  async function submit(secret: string | number[]): Promise<void> {
    if (Array.isArray(secret) && secret.length < PATTERN_MIN_DOTS) {
      fail(`Reliez au moins ${PATTERN_MIN_DOTS} points`)
      return
    }
    if (current.kind === 'verify') {
      const result = await check(secret)
      if (result === 'ok') onDone()
      else fail(result === 'locked-out' ? '' : isPin ? 'Code incorrect' : 'Schéma incorrect')
      return
    }
    if (first === null) {
      setFirst(secret)
      setMessage(null)
      setRound((r) => r + 1)
      return
    }
    const same = Array.isArray(secret) ? encodePattern(secret) === encodePattern(first as number[]) : secret === first
    if (!same) {
      setFirst(null)
      setRound((r) => r + 1)
      setMessage(isPin ? 'Les deux codes ne correspondent pas. Recommencez.' : 'Les deux schémas ne correspondent pas. Recommencez.')
      return
    }
    await setSecret(current.method, secret)
    onDone()
  }

  let title: string
  let subtitle: string
  if (current.kind === 'verify') {
    title = isPin ? 'Code actuel' : 'Schéma actuel'
    subtitle = isPin ? 'Saisissez votre code pour continuer.' : 'Dessinez votre schéma pour continuer.'
  } else if (first === null) {
    title = isPin ? 'Choisissez un code' : 'Dessinez un schéma'
    subtitle = isPin
      ? `De ${PIN_MIN_LENGTH} à ${PIN_MAX_LENGTH} chiffres, puis validez.`
      : `Reliez au moins ${PATTERN_MIN_DOTS} points sans lever le doigt.`
  } else {
    title = isPin ? 'Confirmez le code' : 'Confirmez le schéma'
    subtitle = isPin ? 'Saisissez-le une seconde fois.' : 'Dessinez-le une seconde fois.'
  }
  const feedback = lockedOut ? `Trop d'essais. Réessayez dans ${formatWait(lockoutUntil - now)}` : message

  return (
    <Modal visible animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={onCancel}>
      <View style={[styles.screen, { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.lg }]}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {feedback || ' '}
          </Text>
        </View>

        <View style={styles.pad}>
          {isPin ? (
            <PinPad
              key={round}
              length={current.kind === 'verify' ? config.pinLength : first !== null ? (first as string).length : undefined}
              onSubmit={submit}
              disabled={lockedOut}
              errorKey={errorKey}
            />
          ) : (
            <PatternPad key={round} onComplete={submit} disabled={lockedOut} errorKey={errorKey} />
          )}
        </View>

        <Pressable onPress={onCancel} hitSlop={12} accessibilityRole="button">
          <Text style={styles.cancel}>Annuler</Text>
        </Pressable>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.base, alignItems: 'center', justifyContent: 'space-between' },
  header: { alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.xl },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  subtitle: { color: colors.textSecondary, fontSize: 14, textAlign: 'center' },
  error: { color: colors.danger, fontSize: 13, textAlign: 'center', minHeight: 18 },
  pad: { alignItems: 'center' },
  cancel: { color: colors.textSecondary, fontSize: 15, fontWeight: '600', paddingVertical: spacing.sm }
})
