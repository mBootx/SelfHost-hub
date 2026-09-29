import { create } from 'zustand'
import { storage } from '@/services/storage'
import type { EqualizerBands } from '../../modules/selfhost-native'

export const CROSSFADE_MAX_S = 12

/** Presets are defined on these ten frequencies, like the desktop app, then mapped onto the phone's own bands. */
const PRESET_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

export const EQ_PRESETS: { id: string; label: string; gains: number[] }[] = [
  { id: 'flat', label: 'Plat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass', label: 'Graves +', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { id: 'treble', label: 'Aigus +', gains: [0, 0, 0, 0, 0, 0, 2, 4, 5, 6] },
  { id: 'vocal', label: 'Voix', gains: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1] },
  { id: 'rock', label: 'Rock', gains: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4] },
  { id: 'pop', label: 'Pop', gains: [-1, 0, 2, 3, 3, 2, 0, -1, -1, -1] },
  { id: 'electronic', label: 'Électro', gains: [5, 4, 1, 0, -2, 1, 0, 2, 4, 5] },
  { id: 'jazz', label: 'Jazz', gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  { id: 'classical', label: 'Classique', gains: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4] },
  { id: 'acoustic', label: 'Acoustique', gains: [3, 3, 2, 1, 1, 1, 2, 2, 2, 1] }
]

/** Interpolates a preset (on a log-frequency scale) at each of the phone's band centres. */
function presetForBands(gains: number[], bandFrequencies: number[]): number[] {
  const logs = PRESET_FREQUENCIES.map(Math.log)
  return bandFrequencies.map((frequency) => {
    const x = Math.log(frequency)
    if (x <= logs[0]) return gains[0]
    if (x >= logs[logs.length - 1]) return gains[gains.length - 1]
    const i = logs.findIndex((l) => l >= x)
    const t = (x - logs[i - 1]) / (logs[i] - logs[i - 1])
    return Math.round((gains[i - 1] + t * (gains[i] - gains[i - 1])) * 10) / 10
  })
}

interface PersistedSettings {
  crossfadeSeconds: number
  gapless: boolean
  eqEnabled: boolean
  /** A preset id, or 'custom' once a band has been moved by hand. */
  eqPreset: string
  /** Per-band gains in the phone's own layout, used when eqPreset is 'custom'. */
  eqCustomGains: number[]
}

const PREF_KEY = 'audio.settings'
const DEFAULTS: PersistedSettings = { crossfadeSeconds: 0, gapless: true, eqEnabled: false, eqPreset: 'flat', eqCustomGains: [] }

interface AudioSettingsState extends PersistedSettings {
  /** The phone's equalizer layout once the native side reports it; null while unknown or unsupported. */
  eqBands: EqualizerBands | null
  load: () => Promise<void>
  setEqBands: (bands: EqualizerBands | null) => void
  setCrossfade: (seconds: number) => void
  setGapless: (on: boolean) => void
  setEqEnabled: (on: boolean) => void
  applyEqPreset: (id: string) => void
  setEqBand: (index: number, db: number) => void
  /** The gain of each of the phone's bands for the current preset or custom curve. */
  deviceGains: () => number[]
}

export const useAudioSettingsStore = create<AudioSettingsState>((set, get) => {
  function update(patch: Partial<PersistedSettings>): void {
    set(patch)
    const { crossfadeSeconds, gapless, eqEnabled, eqPreset, eqCustomGains } = get()
    storage.savePref(PREF_KEY, { crossfadeSeconds, gapless, eqEnabled, eqPreset, eqCustomGains })
  }

  return {
    ...DEFAULTS,
    eqBands: null,

    load: async () => {
      const saved = await storage.loadPref<Partial<PersistedSettings>>(PREF_KEY)
      if (saved) set({ ...DEFAULTS, ...saved })
    },

    setEqBands: (eqBands) => set({ eqBands }),
    setCrossfade: (seconds) => update({ crossfadeSeconds: Math.max(0, Math.min(CROSSFADE_MAX_S, Math.round(seconds))) }),
    setGapless: (gapless) => update({ gapless }),
    setEqEnabled: (eqEnabled) => update({ eqEnabled }),

    applyEqPreset: (id) => {
      if (EQ_PRESETS.some((p) => p.id === id)) update({ eqPreset: id, eqEnabled: true })
    },

    setEqBand: (index, db) => {
      const bands = get().eqBands
      if (!bands) return
      const gains = get().deviceGains()
      gains[index] = Math.max(bands.minDb, Math.min(bands.maxDb, db))
      update({ eqPreset: 'custom', eqCustomGains: gains, eqEnabled: true })
    },

    deviceGains: () => {
      const { eqBands, eqPreset, eqCustomGains } = get()
      if (!eqBands) return []
      if (eqPreset === 'custom' && eqCustomGains.length === eqBands.frequencies.length) return [...eqCustomGains]
      const preset = EQ_PRESETS.find((p) => p.id === eqPreset) ?? EQ_PRESETS[0]
      return presetForBands(preset.gains, eqBands.frequencies)
    }
  }
})
