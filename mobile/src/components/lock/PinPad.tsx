import { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, Animated, Vibration, StyleSheet } from 'react-native'
import { Check, Delete, FingerprintPattern } from 'lucide-react-native'
import { colors, radius, spacing } from '@/constants/theme'

export const PIN_MIN_LENGTH = 4
export const PIN_MAX_LENGTH = 8

interface Props {
  /** Length of the saved PIN: it is checked as soon as the last digit is in. Leave unset to choose a new one (✓ key). */
  length?: number
  onSubmit: (pin: string) => void
  /** Shows a fingerprint key in the bottom-left corner. */
  onFingerprint?: () => void
  disabled?: boolean
  /** Bumped by the parent after a wrong PIN: clears the entry and shakes the dots. */
  errorKey?: number
}

const ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9']
]

export default function PinPad({ length, onSubmit, onFingerprint, disabled = false, errorKey = 0 }: Props) {
  const [pin, setPin] = useState('')
  const [waiting, setWaiting] = useState(false)
  const shake = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (errorKey === 0) return
    setPin('')
    setWaiting(false)
    Vibration.vibrate(120)
    Animated.sequence(
      [12, -12, 8, -8, 0].map((toValue) => Animated.timing(shake, { toValue, duration: 50, useNativeDriver: true }))
    ).start()
  }, [errorKey])

  // A pause after too many wrong PINs drops whatever was typed.
  useEffect(() => {
    if (!disabled) return
    setPin('')
    setWaiting(false)
  }, [disabled])

  function submit(value: string): void {
    setWaiting(true)
    // Lets the last dot show before hashing briefly holds the JS thread.
    setTimeout(() => onSubmit(value), 60)
  }

  function press(digit: string): void {
    if (disabled || waiting) return
    const max = length ?? PIN_MAX_LENGTH
    if (pin.length >= max) return
    const next = pin + digit
    setPin(next)
    if (length && next.length === length) submit(next)
  }

  function erase(): void {
    if (disabled || waiting) return
    setPin((p) => p.slice(0, -1))
  }

  const dotCount = length ?? Math.max(PIN_MIN_LENGTH, pin.length)
  const canConfirm = !length && pin.length >= PIN_MIN_LENGTH

  let corner: React.ReactNode = <View style={styles.key} />
  if (onFingerprint) {
    corner = (
      <Pressable
        style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
        onPress={onFingerprint}
        disabled={waiting}
        accessibilityRole="button"
        accessibilityLabel="Utiliser l'empreinte digitale"
      >
        <FingerprintPattern size={28} color={colors.accent} />
      </Pressable>
    )
  } else if (!length) {
    corner = (
      <Pressable
        style={({ pressed }) => [styles.key, canConfirm && styles.confirmKey, pressed && styles.keyPressed]}
        onPress={() => canConfirm && !waiting && submit(pin)}
        disabled={!canConfirm || disabled}
        accessibilityRole="button"
        accessibilityLabel="Valider le code"
      >
        <Check size={28} color={canConfirm ? '#000' : colors.textMuted} />
      </Pressable>
    )
  }

  return (
    <View style={[styles.container, disabled && styles.disabled]}>
      <Animated.View style={[styles.dots, { transform: [{ translateX: shake }] }]} accessibilityLabel={`${pin.length} chiffres saisis`}>
        {Array.from({ length: dotCount }, (_, i) => (
          <View key={i} style={[styles.dot, i < pin.length && styles.dotFilled]} />
        ))}
      </Animated.View>

      {ROWS.map((row) => (
        <View key={row[0]} style={styles.row}>
          {row.map((digit) => (
            <Pressable
              key={digit}
              style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
              onPress={() => press(digit)}
              accessibilityRole="button"
              accessibilityLabel={digit}
            >
              <Text style={styles.digit}>{digit}</Text>
            </Pressable>
          ))}
        </View>
      ))}
      <View style={styles.row}>
        {corner}
        <Pressable
          style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          onPress={() => press('0')}
          accessibilityRole="button"
          accessibilityLabel="0"
        >
          <Text style={styles.digit}>0</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
          onPress={erase}
          onLongPress={() => !disabled && !waiting && setPin('')}
          accessibilityRole="button"
          accessibilityLabel="Effacer"
        >
          <Delete size={26} color={colors.textSecondary} />
        </Pressable>
      </View>
    </View>
  )
}

const KEY_SIZE = 76

const styles = StyleSheet.create({
  container: { alignItems: 'center', gap: spacing.md },
  disabled: { opacity: 0.4 },
  dots: { flexDirection: 'row', gap: spacing.md, height: 20, alignItems: 'center', marginBottom: spacing.lg },
  dot: { width: 14, height: 14, borderRadius: radius.full, borderWidth: 2, borderColor: colors.textSecondary },
  dotFilled: { backgroundColor: colors.accent, borderColor: colors.accent },
  row: { flexDirection: 'row', gap: spacing.xl },
  key: {
    width: KEY_SIZE,
    height: KEY_SIZE,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center'
  },
  keyPressed: { backgroundColor: colors.hover },
  confirmKey: { backgroundColor: colors.accent },
  digit: { color: colors.text, fontSize: 30, fontWeight: '500' }
})
