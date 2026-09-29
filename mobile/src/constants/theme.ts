import { File, Paths } from 'expo-file-system'

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

export interface Appearance {
  accent: string
  background: BackgroundId
}

export const DEFAULT_APPEARANCE: Appearance = { accent: '#1DB954', background: 'dark' }

const appearanceFile = new File(Paths.document, 'appearance.json')

// Read synchronously: every StyleSheet is built from `colors` the moment its module loads.
function readAppearance(): Appearance {
  try {
    if (!appearanceFile.exists) return DEFAULT_APPEARANCE
    const saved = JSON.parse(appearanceFile.textSync())
    return {
      accent: /^#[0-9a-f]{6}$/i.test(saved.accent) ? saved.accent : DEFAULT_APPEARANCE.accent,
      background: saved.background in BACKGROUNDS ? saved.background : DEFAULT_APPEARANCE.background
    }
  } catch {
    return DEFAULT_APPEARANCE
  }
}

/** The scheme this session was started with; a saved change takes effect after the app reloads. */
export const appearance = readAppearance()

export function saveAppearance(next: Appearance): void {
  if (!appearanceFile.exists) appearanceFile.create()
  appearanceFile.write(JSON.stringify(next))
}

type Rgb = [number, number, number]

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`
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
export function readableAccent(hex: string): string {
  let lifted = hexToRgb(hex)
  for (let i = 0; i < 12 && luminance(lifted) < 0.18; i++) lifted = mix(lifted, [255, 255, 255], 0.12)
  return rgbToHex(lifted)
}

const accent = readableAccent(appearance.accent)
const surfaces = BACKGROUNDS[appearance.background]

export const colors = {
  accent,
  accentHover: rgbToHex(mix(hexToRgb(accent), [255, 255, 255], 0.12)),
  base: surfaces.base,
  raised: surfaces.raised,
  elevated: surfaces.elevated,
  hover: surfaces.hover,
  border: surfaces.border,
  text: '#ffffff',
  textSecondary: '#b3b3b3',
  textMuted: '#6a6a6a',
  danger: '#f87171',
  warning: '#facc15',
  info: '#60a5fa',
  /** Per-service brand colours, shared by the settings rows and login screens. */
  filebrowser: '#3b82f6',
  downtify: '#f97316'
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32
} as const

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  full: 999
} as const

/**
 * Heights of the persistent chrome that floats over every tab screen. Scrollable
 * content pads its bottom by `contentBottom` so the last row never ends up behind
 * the mini player or the tab bar.
 */
export const layout = {
  tabBar: 58,
  miniPlayer: 60,
  /** tab bar + mini player + a little breathing room */
  contentBottom: 58 + 60 + spacing.lg
} as const
