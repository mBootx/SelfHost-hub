import { create } from 'zustand'

export type BackgroundId = 'dark' | 'amoled' | 'slate' | 'mocha'

interface Surfaces {
  label: string
  base: string
  raised: string
  elevated: string
  hover: string
  border: string
}

export const ACCENT_PRESETS = [
  { label: 'Vert', hex: '#1DB954' },
  { label: 'Bleu', hex: '#3B82F6' },
  { label: 'Violet', hex: '#8B5CF6' },
  { label: 'Rose', hex: '#EC4899' },
  { label: 'Rouge', hex: '#EF4444' },
  { label: 'Orange', hex: '#F97316' },
  { label: 'Jaune', hex: '#EAB308' },
  { label: 'Cyan', hex: '#06B6D4' }
] as const

export const BACKGROUNDS: Record<BackgroundId, Surfaces> = {
  dark: { label: 'Sombre', base: '#0a0a0a', raised: '#121212', elevated: '#181818', hover: '#282828', border: '#2a2a2a' },
  amoled: { label: 'AMOLED', base: '#000000', raised: '#070707', elevated: '#0f0f0f', hover: '#1c1c1c', border: '#1f1f1f' },
  slate: { label: 'Ardoise', base: '#0b1220', raised: '#0f172a', elevated: '#152033', hover: '#1e2b44', border: '#233150' },
  mocha: { label: 'Moka', base: '#0f0c0a', raised: '#171310', elevated: '#1e1915', hover: '#2e2620', border: '#332a23' }
}

interface Appearance {
  accent: string
  background: BackgroundId
}

const STORAGE_KEY = 'shub.appearance'
const DEFAULT_APPEARANCE: Appearance = { accent: '#1DB954', background: 'dark' }

type Rgb = [number, number, number]

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function mix(color: Rgb, target: Rgb, amount: number): Rgb {
  return color.map((c, i) => Math.round(c + (target[i] - c) * amount)) as Rgb
}

function luminance([r, g, b]: Rgb): number {
  const channel = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** Buttons put black text on the accent, so a very dark custom colour is lifted until that stays readable (4.5:1). */
function readableAccent(color: Rgb): Rgb {
  let lifted = color
  for (let i = 0; i < 12 && luminance(lifted) < 0.18; i++) lifted = mix(lifted, [255, 255, 255], 0.12)
  return lifted
}

function applyAppearance({ accent, background }: Appearance): void {
  const root = document.documentElement.style
  const rgb = readableAccent(hexToRgb(accent))
  root.setProperty('--accent', rgb.join(' '))
  root.setProperty('--accent-hover', mix(rgb, [255, 255, 255], 0.12).join(' '))
  root.setProperty('--accent-dark', mix(rgb, [0, 0, 0], 0.15).join(' '))
  const surfaces = BACKGROUNDS[background] ?? BACKGROUNDS.dark
  for (const key of ['base', 'raised', 'elevated', 'hover', 'border'] as const) {
    root.setProperty(`--surface-${key}`, hexToRgb(surfaces[key]).join(' '))
  }
}

function loadAppearance(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return {
      accent: /^#[0-9a-f]{6}$/i.test(saved.accent) ? saved.accent : DEFAULT_APPEARANCE.accent,
      background: saved.background in BACKGROUNDS ? saved.background : DEFAULT_APPEARANCE.background
    }
  } catch {
    return DEFAULT_APPEARANCE
  }
}

interface AppearanceState extends Appearance {
  setAccent: (hex: string) => void
  setBackground: (id: BackgroundId) => void
  reset: () => void
}

const initial = loadAppearance()
// Applied at import time, before the first render, so the saved scheme never flashes the default one.
applyAppearance(initial)

export const useAppearanceStore = create<AppearanceState>((set, get) => {
  function update(next: Appearance): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    applyAppearance(next)
    set(next)
  }
  return {
    ...initial,
    setAccent: (accent) => update({ accent, background: get().background }),
    setBackground: (background) => update({ accent: get().accent, background }),
    reset: () => update(DEFAULT_APPEARANCE)
  }
})
