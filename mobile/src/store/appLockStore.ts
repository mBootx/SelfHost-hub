import { AppState } from 'react-native'
import { File, Paths } from 'expo-file-system'
import * as SecureStore from 'expo-secure-store'
import { create } from 'zustand'
import {
  encodePattern,
  externalTripStillShort,
  hashSecret,
  DeviceClock,
  LockMethod,
  lockoutRemaining,
  randomSalt,
  takeExpectedExternal
} from '@/services/appLock'
import { storage } from '@/services/storage'
import SelfHostNative from '../../modules/selfhost-native'

/** Everything about the lock lives in the secure store, so a restored backup can't bring a lock without its code. */
const CONFIG_KEY = 'appLock_config'
const ATTEMPTS_KEY = 'appLock_attempts'

/**
 * Only says whether a lock is set (no secret in it). Read synchronously at startup, like the theme, so
 * the lock covers the very first frame instead of appearing once the secure store has answered.
 */
const flagFile = new File(Paths.document, 'app-lock.json')

function readLockFlag(): boolean {
  try {
    return flagFile.exists && JSON.parse(flagFile.textSync()).enabled === true
  } catch {
    return false
  }
}

/** With a lock set, the recents screen must not show the last screen of the app. */
function applyPrivacy(enabled: boolean): void {
  try {
    SelfHostNative?.setPrivacyScreen?.(enabled)
  } catch {
    // An older build without the native side: the lock itself still works.
  }
}

function readClock(): DeviceClock | null {
  try {
    const clock = SelfHostNative?.getClock?.()
    return clock && typeof clock.elapsed === 'number' ? clock : null
  } catch {
    return null
  }
}

function writeLockFlag(enabled: boolean): void {
  applyPrivacy(enabled)
  try {
    if (!enabled) {
      if (flagFile.exists) flagFile.delete()
      return
    }
    if (!flagFile.exists) flagFile.create()
    flagFile.write(JSON.stringify({ enabled: true }))
  } catch {
    // Only costs a first frame without the lock: the secure store still decides.
  }
}

/** Wrong codes allowed before a pause, and the first pause; it doubles each time after that. */
const ATTEMPTS_PER_LOCKOUT = 5
const FIRST_LOCKOUT_MS = 30_000
const MAX_LOCKOUT_MS = 15 * 60 * 1000

export const LOCK_DELAYS = [
  { label: 'Immédiatement', ms: 0 },
  { label: '1 min', ms: 60_000 },
  { label: '5 min', ms: 5 * 60_000 },
  { label: '15 min', ms: 15 * 60_000 }
] as const

interface LockConfig {
  method: LockMethod
  salt: string
  hash: string
  /** PIN length, so the pad can check as soon as the last digit is typed. */
  pinLength: number
  fingerprint: boolean
  /** How long the app may stay in the background before it locks. */
  delayMs: number
}

const NO_LOCK: LockConfig = { method: 'none', salt: '', hash: '', pinLength: 0, fingerprint: false, delayMs: 0 }

export type LockStatus = 'locked' | 'unlocked'

export type UnlockResult = 'ok' | 'wrong' | 'locked-out'

interface AppLockState {
  config: LockConfig
  /** The config has been read from the secure store. */
  loaded: boolean
  status: LockStatus
  failedAttempts: number
  /** Epoch ms until which no code is accepted after too many wrong ones (what the screen counts down to). */
  lockoutUntil: number
  /** The same moment on the phone's own clock, which changing the date does not move; 0 when there is none. */
  lockoutElapsedUntil: number
  /** Which start of the phone that clock belongs to. */
  lockoutBoot: number

  load: () => Promise<void>
  lock: () => void
  unlock: () => void
  /** Checks a PIN (digits) or pattern (dot numbers) without changing anything but the attempt count. */
  check: (secret: string | number[]) => Promise<UnlockResult>
  /** Unlocks with a PIN or pattern. */
  tryUnlock: (secret: string | number[]) => Promise<UnlockResult>
  /** Unlocks after the fingerprint was accepted. */
  unlockWithFingerprint: () => Promise<void>
  /** Unlocks with the saved password of a service account, for a forgotten code; turns the lock off. */
  recover: (password: string) => Promise<UnlockResult>
  setSecret: (method: 'pin' | 'pattern', secret: string | number[]) => Promise<void>
  disable: () => Promise<void>
  setFingerprint: (on: boolean) => Promise<void>
  setDelay: (ms: number) => Promise<void>
}

function toSecret(secret: string | number[]): string {
  return Array.isArray(secret) ? encodePattern(secret) : secret
}

async function saveConfig(config: LockConfig): Promise<void> {
  if (config.method === 'none') await SecureStore.deleteItemAsync(CONFIG_KEY)
  else await SecureStore.setItemAsync(CONFIG_KEY, JSON.stringify(config))
  writeLockFlag(config.method !== 'none')
}

interface Attempts {
  failedAttempts: number
  lockoutUntil: number
  lockoutElapsedUntil: number
  lockoutBoot: number
}

const NO_ATTEMPTS: Attempts = { failedAttempts: 0, lockoutUntil: 0, lockoutElapsedUntil: 0, lockoutBoot: -1 }

async function saveAttempts(attempts: Attempts): Promise<void> {
  if (attempts.failedAttempts === 0) await SecureStore.deleteItemAsync(ATTEMPTS_KEY)
  else await SecureStore.setItemAsync(ATTEMPTS_KEY, JSON.stringify(attempts))
}

function lockoutFor(failedAttempts: number): number {
  if (failedAttempts === 0 || failedAttempts % ATTEMPTS_PER_LOCKOUT !== 0) return 0
  const round = failedAttempts / ATTEMPTS_PER_LOCKOUT - 1
  return Math.min(FIRST_LOCKOUT_MS * 2 ** round, MAX_LOCKOUT_MS)
}

let started = false
let backgroundedAt: number | null = null
let tripExpected = false

export const useAppLockStore = create<AppLockState>((set, get) => {
  /** How long no code is accepted any more. Asking also refreshes what the screen counts down to. */
  function lockoutLeft(): number {
    const { lockoutUntil, lockoutElapsedUntil, lockoutBoot } = get()
    const left = lockoutRemaining(lockoutUntil, lockoutElapsedUntil, lockoutBoot, Date.now(), readClock())
    // Someone moved the date forward: the countdown on screen starts again from what is really left.
    if (left > 0 && Date.now() >= lockoutUntil) set({ lockoutUntil: Date.now() + left })
    return left
  }

  async function recordFailure(): Promise<UnlockResult> {
    const failedAttempts = get().failedAttempts + 1
    const pause = lockoutFor(failedAttempts)
    let { lockoutUntil, lockoutElapsedUntil, lockoutBoot } = get()
    if (pause) {
      const clock = readClock()
      lockoutUntil = Date.now() + pause
      lockoutElapsedUntil = clock ? clock.elapsed + pause : 0
      lockoutBoot = clock ? clock.boot : -1
    }
    set({ failedAttempts, lockoutUntil, lockoutElapsedUntil, lockoutBoot })
    await saveAttempts({ failedAttempts, lockoutUntil, lockoutElapsedUntil, lockoutBoot })
    return 'wrong'
  }

  async function resetFailures(): Promise<void> {
    if (get().failedAttempts === 0) return
    set({ ...NO_ATTEMPTS })
    await saveAttempts(NO_ATTEMPTS)
  }

  return {
    config: NO_LOCK,
    loaded: false,
    status: readLockFlag() ? 'locked' : 'unlocked',
    failedAttempts: 0,
    lockoutUntil: 0,
    lockoutElapsedUntil: 0,
    lockoutBoot: -1,

    load: async () => {
      let config = NO_LOCK
      let attempts: Attempts = NO_ATTEMPTS
      try {
        const raw = await SecureStore.getItemAsync(CONFIG_KEY)
        if (raw) config = { ...NO_LOCK, ...JSON.parse(raw) }
        const rawAttempts = await SecureStore.getItemAsync(ATTEMPTS_KEY)
        if (rawAttempts) attempts = { ...NO_ATTEMPTS, ...JSON.parse(rawAttempts) }
      } catch {
        // Unreadable secure store (e.g. restored from another phone): nothing to unlock with.
        config = NO_LOCK
      }
      writeLockFlag(config.method !== 'none')
      set({ config, ...attempts, loaded: true, status: config.method === 'none' ? 'unlocked' : 'locked' })
    },

    lock: () => {
      if (get().config.method !== 'none') set({ status: 'locked' })
    },

    unlock: () => set({ status: 'unlocked' }),

    check: async (secret) => {
      const { config } = get()
      if (lockoutLeft() > 0) return 'locked-out'
      if (hashSecret(toSecret(secret), config.salt) !== config.hash) return recordFailure()
      await resetFailures()
      return 'ok'
    },

    tryUnlock: async (secret) => {
      const result = await get().check(secret)
      if (result === 'ok') set({ status: 'unlocked' })
      return result
    },

    unlockWithFingerprint: async () => {
      await resetFailures()
      set({ status: 'unlocked' })
    },

    recover: async (password) => {
      if (lockoutLeft() > 0) return 'locked-out'
      const saved = await Promise.all([
        storage.loadSecret('navidrome', 'password'),
        storage.loadSecret('filebrowser', 'password')
      ])
      if (!password || !saved.includes(password)) return recordFailure()
      await resetFailures()
      await get().disable()
      set({ status: 'unlocked' })
      return 'ok'
    },

    setSecret: async (method, secret) => {
      const plain = toSecret(secret)
      const salt = randomSalt()
      const config: LockConfig = {
        ...get().config,
        method,
        salt,
        hash: hashSecret(plain, salt),
        pinLength: method === 'pin' ? plain.length : 0
      }
      await saveConfig(config)
      set({ config, status: 'unlocked' })
    },

    disable: async () => {
      await saveConfig(NO_LOCK)
      set({ config: NO_LOCK, status: 'unlocked' })
    },

    setFingerprint: async (fingerprint) => {
      const config = { ...get().config, fingerprint }
      await saveConfig(config)
      set({ config })
    },

    setDelay: async (delayMs) => {
      const config = { ...get().config, delayMs }
      await saveConfig(config)
      set({ config })
    }
  }
})

/** Locks the app when it comes back after being away longer than the chosen delay. */
export function startAppLock(): void {
  if (started) return
  started = true
  useAppLockStore.getState().load()
  AppState.addEventListener('change', (next) => {
    // The setting belongs to the activity, which Android may have rebuilt while the app was away.
    if (next === 'active') applyPrivacy(useAppLockStore.getState().config.method !== 'none')
    if (next === 'background') {
      backgroundedAt = Date.now()
      tripExpected = takeExpectedExternal()
      return
    }
    if (next !== 'active' || backgroundedAt === null) return
    const awayMs = Date.now() - backgroundedAt
    const expected = tripExpected
    backgroundedAt = null
    tripExpected = false
    const { config, status } = useAppLockStore.getState()
    if (config.method === 'none' || status !== 'unlocked') return
    if (expected && externalTripStillShort(awayMs)) return
    if (awayMs >= config.delayMs) useAppLockStore.getState().lock()
  })
}
