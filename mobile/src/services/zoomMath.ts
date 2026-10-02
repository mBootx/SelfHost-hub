/**
 * The arithmetic behind zooming a picture with two fingers or a double tap. Pure functions, kept apart from
 * the gesture code so they can be checked on their own. They are marked as worklets because the gestures
 * run on the UI thread, where plain functions of this file would not exist.
 *
 * Positions are measured from the centre of the box the picture is shown in. A picture drawn with
 * `translate(offset)` then `scale(s)` puts the content point `p` (from the same centre) at `offset + s * p`.
 */
export const MIN_SCALE = 1
export const MAX_SCALE = 5
/** What a double tap zooms to. */
export const DOUBLE_TAP_SCALE = 2.5
/** Below this, the picture counts as not zoomed (the pager may scroll again). */
export const ZOOMED_THRESHOLD = 1.02

export interface Size {
  width: number
  height: number
}

export function clamp(value: number, low: number, high: number): number {
  'worklet'
  // "+ 0" turns a negative zero (a clamp to a zero-wide range) into a plain zero.
  return Math.min(high, Math.max(low, value)) + 0
}

/** How a picture of the `natural` size is laid out when fitted whole into `box` ("contain"). Unknown size: the box itself. */
export function fitSize(natural: Size | null, box: Size): Size {
  'worklet'
  if (!natural || !(natural.width > 0) || !(natural.height > 0)) return { width: box.width, height: box.height }
  const ratio = Math.min(box.width / natural.width, box.height / natural.height)
  return { width: natural.width * ratio, height: natural.height * ratio }
}

/** How far the content may be moved from the centre, either way, on one axis: it can't be dragged off so far that the box shows a gap. */
export function maxOffset(content: number, scale: number, box: number): number {
  'worklet'
  return Math.max(0, (content * scale - box) / 2)
}

/**
 * The offset that carries the content point that was under `start` (when the scale was `from`, at `offset`)
 * to `now` once the scale is `to`: zooming around the first position of the fingers, and following them as they move.
 */
export function offsetAfterZoom(start: number, now: number, offset: number, from: number, to: number): number {
  'worklet'
  if (!(from > 0)) return 0
  return now - (to / from) * (start - offset)
}

/** The scale a double tap goes to: zoomed in, back to fit; fit, in. */
export function doubleTapScale(scale: number): number {
  'worklet'
  return scale > ZOOMED_THRESHOLD ? MIN_SCALE : DOUBLE_TAP_SCALE
}

export interface View {
  scale: number
  x: number
  y: number
}

export interface Point {
  x: number
  y: number
}

/**
 * The view after a pinch: `start` is the view when the pinch began, `factor` how much the fingers have spread
 * since, `from` the middle of the fingers then and `now` the middle of them now. The scale stays within bounds
 * and the picture within the box.
 */
export function pinchTo(start: View, factor: number, from: Point, now: Point, shown: Size, box: Size): View {
  'worklet'
  const scale = clamp(start.scale * factor, MIN_SCALE, MAX_SCALE)
  const x = offsetAfterZoom(from.x, now.x, start.x, start.scale, scale)
  const y = offsetAfterZoom(from.y, now.y, start.y, start.scale, scale)
  const limitX = maxOffset(shown.width, scale, box.width)
  const limitY = maxOffset(shown.height, scale, box.height)
  return { scale, x: clamp(x, -limitX, limitX), y: clamp(y, -limitY, limitY) }
}

/** The view after dragging by (dx, dy) from `start`. */
export function panTo(start: View, dx: number, dy: number, shown: Size, box: Size): View {
  'worklet'
  const limitX = maxOffset(shown.width, start.scale, box.width)
  const limitY = maxOffset(shown.height, start.scale, box.height)
  return { scale: start.scale, x: clamp(start.x + dx, -limitX, limitX), y: clamp(start.y + dy, -limitY, limitY) }
}

/** The view a double tap at (tapX, tapY) goes to. */
export function doubleTapTo(current: View, tapX: number, tapY: number, shown: Size, box: Size): View {
  'worklet'
  const scale = doubleTapScale(current.scale)
  if (scale === MIN_SCALE) return { scale, x: 0, y: 0 }
  const tap = { x: tapX, y: tapY }
  return pinchTo(current, scale / current.scale, tap, tap, shown, box)
}
