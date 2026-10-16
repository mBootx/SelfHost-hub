import { create } from 'zustand'
import { storage } from '@/services/storage'

export type TabAnimationType = 'shift' | 'fade' | 'none'
export type TabAnimationSpeed = 'fast' | 'normal' | 'relaxed'

export interface PersistedTabAnimationSettings {
  animationType: TabAnimationType
  speed: TabAnimationSpeed
  customDurationMs?: number
}

export const SPEED_PRESETS: Record<TabAnimationSpeed, { label: string; duration: number; hint: string }> = {
  fast: { label: 'Rapide', duration: 150, hint: '150 ms · Réactif et vif' },
  normal: { label: 'Équilibré', duration: 250, hint: '250 ms · Fluide et naturel' },
  relaxed: { label: 'Doux', duration: 380, hint: '380 ms · Ample et posé' }
}

export const ANIMATION_TYPES: Record<TabAnimationType, { label: string; description: string }> = {
  shift: { label: 'Glissement', description: 'Transition fluide avec glissement latéral et fondu' },
  fade: { label: 'Fondu', description: 'Fondu croisé doux entre les écrans' },
  none: { label: 'Instantané', description: 'Changement direct sans transition' }
}

const PREF_KEY = 'tab.animation'
const DEFAULTS: PersistedTabAnimationSettings = {
  animationType: 'shift',
  speed: 'normal'
}

export interface TabAnimationState extends PersistedTabAnimationSettings {
  durationMs: number
  load: () => Promise<void>
  setAnimationType: (type: TabAnimationType) => void
  setSpeed: (speed: TabAnimationSpeed) => void
  setCustomDurationMs: (ms: number) => void
  getSummary: () => string
}

function resolveDuration(speed: TabAnimationSpeed, customDurationMs?: number): number {
  if (customDurationMs && customDurationMs > 0) return customDurationMs
  return SPEED_PRESETS[speed]?.duration ?? 250
}

export const useTabAnimationStore = create<TabAnimationState>((set, get) => {
  function persist(patch: Partial<PersistedTabAnimationSettings>): void {
    set(patch)
    const { animationType, speed, customDurationMs } = get()
    storage.savePref(PREF_KEY, { animationType, speed, customDurationMs })
  }

  return {
    ...DEFAULTS,
    durationMs: SPEED_PRESETS[DEFAULTS.speed].duration,

    load: async () => {
      const saved = await storage.loadPref<Partial<PersistedTabAnimationSettings>>(PREF_KEY)
      if (saved) {
        const animationType = saved.animationType && saved.animationType in ANIMATION_TYPES ? saved.animationType : DEFAULTS.animationType
        const speed = saved.speed && saved.speed in SPEED_PRESETS ? saved.speed : DEFAULTS.speed
        const customDurationMs =
          typeof saved.customDurationMs === 'number' && saved.customDurationMs >= 80 && saved.customDurationMs <= 600
            ? saved.customDurationMs
            : undefined
        const durationMs = resolveDuration(speed, customDurationMs)
        set({ animationType, speed, customDurationMs, durationMs })
      }
    },

    setAnimationType: (animationType) => {
      persist({ animationType })
    },

    setSpeed: (speed) => {
      const durationMs = resolveDuration(speed, undefined)
      set({ durationMs })
      persist({ speed, customDurationMs: undefined })
    },

    setCustomDurationMs: (ms) => {
      const clamped = Math.max(80, Math.min(600, Math.round(ms)))
      set({ durationMs: clamped })
      persist({ customDurationMs: clamped })
    },

    getSummary: () => {
      const { animationType, durationMs } = get()
      if (animationType === 'none') return 'Désactivées'
      const typeLabel = ANIMATION_TYPES[animationType]?.label ?? 'Glissement'
      return `${typeLabel} · ${durationMs} ms`
    }
  }
})
