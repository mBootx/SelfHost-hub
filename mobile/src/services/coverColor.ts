import SelfHostNative from '../../modules/selfhost-native'
import { colors } from '@/constants/theme'

/**
 * The Now Playing screen dressed in the colours of the song's cover: its palette (the colour it is mostly about, its
 * most vivid one, a second colour of its own) is read from a small copy of the cover, then turned into colours white
 * text and the controls stay readable on. Kept free of React so it can be checked in Node (tests/palette.test.js).
 */

export type Rgb = [number, number, number]

export interface Palette {
  /** What the cover is mostly about: the background. */
  base: Rgb
  /**
   * The controls' colour: another colourful colour of the cover if it has one, else its most vivid colour that covers
   * enough of it to count; null when it has none.
   */
  accent: Rgb | null
  /** A second colour of its own, well apart in hue from the base, or null when the cover is one colour. */
  second: Rgb | null
  /** No colour to speak of: black and white, greys. */
  grey: boolean
}

/** The colours of the Now Playing screen for one cover. */
export interface Look {
  /** The background gradient, from the top down; the bottom stays in the cover's colour too. */
  top: string
  middle: string
  bottom: string
  /** The cover's second colour, glowing from the top corner (null: none). */
  glow: string | null
  /** The lyrics card and the full lyrics page. */
  card: string
  /** The controls: seek bar, play button, the heart, whatever is switched on. */
  accent: string
  /** Icons and text on the accent (the play button's): black or white, whichever reads better. */
  onAccent: string
}

/** The app's own colours, for a song without a cover (or a build that cannot read one). */
export const PLAIN_LOOK: Look = {
  top: colors.elevated,
  middle: colors.raised,
  bottom: colors.base,
  glow: null,
  card: colors.elevated,
  accent: colors.accent,
  onAccent: '#000000'
}

// --- Colour maths ---

function parse(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`
}

/** Hue in degrees, saturation and lightness in 0..1. */
export function toHsl([r, g, b]: Rgb): [number, number, number] {
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

/** WCAG contrast ratio between two colours. */
export function contrast(a: Rgb | string, b: Rgb | string): number {
  const la = luminance(typeof a === 'string' ? parse(a) ?? [0, 0, 0] : a)
  const lb = luminance(typeof b === 'string' ? parse(b) ?? [0, 0, 0] : b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** How far apart two hues are, in degrees (0 to 180). */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

// --- The palette ---

const HUE_BINS = 24
/** Under this share of coloured pixels, a cover counts as black and white. */
const MIN_COLOURED = 0.06
/** The accent must cover at least this much of the cover: a speck of colour is not its colour. */
const MIN_ACCENT = 0.02
/** A second colour must cover this much, and be this far in hue from the base. */
const MIN_SECOND = 0.05
const SECOND_HUE_GAP = 45
/** Another colour takes the controls only if it is this colourful (saturation times brightness, on average). */
const OTHER_ACCENT_VIVID = 0.35

interface Bin {
  count: number
  weight: number
  r: number
  g: number
  b: number
  vivid: number
}

/**
 * The palette of a cover from its pixels (r, g, b, r, g, b, ...: a small copy, 32 by 32 is plenty). Coloured pixels
 * are grouped by hue; the base is the group that is both large and colourful, the accent the most vivid group that is
 * not a speck, the second colour the strongest group well away from the base in hue. Pixels too grey or too dark to
 * have a hue only count towards "this cover is black and white". Null for no pixels.
 */
export function paletteFrom(pixels: ArrayLike<number>): Palette | null {
  const total = Math.floor(pixels.length / 3)
  if (total === 0) return null
  const bins: Bin[] = Array.from({ length: HUE_BINS }, () => ({ count: 0, weight: 0, r: 0, g: 0, b: 0, vivid: 0 }))
  let coloured = 0
  let greySum: Rgb = [0, 0, 0]
  for (let i = 0; i + 2 < pixels.length; i += 3) {
    const rgb: Rgb = [pixels[i], pixels[i + 1], pixels[i + 2]]
    const max = Math.max(...rgb) / 255
    const min = Math.min(...rgb) / 255
    // HSV: how coloured (saturation) and how bright (value) the pixel is.
    const value = max
    const saturation = max === 0 ? 0 : (max - min) / max
    if (saturation < 0.2 || value < 0.15) {
      greySum = [greySum[0] + rgb[0], greySum[1] + rgb[1], greySum[2] + rgb[2]]
      continue
    }
    coloured++
    const [h] = toHsl(rgb)
    const bin = bins[Math.floor(h / (360 / HUE_BINS)) % HUE_BINS]
    const w = 0.05 + saturation * value
    bin.count++
    bin.weight += w
    bin.r += rgb[0] * w
    bin.g += rgb[1] * w
    bin.b += rgb[2] * w
    bin.vivid += saturation * value
  }

  const grey: Rgb = [greySum[0] / Math.max(1, total - coloured), greySum[1] / Math.max(1, total - coloured), greySum[2] / Math.max(1, total - coloured)]

  // Each hue with its two neighbours: one colour often straddles two bins.
  const groups = bins.map((_, i) => {
    const near = [bins[(i + HUE_BINS - 1) % HUE_BINS], bins[i], bins[(i + 1) % HUE_BINS]]
    const count = near.reduce((n, b) => n + b.count, 0)
    const weight = near.reduce((n, b) => n + b.weight, 0)
    const rgb: Rgb = weight > 0 ? [near.reduce((n, b) => n + b.r, 0) / weight, near.reduce((n, b) => n + b.g, 0) / weight, near.reduce((n, b) => n + b.b, 0) / weight] : [0, 0, 0]
    return { share: count / total, vivid: count > 0 ? near.reduce((n, b) => n + b.vivid, 0) / count : 0, rgb, hue: toHsl(rgb)[0] }
  })

  type Group = (typeof groups)[number]
  const striking = (g: Group): number => g.vivid * Math.sqrt(g.share)
  const mostStriking = (list: Group[]): Group | null => list.reduce<Group | null>((best, g) => (!best || striking(g) > striking(best) ? g : best), null)
  const accentGroup = mostStriking(groups.filter((g) => g.share >= MIN_ACCENT))

  if (coloured / total < MIN_COLOURED) {
    return { base: grey, accent: accentGroup ? accentGroup.rgb : null, second: null, grey: true }
  }

  const score = (g: Group): number => g.share * (0.25 + g.vivid)
  const base = groups.reduce((best, g) => (score(g) > score(best) ? g : best))
  const second = groups
    .filter((g) => g.share >= MIN_SECOND && hueDistance(g.hue, base.hue) >= SECOND_HUE_GAP)
    .reduce<Group | null>((best, g) => (!best || score(g) > score(best) ? g : best), null)
  // The controls stand out in another of the cover's colours when it has a colourful one (a yellow sun on a teal
  // sky makes yellow buttons on teal), and in its own colour otherwise.
  const other = mostStriking(groups.filter((g) => g.share >= MIN_ACCENT && g.vivid >= OTHER_ACCENT_VIVID && hueDistance(g.hue, base.hue) >= SECOND_HUE_GAP))
  const accent = other ?? accentGroup ?? base

  return { base: base.rgb, accent: accent.rgb, second: second ? second.rgb : null, grey: false }
}

/** A palette from the one colour older builds give ("#rrggbb"): no second colour, the accent is the base itself. */
export function paletteFromColor(hex: string | null): Palette | null {
  const rgb = hex ? parse(hex) : null
  if (!rgb) return null
  const grey = toHsl(rgb)[1] < 0.1
  return { base: rgb, accent: grey ? null : rgb, second: null, grey }
}

// --- The screen's colours ---

/** The top of the backdrop is never brighter than this (relative luminance): white text and the controls need room. */
const MAX_TOP_LUMINANCE = 0.1

/**
 * Turns a palette into the screen's colours. The hues are the cover's; the saturation is held in a band (a cover's own
 * varies far more than a background should) and the lightness is set: a dark gradient white text reads on, a lyrics
 * card lifted just far enough to stay readable, and an accent bright enough to stand out against the backdrop. A black
 * and white cover gets greys and white controls. No palette: the app's own colours.
 */
export function lookFor(palette: Palette | null): Look {
  if (!palette) return PLAIN_LOOK
  const [h, s] = toHsl(palette.base)
  const sat = palette.grey ? 0 : Math.min(0.75, Math.max(0.3, s))

  let cardLightness = 0.38
  let card = fromHsl(h, sat * 0.8, cardLightness)
  while (contrast(card, [255, 255, 255]) < 4.6 && cardLightness > 0.14) {
    cardLightness -= 0.02
    card = fromHsl(h, sat * 0.8, cardLightness)
  }

  // Yellows and greens are bright at any lightness: those go darker, so the title and the controls still stand out.
  let topLightness = 0.3
  let top = fromHsl(h, sat * 0.9, topLightness)
  while (luminance(top) > MAX_TOP_LUMINANCE && topLightness > 0.16) {
    topLightness -= 0.02
    top = fromHsl(h, sat * 0.9, topLightness)
  }

  let glow: string | null = null
  if (palette.second && !palette.grey) {
    const [h2, s2] = toHsl(palette.second)
    glow = toHex(fromHsl(h2, Math.min(0.8, Math.max(0.35, s2)), 0.42))
  }

  let accent: Rgb
  if (palette.accent && toHsl(palette.accent)[1] >= 0.15) {
    const [ha, sa] = toHsl(palette.accent)
    const saturation = Math.min(0.95, Math.max(0.5, sa))
    let lightness = 0.6
    accent = fromHsl(ha, saturation, lightness)
    // It must stand out against the top of the backdrop (3:1, as for any control, with a little to spare for the
    // rounding to #rrggbb), whatever the hue.
    while (contrast(accent, top) < 3.1 && lightness < 0.85) {
      lightness += 0.03
      accent = fromHsl(ha, saturation, lightness)
    }
  } else {
    accent = [242, 242, 242]
  }
  const onAccent = contrast(accent, [0, 0, 0]) >= contrast(accent, [255, 255, 255]) ? '#000000' : '#ffffff'

  return {
    top: toHex(top),
    middle: toHex(fromHsl(h, sat * 0.75, 0.16)),
    bottom: toHex(fromHsl(h, sat * 0.6, 0.075)),
    glow,
    card: toHex(card),
    accent: toHex(accent),
    onAccent
  }
}

// --- Reading a cover ---

/** The side of the cover's copy the palette is read from. */
const SAMPLE_SIDE = 32

const known = new Map<string, Palette>()

export function cachedPalette(url: string): Palette | null {
  return known.get(url) ?? null
}

/**
 * The palette of the cover at `url`, or null when there is none to be had: the native side is missing (Expo Go), or
 * the cover couldn't be downloaded. The native side reuses the cover the Now Bar already fetched for the same URL, so
 * this rarely costs a second download. A build that can only give the cover's main colour gets a palette of that one.
 */
export async function coverPalette(url: string): Promise<Palette | null> {
  const cached = known.get(url)
  if (cached) return cached
  let palette: Palette | null = null
  try {
    if (SelfHostNative?.getCoverPixels) {
      const pixels = await SelfHostNative.getCoverPixels(url, SAMPLE_SIDE)
      palette = pixels ? paletteFrom(pixels) : null
    } else if (SelfHostNative?.getCoverColor) {
      palette = paletteFromColor(await SelfHostNative.getCoverColor(url))
    }
  } catch {
    palette = null
  }
  if (palette) known.set(url, palette)
  return palette
}
