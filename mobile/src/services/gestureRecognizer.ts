/**
 * Hand gestures for the car mode, read from the points MediaPipe's hand landmarker finds in each camera frame
 * (HandTracker.kt sends them; app/car-mode.tsx acts on what this says). Kept free of React Native so it can be checked
 * frame by frame in Node (tests/gestures.test.js), against real hands MediaPipe measured as well as made-up ones.
 *
 * The 21 points of a hand: 0 the wrist; 1-4 the thumb (base to tip); 5-8 the index (knuckle, two joints, tip); 9-12 the
 * middle finger; 13-16 the ring finger; 17-20 the little finger. x and y go from 0 to 1 across the picture, which is
 * upright and mirrored: x grows towards the driver's right, y downwards.
 *
 * - PINCH (thumb and index tips together, held 200 ms): play / pause. Once per pinch: the fingers must open again.
 * - WAVE_RIGHT / WAVE_LEFT (an OPEN hand crosses part of the picture within half a second): next / previous track.
 * - PALM_UP / PALM_DOWN (an OPEN hand sweeps up or down the picture within half a second): volume up / down, one step
 *   a sweep. A movement, not a place: a hand resting high or low in the picture (on the wheel, waiting) is nothing.
 * - THUMB_UP (thumb up, other fingers folded, held 400 ms): like the song. Once per gesture.
 *
 * Distances that describe the hand's shape are counted in hand sizes (wrist to the middle finger's knuckle), so a hand
 * close to the camera and one at arm's length look the same.
 */

export type GestureName = 'PINCH' | 'WAVE_LEFT' | 'WAVE_RIGHT' | 'PALM_UP' | 'PALM_DOWN' | 'THUMB_UP'

export const GESTURES: GestureName[] = ['PINCH', 'WAVE_RIGHT', 'WAVE_LEFT', 'PALM_UP', 'PALM_DOWN', 'THUMB_UP']

export interface HandObservation {
  /** How sure the landmarker is about the hand, 0 to 1. */
  score: number
  /** 21 points, x, y, z each (63 numbers). */
  points: number[]
}

export interface HandFrame {
  /** Milliseconds, on a clock that only goes forward. */
  t: number
  /** The picture's size: x and y are fractions of different lengths, which the hand's shape must not depend on. */
  width: number
  height: number
  hands: HandObservation[]
}

export interface GestureThresholds {
  /** The gap between the thumb's and the index's tips under which they pinch, in hand sizes. */
  pinchDistance: number
  /** How far the wrist must cross the picture for a wave, as a share of its width. */
  swipeMinDistance: number
  /** The share of a wave's frames in which the hand must be seen (a hand that just came in is not a wave). */
  swipeConfidenceThreshold: number
}

export const DEFAULT_THRESHOLDS: GestureThresholds = { pinchDistance: 0.3, swipeMinDistance: 0.3, swipeConfidenceThreshold: 0.7 }

export const DEFAULT_SENSITIVITY = 0.5

/**
 * The thresholds for a sensitivity from 0 (strict: wide gestures only) to 1 (loose: small ones do). The middle gives the
 * defaults.
 */
export function thresholdsFor(sensitivity: number): GestureThresholds {
  const s = Math.min(1, Math.max(0, Number.isFinite(sensitivity) ? sensitivity : DEFAULT_SENSITIVITY))
  const factor = 0.6 + 0.8 * s
  const round = (n: number): number => Math.round(n * 1000) / 1000
  return {
    pinchDistance: round(DEFAULT_THRESHOLDS.pinchDistance * factor),
    swipeMinDistance: round(DEFAULT_THRESHOLDS.swipeMinDistance / factor),
    swipeConfidenceThreshold: round(Math.min(0.85, Math.max(0.5, DEFAULT_THRESHOLDS.swipeConfidenceThreshold - 0.3 * (s - 0.5))))
  }
}

export interface RecognizerOptions {
  thresholds: GestureThresholds
  /** Gestures turned off in the settings never fire. */
  enabled: Record<GestureName, boolean>
}

export interface GestureEvent {
  gesture: GestureName
  /** 0 to 1: how sure the landmarker was of the hand, and for a wave how steadily it was seen. */
  confidence: number
  /** Always false now (the volume no longer repeats while a hand is held: it takes a sweep a step); kept for the callers. */
  repeat: boolean
}

export type HandPose = 'pinch' | 'thumbUp' | 'openPalm' | 'other'

/** What the recognizer makes of the hand right now, for the test mode. */
export interface RecognizerState {
  present: boolean
  pose: HandPose | null
  /** The thumb-to-index gap in hand sizes. */
  pinchGap: number | null
  /** Where the wrist is, 0 to 1. */
  x: number | null
  y: number | null
  score: number
}

// --- Timing ---

/** Below this the landmarker is guessing (a steering wheel, a sleeve): the hand is ignored. */
export const MIN_SCORE = 0.6
/** Points are averaged over this many frames, which steadies the jitter of a hand held still. */
const SMOOTHING_FRAMES = 5
/** A hand unseen for longer is gone: whatever it was doing starts over. */
const LOST_AFTER_MS = 300
const PINCH_HOLD_MS = 200
/** The fingers must open past the pinch gap times this, for this long, before the next pinch counts. */
const PINCH_RELEASE = 1.6
const RELEASE_MS = 100
const THUMB_HOLD_MS = 400
/**
 * The thumb must be down this long before the next thumb up counts. Longer than the pinch's: the smoothing stretches a
 * thumb lost for two frames into some 170 ms without one, which must not like the song a second time.
 */
const THUMB_RELEASE_MS = 300
const WAVE_WINDOW_MS = 500
/** A wave that went one way locks the other way out for this long: bringing the hand back is not a wave back. */
const OPPOSITE_WAVE_LOCK_MS = 1200
/** Of the frames of a wave or a sweep, this share must show an open hand: hands gripping a wheel, turning it, are not waving. */
const OPEN_SHARE = 0.6
/** A sweep up or down needs this share of the distance a wave needs (the picture is shorter than it is wide, and arms rise less than they cross). */
const VERTICAL_SHARE = 0.8
/** After a gesture nothing else fires for this long (the hand is still finishing the first one). */
const COOLDOWN_MS = 600

// --- The hand's shape ---

const WRIST = 0
const THUMB_MCP = 2
const THUMB_TIP = 4
const INDEX_MCP = 5
const INDEX_TIP = 8
const MIDDLE_MCP = 9
const FINGERS: [number, number][] = [
  [5, 8],
  [9, 12],
  [13, 16],
  [17, 20]
]
/** A finger whose tip is farther from the wrist than its knuckle by this much is stretched out... */
const EXTENDED = 1.5
/** ...and one whose tip comes back under this is folded. */
const FOLDED = 1.15
/**
 * What tells a pinch from a fist, which also brings the thumb's tip against the index (a real fist measured 0.85 for the
 * index; a pinch, whose index bends over to meet the thumb, 1.0 to 1.4: the tips meet about one hand size from the
 * wrist, and the knuckle is at about 0.95). An index under this is curled into a fist...
 */
const PINCH_MIN_REACH = 0.97
/** ...and so is one under this when the three other fingers are all folded too (a grip on a wheel). */
const GRIP_REACH = 1.1
const OTHERS_FOLDED = 1.0

type Point = [number, number]

/** Point i, with x scaled so that x and y are the same length (both in picture heights). */
function point(points: number[], i: number, aspect: number): Point {
  return [points[i * 3] * aspect, points[i * 3 + 1]]
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

interface Shape {
  pose: HandPose
  pinchGap: number
  /** At least three fingers stretched out, whichever way the hand points: what a wave or a sweep is made with. */
  open: boolean
}

/** What a hand is doing, from its (smoothed) points. Exported for the tests: the real hands MediaPipe measured. */
export function handShape(points: number[], aspect: number, pinchDistance = DEFAULT_THRESHOLDS.pinchDistance): Shape {
  const p = (i: number): Point => point(points, i, aspect)
  const wrist = p(WRIST)
  const size = distance(wrist, p(MIDDLE_MCP)) || 1e-6
  const reach = FINGERS.map(([knuckle, tip]) => distance(wrist, p(tip)) / (distance(wrist, p(knuckle)) || 1e-6))
  const extended = reach.filter((r) => r > EXTENDED).length
  const folded = reach.filter((r) => r < FOLDED).length
  const pinchGap = distance(p(THUMB_TIP), p(INDEX_TIP)) / size
  const open = extended >= 3

  // A fist also brings the thumb's tip against the index: in a pinch the index reaches out to meet it, or bends over to.
  const indexReach = reach[0]
  const othersFolded = reach.slice(1).every((r) => r < OTHERS_FOLDED)
  const fist = indexReach < PINCH_MIN_REACH || (othersFolded && indexReach < GRIP_REACH)
  if (pinchGap < pinchDistance && !fist) return { pose: 'pinch', pinchGap, open }

  const thumbTip = p(THUMB_TIP)
  const thumbBase = p(THUMB_MCP)
  const thumbLength = distance(thumbBase, thumbTip) || 1e-6
  const thumbUpward = (thumbBase[1] - thumbTip[1]) / thumbLength
  const thumbOut = distance(thumbTip, p(INDEX_MCP)) / size
  const thumbAboveFingers = FINGERS.every(([, tip]) => p(tip)[1] > thumbTip[1])
  if (folded === 4 && thumbOut > 0.6 && thumbUpward > 0.7 && thumbAboveFingers) return { pose: 'thumbUp', pinchGap, open }

  // Fingers up: the middle finger's tip well above the wrist.
  const fingersUp = (wrist[1] - p(12)[1]) / size > 1.2
  if (extended === 4 && fingersUp) return { pose: 'openPalm', pinchGap, open }

  return { pose: 'other', pinchGap, open }
}

interface Sample {
  t: number
  present: boolean
  /** The wrist as seen in this frame: a wave is judged on it, smoothing would only make it late. */
  x: number
  y: number
  /** The hand had at least three fingers stretched out. */
  open: boolean
}

export interface GestureRecognizer {
  /** One camera frame in; at most one gesture out. */
  push(frame: HandFrame): GestureEvent | null
  /** What it makes of the hand right now. */
  state(): RecognizerState
  setOptions(options: RecognizerOptions): void
  /** Forgets everything (the camera stopped, the car mode was left). */
  reset(): void
}

export function createGestureRecognizer(initial: RecognizerOptions): GestureRecognizer {
  let options = initial
  // The hand followed: its last raw points and when it was seen.
  let recent: number[][] = []
  let scores: number[] = []
  let lastSeenAt = -Infinity
  let lastWrist: Point | null = null
  let history: Sample[] = []
  let current: RecognizerState = { present: false, pose: null, pinchGap: null, x: null, y: null, score: 0 }

  let blockedUntil = -Infinity
  let rightLockedUntil = -Infinity
  let leftLockedUntil = -Infinity
  let pinchSince: number | null = null
  let pinchArmed = true
  let releaseSince: number | null = null
  let thumbSince: number | null = null
  let thumbOffSince: number | null = null
  let thumbArmed = true
  let upLockedUntil = -Infinity
  let downLockedUntil = -Infinity

  function forgetPoses(): void {
    pinchSince = null
    releaseSince = null
    thumbSince = null
    thumbOffSince = null
  }

  function reset(): void {
    recent = []
    scores = []
    lastSeenAt = -Infinity
    lastWrist = null
    history = []
    current = { present: false, pose: null, pinchGap: null, x: null, y: null, score: 0 }
    blockedUntil = -Infinity
    rightLockedUntil = -Infinity
    leftLockedUntil = -Infinity
    upLockedUntil = -Infinity
    downLockedUntil = -Infinity
    pinchArmed = true
    thumbArmed = true
    forgetPoses()
  }

  /** The hand to follow: the one nearest where the followed hand was, or else the biggest (the nearest the camera). */
  function choose(frame: HandFrame, aspect: number): HandObservation | null {
    const candidates = frame.hands.filter((h) => h.score >= MIN_SCORE && Array.isArray(h.points) && h.points.length >= 63)
    if (candidates.length === 0) return null
    if (lastWrist && frame.t - lastSeenAt <= LOST_AFTER_MS) {
      const from = lastWrist
      return candidates.reduce((best, h) => (distance(point(h.points, WRIST, aspect), from) < distance(point(best.points, WRIST, aspect), from) ? h : best))
    }
    const size = (h: HandObservation): number => distance(point(h.points, WRIST, aspect), point(h.points, MIDDLE_MCP, aspect))
    return candidates.reduce((best, h) => (size(h) > size(best) ? h : best))
  }

  function fire(gesture: GestureName, t: number, confidence: number, repeat = false): GestureEvent | null {
    if (!options.enabled[gesture]) return null
    if (!repeat) blockedUntil = t + COOLDOWN_MS
    return { gesture, confidence: Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100, repeat }
  }

  function push(frame: HandFrame): GestureEvent | null {
    const t = frame.t
    const aspect = frame.width > 0 && frame.height > 0 ? frame.width / frame.height : 1
    const hand = choose(frame, aspect)

    if (!hand) {
      history.push({ t, present: false, x: 0, y: 0, open: false })
      trimHistory(t)
      if (t - lastSeenAt > LOST_AFTER_MS) {
        // Gone: the next hand starts afresh, and may pinch or give a thumb again.
        recent = []
        scores = []
        lastWrist = null
        pinchArmed = true
        thumbArmed = true
        forgetPoses()
      }
      current = { present: false, pose: null, pinchGap: null, x: null, y: null, score: 0 }
      return null
    }

    if (t - lastSeenAt > LOST_AFTER_MS) {
      recent = []
      scores = []
    }
    lastSeenAt = t
    lastWrist = point(hand.points, WRIST, aspect)
    recent.push(hand.points)
    scores.push(hand.score)
    if (recent.length > SMOOTHING_FRAMES) recent.shift()
    if (scores.length > SMOOTHING_FRAMES) scores.shift()
    const smoothed = average(recent)
    const score = scores.reduce((a, b) => a + b, 0) / scores.length

    const { pinchDistance, swipeMinDistance, swipeConfidenceThreshold } = options.thresholds
    const shape = handShape(smoothed, aspect, pinchDistance)
    const x = smoothed[WRIST * 3]
    const y = smoothed[WRIST * 3 + 1]
    history.push({ t, present: true, x: hand.points[WRIST * 3], y: hand.points[WRIST * 3 + 1], open: shape.open })
    trimHistory(t)
    current = { present: true, pose: shape.pose, pinchGap: shape.pinchGap, x, y, score }

    // Re-arming happens whatever else is going on, so a gesture held through the cooldown still has to end first.
    if (shape.pose === 'pinch') {
      releaseSince = null
      if (pinchSince === null) pinchSince = t
    } else if (shape.pinchGap > pinchDistance * PINCH_RELEASE) {
      pinchSince = null
      if (releaseSince === null) releaseSince = t
      if (t - releaseSince >= RELEASE_MS) pinchArmed = true
    } else {
      // Loosened a little, not opened: the pinch goes on (its hold too), and does not count as a new one.
      releaseSince = null
    }
    if (shape.pose === 'thumbUp') {
      thumbOffSince = null
      if (thumbSince === null) thumbSince = t
    } else {
      thumbSince = null
      if (thumbOffSince === null) thumbOffSince = t
      if (t - thumbOffSince >= THUMB_RELEASE_MS) thumbArmed = true
    }
    if (t < blockedUntil) return null

    // A wave or a sweep: the wrist crossed far enough within the window, seen in enough of its frames, the hand open.
    const sweep = sweepIn(aspect, swipeMinDistance, swipeConfidenceThreshold)
    if (sweep) {
      const locks = { right: rightLockedUntil, left: leftLockedUntil, up: upLockedUntil, down: downLockedUntil }
      if (t >= locks[sweep.direction]) {
        // Bringing the hand back is not a movement the other way.
        if (sweep.direction === 'right') leftLockedUntil = t + OPPOSITE_WAVE_LOCK_MS
        else if (sweep.direction === 'left') rightLockedUntil = t + OPPOSITE_WAVE_LOCK_MS
        else if (sweep.direction === 'up') downLockedUntil = t + OPPOSITE_WAVE_LOCK_MS
        else upLockedUntil = t + OPPOSITE_WAVE_LOCK_MS
        history = [history[history.length - 1]]
        forgetPoses()
        const gesture: GestureName = { right: 'WAVE_RIGHT', left: 'WAVE_LEFT', up: 'PALM_UP', down: 'PALM_DOWN' }[sweep.direction] as GestureName
        return fire(gesture, t, Math.min(score, sweep.seen))
      }
    }

    if (pinchSince !== null && pinchArmed && t - pinchSince >= PINCH_HOLD_MS) {
      pinchArmed = false
      return fire('PINCH', t, score)
    }
    if (thumbSince !== null && thumbArmed && t - thumbSince >= THUMB_HOLD_MS) {
      thumbArmed = false
      return fire('THUMB_UP', t, score)
    }
    return null
  }

  function trimHistory(t: number): void {
    while (history.length > 0 && history[0].t < t - WAVE_WINDOW_MS) history.shift()
  }

  function sweepIn(aspect: number, minDistance: number, minSeen: number): { direction: 'left' | 'right' | 'up' | 'down'; seen: number } | null {
    if (history.length < 3) return null
    const present = history.filter((s) => s.present)
    const seen = present.length / history.length
    if (seen < minSeen) return null
    // Hands gripping or turning a wheel, a fist, a pointing finger: only an open hand waves.
    if (present.filter((s) => s.open).length / present.length < OPEN_SHARE) return null
    const now = history[history.length - 1]
    if (!now.present) return null
    let left: Sample | null = null
    let right: Sample | null = null
    let top: Sample | null = null
    let bottom: Sample | null = null
    for (const s of present) {
      if (!left || s.x < left.x) left = s
      if (!right || s.x > right.x) right = s
      if (!top || s.y < top.y) top = s
      if (!bottom || s.y > bottom.y) bottom = s
    }
    // Mostly sideways: a hand raised or lowered across the picture is not a wave.
    if (left && now.x - left.x >= minDistance && Math.abs(now.y - left.y) < (now.x - left.x) * 0.7) return { direction: 'right', seen }
    if (right && right.x - now.x >= minDistance && Math.abs(now.y - right.y) < (right.x - now.x) * 0.7) return { direction: 'left', seen }
    // And mostly up or down for the volume (x counted in picture heights, as the hand's shape is).
    const rise = minDistance * VERTICAL_SHARE
    if (bottom && bottom.y - now.y >= rise && Math.abs(now.x - bottom.x) * aspect < (bottom.y - now.y) * 0.7) return { direction: 'up', seen }
    if (top && now.y - top.y >= rise && Math.abs(now.x - top.x) * aspect < (now.y - top.y) * 0.7) return { direction: 'down', seen }
    return null
  }

  return {
    push,
    state: () => current,
    setOptions: (next) => {
      options = next
    },
    reset
  }
}

function average(frames: number[][]): number[] {
  const out = new Array<number>(frames[0].length).fill(0)
  for (const f of frames) for (let i = 0; i < out.length; i++) out[i] += f[i] ?? 0
  return out.map((v) => v / frames.length)
}
