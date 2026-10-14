/**
 * The arithmetic of a list reordered by dragging (components/DragList.tsx), kept apart so it can be checked in plain
 * Node. Every function is a worklet: it runs on the UI thread while the finger moves.
 */

/** Which slot a row dragged from `start` is over once its top has moved by `offset` pixels. */
export function slotAt(start: number, offset: number, rowHeight: number, count: number): number {
  'worklet'
  const slot = Math.round(start + offset / rowHeight)
  return Math.max(0, Math.min(count - 1, slot))
}

/** The slot of every row once the row `key` has moved to `to`: those in between close the gap it left. */
export function moveSlot(positions: Record<string, number>, key: string, to: number): Record<string, number> {
  'worklet'
  const from = positions[key]
  if (from === undefined || from === to) return positions
  const next: Record<string, number> = {}
  for (const k of Object.keys(positions)) {
    const p = positions[k]
    if (k === key) next[k] = to
    else if (from < to && p > from && p <= to) next[k] = p - 1
    else if (from > to && p >= to && p < from) next[k] = p + 1
    else next[k] = p
  }
  return next
}

/**
 * How fast the list scrolls on its own (pixels a frame, negative upwards) with the finger at `y` in a list whose top is
 * at `top` and which is `height` high: nothing in the middle, faster the closer to an edge.
 */
export function edgeSpeed(y: number, top: number, height: number, zone = 72, max = 14): number {
  'worklet'
  if (height <= 0) return 0
  const fromTop = y - top
  const fromBottom = top + height - y
  if (fromTop < zone) return -Math.ceil(max * Math.min(1, (zone - fromTop) / zone))
  if (fromBottom < zone) return Math.ceil(max * Math.min(1, (zone - fromBottom) / zone))
  return 0
}

/** Keys for rows whose items may repeat (the same song twice in a queue): the id, and which time it appears. */
export function occurrenceKeys(ids: string[]): string[] {
  const seen = new Map<string, number>()
  return ids.map((id) => {
    const n = seen.get(id) ?? 0
    seen.set(id, n + 1)
    return `${id}#${n}`
  })
}

/** A swipe across the mini player: far or fast enough to the left is the next song, to the right the one before. */
export function swipeSkip(translationX: number, velocityX: number): 'next' | 'prev' | null {
  'worklet'
  if (translationX < -70 || (translationX < -24 && velocityX < -700)) return 'next'
  if (translationX > 70 || (translationX > 24 && velocityX > 700)) return 'prev'
  return null
}
