import { useEffect, useState } from 'react'
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  Image,
  BackHandler,
  KeyboardAvoidingView,
  ActivityIndicator,
  StyleSheet
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { FingerprintPattern } from 'lucide-react-native'
import PinPad from '@/components/lock/PinPad'
import PatternPad, { PATTERN_MIN_DOTS } from '@/components/lock/PatternPad'
import { authenticateWithFingerprint, fingerprintAvailable } from '@/services/appLock'
import { useAppLockStore } from '@/store/appLockStore'
import { useToastStore } from '@/store/toastStore'
import { colors, radius, spacing } from '@/constants/theme'

const ATTEMPTS_PER_PAUSE = 5

function formatWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')}`
}

/** Covers the whole app, above every other window, while it is locked. */
export default function LockScreen() {
  const status = useAppLockStore((s) => s.status)
  const loaded = useAppLockStore((s) => s.loaded)
  const config = useAppLockStore((s) => s.config)
  const failedAttempts = useAppLockStore((s) => s.failedAttempts)
  const lockoutUntil = useAppLockStore((s) => s.lockoutUntil)
  const tryUnlock = useAppLockStore((s) => s.tryUnlock)
  const unlockWithFingerprint = useAppLockStore((s) => s.unlockWithFingerprint)
  const recover = useAppLockStore((s) => s.recover)
  const showToast = useToastStore((s) => s.show)
  const insets = useSafeAreaInsets()

  const [errorKey, setErrorKey] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [mode, setMode] = useState<'code' | 'recover'>('code')
  const [password, setPassword] = useState('')
  const [checking, setChecking] = useState(false)
  const [canUseFingerprint, setCanUseFingerprint] = useState(false)
  const [now, setNow] = useState(Date.now())

  const locked = status === 'locked'
  const lockedOut = lockoutUntil > now
  const isPin = config.method === 'pin'

  // Every new lock starts on the code, with nothing left over from last time.
  useEffect(() => {
    if (!locked) return
    setMode('code')
    setMessage(null)
    setPassword('')
  }, [locked])

  async function promptFingerprint(): Promise<void> {
    if (await authenticateWithFingerprint(isPin ? 'Utiliser le code' : 'Utiliser le schéma')) {
      await unlockWithFingerprint()
    }
  }

  // The fingerprint is offered straight away each time the app locks.
  useEffect(() => {
    if (!locked || !loaded || !config.fingerprint) {
      setCanUseFingerprint(false)
      return
    }
    let cancelled = false
    fingerprintAvailable().then((available) => {
      if (cancelled) return
      setCanUseFingerprint(available)
      if (available) promptFingerprint()
    })
    return () => {
      cancelled = true
    }
  }, [locked, loaded, config.fingerprint])

  // Counts down the pause after too many wrong codes.
  useEffect(() => {
    setNow(Date.now())
    if (!locked || lockoutUntil <= Date.now()) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [locked, lockoutUntil])

  async function submit(secret: string | number[]): Promise<void> {
    if (Array.isArray(secret) && secret.length < PATTERN_MIN_DOTS) {
      setMessage(`Reliez au moins ${PATTERN_MIN_DOTS} points`)
      setErrorKey((k) => k + 1)
      return
    }
    const result = await tryUnlock(secret)
    if (result === 'ok') {
      setMessage(null)
      return
    }
    setErrorKey((k) => k + 1)
    if (result === 'locked-out') {
      setMessage(null)
      return
    }
    const attempts = useAppLockStore.getState().failedAttempts
    const left = ATTEMPTS_PER_PAUSE - (attempts % ATTEMPTS_PER_PAUSE)
    const wrong = isPin ? 'Code incorrect' : 'Schéma incorrect'
    setMessage(left < ATTEMPTS_PER_PAUSE && left <= 2 ? `${wrong} - encore ${left} essai${left > 1 ? 's' : ''} avant une pause` : wrong)
  }

  async function submitRecovery(): Promise<void> {
    setChecking(true)
    const result = await recover(password)
    setChecking(false)
    if (result === 'ok') {
      showToast('Verrouillage désactivé : choisissez un nouveau code dans Réglages')
      return
    }
    setPassword('')
    setMessage(result === 'locked-out' ? null : 'Mot de passe incorrect')
  }

  let prompt: string
  if (lockedOut) prompt = `Trop d'essais. Réessayez dans ${formatWait(lockoutUntil - now)}`
  else if (message) prompt = message
  else if (mode === 'recover') prompt = 'Mot de passe de votre compte Navidrome ou FileBrowser'
  else prompt = isPin ? 'Saisissez votre code' : 'Dessinez votre schéma'
  const promptIsError = lockedOut || !!message

  return (
    <Modal
      visible={locked}
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => BackHandler.exitApp()}
    >
      <KeyboardAvoidingView
        behavior="padding"
        style={[styles.screen, { paddingTop: insets.top + spacing.xxl, paddingBottom: insets.bottom + spacing.lg }]}
      >
        {loaded && (
          <>
            <View style={styles.header}>
              <Image source={require('../../../assets/images/icon.png')} style={styles.logo} />
              <Text style={styles.title}>SelfHost Hub</Text>
              <Text style={[styles.prompt, promptIsError && styles.promptError]} accessibilityLiveRegion="polite">
                {prompt}
              </Text>
            </View>

            {mode === 'code' ? (
              <View style={styles.pad}>
                {isPin ? (
                  <PinPad
                    length={config.pinLength}
                    onSubmit={submit}
                    onFingerprint={canUseFingerprint ? promptFingerprint : undefined}
                    disabled={lockedOut}
                    errorKey={errorKey}
                  />
                ) : (
                  <>
                    <PatternPad onComplete={submit} disabled={lockedOut} errorKey={errorKey} />
                    {canUseFingerprint && (
                      <Pressable
                        style={({ pressed }) => [styles.fingerprintButton, pressed && styles.pressed]}
                        onPress={promptFingerprint}
                        accessibilityRole="button"
                        accessibilityLabel="Utiliser l'empreinte digitale"
                      >
                        <FingerprintPattern size={30} color={colors.accent} />
                      </Pressable>
                    )}
                  </>
                )}
              </View>
            ) : (
              <View style={styles.recovery}>
                <TextInput
                  style={styles.input}
                  value={password}
                  onChangeText={setPassword}
                  onSubmitEditing={submitRecovery}
                  placeholder="Mot de passe"
                  placeholderTextColor={colors.textMuted}
                  secureTextEntry
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!lockedOut}
                  accessibilityLabel="Mot de passe du compte"
                />
                <Pressable
                  style={({ pressed }) => [styles.primaryButton, (pressed || checking || lockedOut) && styles.pressed]}
                  onPress={submitRecovery}
                  disabled={checking || lockedOut || !password}
                  accessibilityRole="button"
                  accessibilityLabel="Déverrouiller"
                >
                  {checking ? <ActivityIndicator color="#000" /> : <Text style={styles.primaryButtonText}>Déverrouiller</Text>}
                </Pressable>
                <Text style={styles.hint}>
                  Le verrouillage sera désactivé : vous pourrez en choisir un nouveau dans Réglages.
                </Text>
              </View>
            )}

            <Pressable
              onPress={() => {
                setMessage(null)
                setMode(mode === 'code' ? 'recover' : 'code')
              }}
              hitSlop={12}
              accessibilityRole="button"
            >
              <Text style={styles.link}>
                {mode === 'code' ? (isPin ? 'Code oublié ?' : 'Schéma oublié ?') : isPin ? 'Revenir au code' : 'Revenir au schéma'}
              </Text>
            </Pressable>
            {failedAttempts > 0 && mode === 'code' && !lockedOut && !message && (
              <Text style={styles.hint}>
                {failedAttempts} essai{failedAttempts > 1 ? 's' : ''} incorrect{failedAttempts > 1 ? 's' : ''}
              </Text>
            )}
          </>
        )}
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.base, alignItems: 'center', justifyContent: 'space-between' },
  header: { alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.xl },
  logo: { width: 64, height: 64, borderRadius: 16 },
  title: { color: colors.text, fontSize: 20, fontWeight: '700' },
  prompt: { color: colors.textSecondary, fontSize: 14, textAlign: 'center', minHeight: 20 },
  promptError: { color: colors.danger },
  pad: { alignItems: 'center', gap: spacing.lg },
  fingerprintButton: {
    width: 64,
    height: 64,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.elevated
  },
  recovery: { alignSelf: 'stretch', paddingHorizontal: spacing.xl, gap: spacing.md },
  input: {
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.text,
    fontSize: 16
  },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center'
  },
  primaryButtonText: { color: '#000', fontWeight: '700', fontSize: 15 },
  link: { color: colors.accent, fontSize: 14, fontWeight: '600', paddingVertical: spacing.sm },
  hint: { color: colors.textMuted, fontSize: 12, textAlign: 'center' },
  pressed: { opacity: 0.6 }
})
