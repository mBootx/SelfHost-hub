import SelfHostNative from '../../modules/selfhost-native'
import { colors } from '@/constants/theme'

/** The colours of the Now Playing screen for one cover. */
export interface Look {
  /** Top of the background gradient. */
  top: string
  /** Where the gradient has mostly melted into the app background. */
  middle: string
  /** The lyrics card and the full lyrics page. */
  card: string
}

const known = new Map<string, string>()

export function cachedCoverColor(url: string): string | null {
  return known.get(url) ?? null
}

/**
 * The dominant colour ("#rrggbb") of the cover at `url`, or null when there is none to be had: the native
 * side is missing (older build, Expo Go), or the cover couldn't be downloaded. The native side reuses the
 * cover the Now Bar already fetched for the same URL, so this rarely costs a second download.
 */
export async function coverColor(url: string): Promise<string | null> {
  const cached = known.get(url)
  if (cached) return cached
  try {
    const found = (await SelfHostNative?.getCoverColor?.(url)) ?? null
    if (found) known.set(url, found)
    return found
  } catch {
    return null
  }
}

type Rgb = [number, number, number]

function parse(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
}

/** Hue in degrees, saturation and lightness in 0..1. */
function toHsl([r, g, b]: Rgb): [number, number, number] {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  return [h * 60, s, l]
}

function fromHsl(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

function luminance([r, g, b]: Rgb): number {
  const channel = (c: number): number => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** White text on `rgb`: WCAG contrast ratio. */
function contrastWithWhite(rgb: Rgb): number {
  return 1.05 / (luminance(rgb) + 0.05)
}

/**
 * Turns a cover's dominant colour into a background that white text can sit on. The hue is kept, but the
 * saturation is held in a band (a cover's own varies far more than a background should) and the lightness is
 * fixed: dark at the top, fading out, and a lyrics card that is lifted just far enough to stay readable.
 * Without a colour the screen falls back to the app's own dark surfaces.
 */
export function lookFor(color: string | null): Look {
  const rgb = color ? parse(color) : null
  if (!rgb) return { top: colors.elevated, middle: colors.raised, card: colors.elevated }

  const [h, s] = toHsl(rgb)
  // A grey cover stays grey instead of picking up whatever hue 0 happens to be.
  const sat = s < 0.1 ? s : Math.min(0.7, Math.max(0.3, s))
  let lightness = 0.38
  let card = fromHsl(h, sat * 0.8, lightness)
  while (contrastWithWhite(card) < 4.6 && lightness > 0.14) {
    lightness -= 0.02
    card = fromHsl(h, sat * 0.8, lightness)
  }
  return {
    top: toHex(fromHsl(h, sat * 0.85, 0.3)),
    middle: toHex(fromHsl(h, sat * 0.7, 0.15)),
    card: toHex(card)
  }
}
