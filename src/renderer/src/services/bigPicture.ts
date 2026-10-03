import type { LyricLine } from './lyrics'

/**
 * The logic behind the full-screen player ("Big Picture"): where the playhead is between two reports, how far along
 * the sung line is, how a lyric line looks by its distance from the sung one, which colour the cover is. Kept apart
 * from the components so it can be checked without a screen (mobile/tests/bigpicture.test.js).
 */

// --- The playhead ---

/** The last position a player reported, and when it did (`at` is a clock in milliseconds, any clock). */
export interface PlayheadBase {
  time: number
  at: number
  playing: boolean
  rate: number
}

/**
 * Where the song is now. Players report their position a few times a second (a remote device, about once a second):
 * between two reports it is moved along by the clock, so that lyrics and the progress bar run smoothly. Never past the end.
 */
export function estimatePosition(base: PlayheadBase, now: number, duration: number): number {
  const elapsed = base.playing ? Math.max(0, now - base.at) / 1000 : 0
  const time = base.time + elapsed * (base.rate > 0 ? base.rate : 1)
  const end = duration > 0 ? duration : Infinity
  return Math.min(Math.max(time, 0), end)
}

// --- Lyrics ---

const MIN_SUNG_SECONDS = 1.2
const SECONDS_PER_WORD = 0.42

/** The words of a line, as they are lit one after the other. */
export function wordsOf(text: string): string[] {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/) : []
}

/**
 * How far along the sung line is, from 0 to 1. A line is taken to be sung over about as long as it takes to say its
 * words, and never over longer than the time to the next line: after a long instrumental break the line is done
 * long before the next one starts, not at that moment.
 */
export function lineProgress(lines: LyricLine[], index: number, time: number): number {
  const line = lines[index]
  if (!line || !line.text.trim()) return 0
  const next = lines[index + 1]?.time
  const natural = Math.max(MIN_SUNG_SECONDS, wordsOf(line.text).length * SECONDS_PER_WORD)
  const sung = Math.max(0.3, next === undefined ? natural : Math.min(natural, next - line.time))
  return Math.min(1, Math.max(0, (time - line.time) / sung))
}

/** How many of `total` words are lit at that progress: the first as soon as the line starts, all of them at the end. */
export function litWords(total: number, progress: number): number {
  if (total <= 0 || progress <= 0) return 0
  return Math.min(total, Math.ceil(progress * total))
}

/** Whether the sung "line" is an instrumental break: a blank line, which the screen shows as three breathing dots. */
export function isBreak(lines: LyricLine[], index: number): boolean {
  const line = lines[index]
  return !!line && !line.text.trim()
}

export interface RowLook {
  opacity: number
  /** In pixels. */
  blur: number
  scale: number
}

/**
 * How a lyric line looks by its distance from the sung one (negative: already sung). The sung line is sharp and
 * full size; the others shrink, dim and blur the farther they are, the ones still to come a little brighter than the
 * ones behind.
 */
export function rowLook(distance: number): RowLook {
  if (distance === 0) return { opacity: 1, blur: 0, scale: 1 }
  const d = Math.abs(distance)
  const base = distance < 0 ? 0.4 : 0.62
  return {
    opacity: Math.max(0.08, base - 0.13 * (d - 1)),
    blur: Math.min(5, 0.9 + 0.8 * d),
    scale: Math.max(0.78, 0.92 - 0.02 * d)
  }
}

/** The vertical shift that puts a row's middle at `anchor` (0 to 1) of the way down the viewport. */
export function scrollOffset(viewportHeight: number, rowTop: number, rowHeight: number, anchor = 0.4): number {
  return viewportHeight * anchor - (rowTop + rowHeight / 2)
}

// --- The controls ---

/** The bar and the cursor are shown while something happened lately, or while one is held on (a menu, a drag). */
export function controlsVisible(now: number, lastActivity: number, hideAfterMs: number, held: boolean): boolean {
  return held || now - lastActivity < hideAfterMs
}

export function formatClock(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** The time of day, "14:05": the screen is a big one, and shows what a clock on the wall would. */
export function formatTimeOfDay(date: Date): string {
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
}

// --- The cover's colour ---

export type Rgb = [number, number, number]

/**
 * The colour a cover is "about": a histogram of 4 bits per channel in which a vivid pixel counts for much more than a
 * grey one, black and white barely count, and the heaviest bucket gives the colour (the average of what fell in it).
 * `pixels` is RGBA, as a canvas gives it. Null when the cover has no colour to speak of (greys, or nothing).
 */
export function dominantColor(pixels: ArrayLike<number>): Rgb | null {
  const weight = new Float64Array(4096)
  const sums = new Float64Array(4096 * 3)
  let total = 0
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue
    const r = pixels[i]
    const g = pixels[i + 1]
    const b = pixels[i + 2]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    if (max < 28 || min > 235) continue
    const vivid = (max - min) / 255
    const w = 0.02 + vivid * vivid
    const bucket = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    weight[bucket] += w
    sums[bucket * 3] += r * w
    sums[bucket * 3 + 1] += g * w
    sums[bucket * 3 + 2] += b * w
    total += w
  }
  if (total === 0) return null
  let best = 0
  for (let bucket = 1; bucket < 4096; bucket++) if (weight[bucket] > weight[best]) best = bucket
  if (weight[best] === 0) return null
  const color: Rgb = [Math.round(sums[best * 3] / weight[best]), Math.round(sums[best * 3 + 1] / weight[best]), Math.round(sums[best * 3 + 2] / weight[best])]
  // Greys: nothing to tint with.
  return Math.max(...color) - Math.min(...color) < 24 ? null : color
}

function luminance([r, g, b]: Rgb): number {
  const channel = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/**
 * The colour lifted until it shines on a dark background (a glow, a highlight): its hue is kept and it is mixed
 * with white until its luminance reaches `minimum`.
 */
export function lifted(color: Rgb, minimum = 0.22): Rgb {
  let current = color
  for (let i = 0; i < 12 && luminance(current) < minimum; i++) {
    current = current.map((c) => Math.round(c + (255 - c) * 0.1)) as Rgb
  }
  return current
}

/** The colour pulled down towards black, for the dark side of the backdrop. */
export function darkened(color: Rgb, amount = 0.72): Rgb {
  return color.map((c) => Math.round(c * (1 - amount))) as Rgb
}
