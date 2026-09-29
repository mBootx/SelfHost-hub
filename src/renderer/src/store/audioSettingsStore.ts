import { create } from 'zustand'

/** Centre frequencies (Hz) of the equalizer bands. */
export const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
export const EQ_MAX_DB = 12
export const CROSSFADE_MAX_S = 12

export const EQ_PRESETS: { id: string; label: string; gains: number[] }[] = [
  { id: 'flat', label: 'Plat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass', label: 'Graves +', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { id: 'treble', label: 'Aigus +', gains: [0, 0, 0, 0, 0, 0, 2, 4, 5, 6] },
  { id: 'vocal', label: 'Voix', gains: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1] },
  { id: 'rock', label: 'Rock', gains: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4] },
  { id: 'pop', label: 'Pop', gains: [-1, 0, 2, 3, 3, 2, 0, -1, -1, -1] },
  { id: 'electronic', label: 'Electro', gains: [5, 4, 1, 0, -2, 1, 0, 2, 4, 5] },
  { id: 'jazz', label: 'Jazz', gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  { id: 'classical', label: 'Classique', gains: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4] },
  { id: 'acoustic', label: 'Acoustique', gains: [3, 3, 2, 1, 1, 1, 2, 2, 2, 1] }
]

interface AudioSettings {
  crossfadeSeconds: number
  gapless: boolean
  eqEnabled: boolean
  /** A preset id, or 'custom' once a band has been moved by hand. */
  eqPreset: string
  eqGains: number[]
}

const STORAGE_KEY = 'shub.audio'
const DEFAULTS: AudioSettings = {
  crossfadeSeconds: 0,
  gapless: true,
  eqEnabled: false,
  eqPreset: 'flat',
  eqGains: EQ_PRESETS[0].gains
}

function loadSettings(): AudioSettings {
  try {
    const saved = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }
    if (!Array.isArray(saved.eqGains) || saved.eqGains.length !== EQ_FREQUENCIES.length) saved.eqGains = DEFAULTS.eqGains
    return saved
  } catch {
    return DEFAULTS
  }
}

interface AudioSettingsState extends AudioSettings {
  setCrossfade: (seconds: number) => void
  setGapless: (on: boolean) => void
  setEqEnabled: (on: boolean) => void
  applyEqPreset: (id: string) => void
  setEqBand: (index: number, db: number) => void
}

export const useAudioSettingsStore = create<AudioSettingsState>((set, get) => {
  function update(patch: Partial<AudioSettings>): void {
    set(patch)
    const { crossfadeSeconds, gapless, eqEnabled, eqPreset, eqGains } = get()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ crossfadeSeconds, gapless, eqEnabled, eqPreset, eqGains }))
  }
  return {
    ...loadSettings(),
    setCrossfade: (seconds) => update({ crossfadeSeconds: Math.max(0, Math.min(CROSSFADE_MAX_S, seconds)) }),
    setGapless: (gapless) => update({ gapless }),
    setEqEnabled: (eqEnabled) => update({ eqEnabled }),
    applyEqPreset: (id) => {
      const preset = EQ_PRESETS.find((p) => p.id === id)
      if (preset) update({ eqPreset: id, eqGains: preset.gains, eqEnabled: true })
    },
    setEqBand: (index, db) => {
      const eqGains = get().eqGains.map((g, i) => (i === index ? Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, db)) : g))
      update({ eqGains, eqPreset: 'custom', eqEnabled: true })
    }
  }
})
