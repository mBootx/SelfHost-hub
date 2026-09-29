import * as LocalAuthentication from 'expo-local-authentication'
import { AuthenticationType, SecurityLevel } from 'expo-local-authentication'
import { sha256 } from 'js-sha256'

/**
 * The app lock's building blocks: hashing the PIN or pattern, fingerprint checks, and telling the
 * lock that leaving the app is expected (a file picker, the share sheet), so coming back doesn't lock.
 */

export type LockMethod = 'none' | 'pin' | 'pattern'

/**
 * Hashing rounds: makes guessing slower if the stored hash ever leaked (it sits in Android's encrypted
 * store already). Hermes has no JIT, so this stays low enough for an instant unlock.
 */
const ROUNDS = 2000
/** A hand-off to a system screen only skips the lock if the user is back within this time. */
const EXTERNAL_MAX_MS = 3 * 60 * 1000

let expectingExternalUntil = 0

export function randomSalt(): string {
  let salt = ''
  for (let i = 0; i < 32; i++) salt += Math.floor(Math.random() * 16).toString(16)
  return `${salt}${Date.now().toString(16)}`
}

export function hashSecret(secret: string, salt: string): string {
  let hash = sha256(`${salt}:${secret}`)
  for (let i = 1; i < ROUNDS; i++) hash = sha256(`${hash}${salt}`)
  return hash
}

/** Pattern dots are numbered 0-8, left to right and top to bottom. */
export function encodePattern(dots: number[]): string {
  return dots.join('-')
}

/**
 * Call right before opening a system screen (file picker, share sheet, another app to view a file, a
 * permission dialog): the round trip it causes doesn't lock the app, as long as the user is back soon.
 */
export function expectExternalScreen(): void {
  expectingExternalUntil = Date.now() + 5000
}

/**
 * Consumes the hand-off flag when the app goes to the background: true if this trip was expected.
 * The flag only lasts a few seconds, so a stale one can't excuse a later, real departure.
 */
export function takeExpectedExternal(): boolean {
  const expected = Date.now() < expectingExternalUntil
  expectingExternalUntil = 0
  return expected
}

export function externalTripStillShort(awayMs: number): boolean {
  return awayMs < EXTERNAL_MAX_MS
}

/**
 * Whether the fingerprint can unlock the app. Only "strong" (Class 3) biometrics are accepted: on
 * Samsung phones that is the fingerprint reader, while face unlock is weaker and never offered.
 */
export async function fingerprintAvailable(): Promise<boolean> {
  try {
    const [types, level] = await Promise.all([
      LocalAuthentication.supportedAuthenticationTypesAsync(),
      LocalAuthentication.getEnrolledLevelAsync()
    ])
    return types.includes(AuthenticationType.FINGERPRINT) && level >= SecurityLevel.BIOMETRIC_STRONG
  } catch {
    return false
  }
}

export async function authenticateWithFingerprint(cancelLabel: string): Promise<boolean> {
  expectExternalScreen()
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Déverrouiller SelfHost Hub',
      cancelLabel,
      // No fallback to the phone's own PIN, and strong biometrics only: no face unlock.
      disableDeviceFallback: true,
      biometricsSecurityLevel: 'strong'
    })
    return result.success
  } catch {
    return false
  } finally {
    // The prompt is gone: leaving the app from here on is a real departure.
    takeExpectedExternal()
  }
}
