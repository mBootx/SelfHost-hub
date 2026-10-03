import { create } from 'zustand'
import { storage } from '@/services/storage'
import {
  DEFAULT_SENSITIVITY,
  DEFAULT_THRESHOLDS,
  GESTURES,
  GestureName,
  GestureThresholds,
  thresholdsFor
} from '@/services/gestureRecognizer'
import SelfHostNative, { PermissionAnswer } from '../../modules/selfhost-native'

/**
 * The car mode (app/car-mode.tsx): a full-screen player driven by hand gestures seen by the front camera, with big
 * buttons as a fallback. Its settings are kept on the phone; whether it is open, the camera, and the last gesture are
 * not.
 */

export type CarOrientation = 'auto' | 'portrait' | 'landscape'

/** 'blocked': refused with "don't ask again", only the phone's settings can give it now. 'unavailable': this build has no camera code. */
export type CameraPermission = 'unknown' | 'granted' | 'denied' | 'blocked' | 'unavailable'

/** Frames a second the hand tracker reads: enough for a wave, and fewer to spare the battery. */
export const NORMAL_FPS = 24
export const SAVER_FPS = 15

interface CarModeSettings {
  /** 0 strict to 1 loose; moving it sets every threshold below. */
  sensitivity: number
  gestureThresholds: GestureThresholds
  gestures: Record<GestureName, boolean>
  /** Shows the camera's picture with the points of the hand, the frame rate and what the hand is doing. */
  testMode: boolean
  /** 15 frames a second instead of 24. */
  batterySaver: boolean
  orientation: CarOrientation
  /** A short double buzz at each gesture. */
  haptics: boolean
  /** Full brightness when the light sensor reads sunshine. */
  sunBoost: boolean
}

const PREF_KEY = 'carMode.settings'

const allGestures = (on: boolean): Record<GestureName, boolean> =>
  Object.fromEntries(GESTURES.map((g) => [g, on])) as Record<GestureName, boolean>

export const DEFAULT_CAR_SETTINGS: CarModeSettings = {
  sensitivity: DEFAULT_SENSITIVITY,
  gestureThresholds: { ...DEFAULT_THRESHOLDS },
  gestures: allGestures(true),
  testMode: false,
  batterySaver: false,
  orientation: 'auto',
  haptics: true,
  sunBoost: true
}

interface CarModeState extends CarModeSettings {
  loaded: boolean
  isCarModeEnabled: boolean
  isCameraActive: boolean
  lastDetectedGesture: GestureName | null
  lastConfidence: number
  /** Grows at every gesture, so the same gesture twice in a row still shows again. */
  gestureCount: number
  permission: CameraPermission

  load: () => Promise<void>
  toggleCarMode: () => void
  setCarModeEnabled: (on: boolean) => void
  setCameraActive: (active: boolean) => void
  setLastGesture: (gesture: GestureName | null, confidence?: number) => void
  updateThreshold: (key: keyof GestureThresholds, value: number) => void
  setSensitivity: (sensitivity: number) => void
  setGestureEnabled: (gesture: GestureName, on: boolean) => void
  setTestMode: (on: boolean) => void
  setBatterySaver: (on: boolean) => void
  setOrientation: (orientation: CarOrientation) => void
  setHaptics: (on: boolean) => void
  setSunBoost: (on: boolean) => void
  /** Reads the camera permission without asking. */
  refreshPermission: () => Promise<CameraPermission>
  /** Asks for the camera (Android shows its dialog unless it was blocked). */
  requestPermission: () => Promise<CameraPermission>
}

/** How Expo's answer reads for the car mode. */
export function permissionFrom(answer: PermissionAnswer | null | undefined): CameraPermission {
  if (!answer) return 'unavailable'
  if (answer.granted || answer.status === 'granted') return 'granted'
  if (answer.status === 'undetermined') return 'unknown'
  return answer.canAskAgain ? 'denied' : 'blocked'
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/** Saved settings as they come back, every value checked: a damaged or older file gives defaults where it is wrong. */
export function settingsFrom(saved: unknown): CarModeSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<keyof CarModeSettings, unknown>>
  const d = DEFAULT_CAR_SETTINGS
  const number = (v: unknown, fallback: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
  const sensitivity = number(s.sensitivity, d.sensitivity, 0, 1)
  const fromSensitivity = thresholdsFor(sensitivity)
  const t = (s.gestureThresholds && typeof s.gestureThresholds === 'object' ? s.gestureThresholds : {}) as Partial<Record<keyof GestureThresholds, unknown>>
  const g = (s.gestures && typeof s.gestures === 'object' ? s.gestures : {}) as Partial<Record<GestureName, unknown>>
  return {
    sensitivity,
    gestureThresholds: {
      pinchDistance: number(t.pinchDistance, fromSensitivity.pinchDistance, 0.05, 1),
      swipeMinDistance: number(t.swipeMinDistance, fromSensitivity.swipeMinDistance, 0.05, 0.9),
      swipeConfidenceThreshold: number(t.swipeConfidenceThreshold, fromSensitivity.swipeConfidenceThreshold, 0.3, 1)
    },
    gestures: Object.fromEntries(GESTURES.map((name) => [name, bool(g[name], true)])) as Record<GestureName, boolean>,
    testMode: bool(s.testMode, d.testMode),
    batterySaver: bool(s.batterySaver, d.batterySaver),
    orientation: s.orientation === 'portrait' || s.orientation === 'landscape' || s.orientation === 'auto' ? s.orientation : d.orientation,
    haptics: bool(s.haptics, d.haptics),
    sunBoost: bool(s.sunBoost, d.sunBoost)
  }
}

export const useCarModeStore = create<CarModeState>((set, get) => {
  function update(patch: Partial<CarModeSettings>): void {
    set(patch)
    const { sensitivity, gestureThresholds, gestures, testMode, batterySaver, orientation, haptics, sunBoost } = get()
    storage.savePref(PREF_KEY, { sensitivity, gestureThresholds, gestures, testMode, batterySaver, orientation, haptics, sunBoost })
  }

  async function readPermission(ask: boolean): Promise<CameraPermission> {
    const read = ask ? SelfHostNative?.requestCameraPermission : SelfHostNative?.getCameraPermission
    let permission: CameraPermission
    try {
      permission = read ? permissionFrom(await read.call(SelfHostNative)) : 'unavailable'
    } catch {
      permission = 'unavailable'
    }
    set({ permission })
    return permission
  }

  return {
    ...DEFAULT_CAR_SETTINGS,
    loaded: false,
    isCarModeEnabled: false,
    isCameraActive: false,
    lastDetectedGesture: null,
    lastConfidence: 0,
    gestureCount: 0,
    permission: 'unknown',

    load: async () => {
      const saved = await storage.loadPref<unknown>(PREF_KEY)
      set({ ...settingsFrom(saved), loaded: true })
    },

    toggleCarMode: () => set((s) => ({ isCarModeEnabled: !s.isCarModeEnabled })),
    setCarModeEnabled: (on) => set({ isCarModeEnabled: on }),
    setCameraActive: (active) => set({ isCameraActive: active }),
    setLastGesture: (gesture, confidence = 0) =>
      set((s) => (gesture ? { lastDetectedGesture: gesture, lastConfidence: clamp01(confidence), gestureCount: s.gestureCount + 1 } : { lastDetectedGesture: null })),

    updateThreshold: (key, value) => {
      if (!Number.isFinite(value)) return
      update({ gestureThresholds: settingsFrom({ ...get(), gestureThresholds: { ...get().gestureThresholds, [key]: value } }).gestureThresholds })
    },
    setSensitivity: (sensitivity) => {
      const s = clamp01(Number.isFinite(sensitivity) ? sensitivity : DEFAULT_SENSITIVITY)
      update({ sensitivity: s, gestureThresholds: thresholdsFor(s) })
    },
    setGestureEnabled: (gesture, on) => update({ gestures: { ...get().gestures, [gesture]: on } }),
    setTestMode: (testMode) => update({ testMode }),
    setBatterySaver: (batterySaver) => update({ batterySaver }),
    setOrientation: (orientation) => update({ orientation }),
    setHaptics: (haptics) => update({ haptics }),
    setSunBoost: (sunBoost) => update({ sunBoost }),

    refreshPermission: () => readPermission(false),
    requestPermission: () => readPermission(true)
  }
})

/** The tracker's frame rate for the battery setting. */
export const fpsFor = (batterySaver: boolean): number => (batterySaver ? SAVER_FPS : NORMAL_FPS)

/** Sunshine on the phone: past this the screen goes to full brightness... */
export const SUN_ON_LUX = 8000
/** ...and back to the phone's own brightness only under this, so a passing shadow does not make it flicker. */
export const SUN_OFF_LUX = 1500

export function sunnyAfter(wasSunny: boolean, lux: number): boolean {
  if (!Number.isFinite(lux)) return wasSunny
  return wasSunny ? lux > SUN_OFF_LUX : lux > SUN_ON_LUX
}
