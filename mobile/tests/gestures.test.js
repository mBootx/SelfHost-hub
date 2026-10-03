// The car mode's hand gestures (src/services/gestureRecognizer.ts), frame by frame. The hand shapes come from real photos
// MediaPipe measured (fixtures/mediapipe-hands.json); the movements are made by moving those hands across the picture.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')

const NL = String.fromCharCode(10)
const tests = []
const test = (name, fn) => tests.push([name, fn])
let g

const HANDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mediapipe-hands.json'), 'utf8')).hands
const FPS = 24
const STEP = 1000 / FPS

// --- Hands ---

/** A fixture hand as the landmarker sends it (63 numbers), its wrist moved to (x, y) and its size scaled. */
function hand(name, { x, y, scale = 1, aspect = 1 } = {}) {
  const points = HANDS[name].points
  const [wx, wy] = points[0]
  const ox = x === undefined ? wx : x
  const oy = y === undefined ? wy : y
  const out = []
  // The fixtures come from square pictures; the same hand in a wider one covers less of its width.
  for (const [px, py] of points) out.push(ox + ((px - wx) * scale) / aspect, oy + (py - wy) * scale, 0)
  return out
}

/** A fixture hand turned about its wrist (degrees, clockwise on screen), in a picture of the given shape. */
function turned(name, degrees, aspect = 1) {
  const points = HANDS[name].points
  const [wx, wy] = points[0]
  const a = (degrees * Math.PI) / 180
  const out = []
  for (const [x, y] of points) {
    const dx = x - wx
    const dy = y - wy
    out.push(wx + (dx * Math.cos(a) - dy * Math.sin(a)) / aspect, wy + dx * Math.sin(a) + dy * Math.cos(a), 0)
  }
  return out
}

/** The same hand moved as a whole by (dx, dy): a hand shaking on a bumpy road. */
function shifted(points, dx, dy) {
  return points.map((v, i) => (i % 3 === 0 ? v + dx : i % 3 === 1 ? v + dy : v))
}

/** The open right hand, its index bent over to meet the thumb: a pinch. */
function pinchPoints(opts) {
  const p = hand('openRightUp', opts)
  const at = (i) => [p[i * 3], p[i * 3 + 1]]
  const thumb = at(4)
  const knuckle = at(5)
  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]
  const set = (i, [x, y]) => {
    p[i * 3] = x
    p[i * 3 + 1] = y
  }
  set(8, [thumb[0] + 0.01, thumb[1] - 0.01])
  set(7, lerp(knuckle, thumb, 0.75))
  set(6, lerp(knuckle, thumb, 0.4))
  return p
}

function withNoise(points, amount, seed) {
  let s = seed
  const random = () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647 - 0.5
  }
  return points.map((v, i) => (i % 3 === 2 ? v : v + random() * 2 * amount))
}

// Where the pinch tests hold the hand: the middle of the picture, where an open hand held still does nothing.
const SPOT = { x: 0.5, y: 0.62, scale: 0.4 }
const OPEN = () => hand('openRightUp', SPOT)
const PINCH = () => pinchPoints(SPOT)

const ALL_ON = () => Object.fromEntries(['PINCH', 'WAVE_RIGHT', 'WAVE_LEFT', 'PALM_UP', 'PALM_DOWN', 'THUMB_UP'].map((n) => [n, true]))
const recognizer = (patch = {}) =>
  g.createGestureRecognizer({ thresholds: { ...g.DEFAULT_THRESHOLDS, ...(patch.thresholds || {}) }, enabled: { ...ALL_ON(), ...(patch.enabled || {}) } })

/**
 * Feeds `frames` (each: an array of hands' points, or a function of the frame's time giving one) and returns the gestures
 * with the time each fired. A frame with no hands is [].
 */
function play(rec, frames, { start = 0, score = 0.95, width = 640, height = 640 } = {}) {
  const events = []
  frames.forEach((hands, i) => {
    const t = start + i * STEP
    const list = typeof hands === 'function' ? hands(t) : hands
    const event = rec.push({ t, width, height, hands: list.map((points) => (Array.isArray(points) ? { score, points } : points)) })
    if (event) events.push({ ...event, t: Math.round(t) })
  })
  return events
}

const repeatFor = (ms, hands) => Array.from({ length: Math.round(ms / STEP) }, () => hands)
const names = (events) => events.map((e) => e.gesture)

/** The open hand's wrist moving from x0 to x1 over `ms`, at height y. */
function sweep(x0, x1, ms, { y = 0.75, name = 'openRightUp', scale = 0.5 } = {}) {
  const n = Math.max(2, Math.round(ms / STEP))
  return Array.from({ length: n }, (_, i) => [hand(name, { x: x0 + ((x1 - x0) * i) / (n - 1), y, scale })])
}

// --- The hand's shape, on the real hands ---

test('real hands: a thumb up is a thumb up, a fist, a pointing finger and a victory sign are nothing', () => {
  assert.strictEqual(g.handShape(hand('thumbUp'), 1).pose, 'thumbUp')
  for (const name of ['fist', 'pointingUp', 'victory', 'pointingUpRotated']) {
    assert.strictEqual(g.handShape(hand(name), 1).pose, 'other', name)
  }
})

test('real hands: an open hand with its fingers up is an open palm; pointing down or sideways it is not', () => {
  assert.strictEqual(g.handShape(hand('openLeftUp'), 1).pose, 'openPalm')
  assert.strictEqual(g.handShape(hand('openRightUp'), 1).pose, 'openPalm')
  for (const name of ['openLeftDown', 'openRightDown', 'openRightUpRotated', 'openRightDownRotated']) {
    assert.strictEqual(g.handShape(hand(name), 1).pose, 'other', name)
  }
})

test('a thumb pointing sideways is no thumb up', () => {
  assert.notStrictEqual(g.handShape(hand('thumbUpRotated'), 1).pose, 'thumbUp')
})

test('a thumb up a little tilted is still one; leaning far over, its tip still the highest point, it is not', () => {
  assert.strictEqual(g.handShape(turned('thumbUp', -10), 1).pose, 'thumbUp')
  assert.strictEqual(g.handShape(turned('thumbUp', 20), 1).pose, 'thumbUp')
  const leaning = turned('thumbUp', -30)
  assert.ok([8, 12, 16, 20].every((i) => leaning[i * 3 + 1] > leaning[4 * 3 + 1]), 'the thumb tip is still above the fingers')
  assert.notStrictEqual(g.handShape(leaning, 1).pose, 'thumbUp')
})

test('a thumb up with the index pointing out (a finger gun) is no like', () => {
  const gun = hand('thumbUp')
  const at = (i) => [gun[i * 3], gun[i * 3 + 1]]
  const [wx, wy] = at(0)
  const [kx, ky] = at(5)
  // The index straightened out along the line from the wrist through its knuckle.
  ;[
    [6, 0.35],
    [7, 0.65],
    [8, 0.9]
  ].forEach(([i, k]) => {
    gun[i * 3] = kx + (kx - wx) * k
    gun[i * 3 + 1] = ky + (ky - wy) * k
  })
  assert.notStrictEqual(g.handShape(gun, 1).pose, 'thumbUp')
})

test('a fist brings the thumb against the index too, but only a real pinch is a pinch', () => {
  const fist = g.handShape(hand('fist'), 1)
  assert.ok(fist.pinchGap < g.DEFAULT_THRESHOLDS.pinchDistance, 'the fist really does look like a pinch by the gap alone: ' + fist.pinchGap)
  assert.notStrictEqual(fist.pose, 'pinch')
  assert.strictEqual(g.handShape(pinchPoints(), 1).pose, 'pinch')
})

test('the shape does not depend on how big the hand is, where it is, or the shape of the picture', () => {
  for (const [name, pose] of [['thumbUp', 'thumbUp'], ['openRightUp', 'openPalm'], ['fist', 'other']]) {
    assert.strictEqual(g.handShape(hand(name, { x: 0.3, y: 0.6, scale: 0.4 }), 1).pose, pose, name + ' small')
    assert.strictEqual(g.handShape(hand(name, { x: 0.5, y: 0.5, aspect: 4 / 3 }), 4 / 3).pose, pose, name + ' in 4:3')
    assert.strictEqual(g.handShape(hand(name, { x: 0.5, y: 0.5, aspect: 3 / 4 }), 3 / 4).pose, pose, name + ' in 3:4')
  }
  assert.strictEqual(g.handShape(pinchPoints({ x: 0.6, y: 0.7, scale: 0.35 }), 1).pose, 'pinch')
})

test('a slightly tilted thumb up reads the same in the phone’s portrait picture (3:4) and in a wide one', () => {
  for (const degrees of [-12, -10, -8, 25]) {
    for (const aspect of [3 / 4, 16 / 9]) {
      const square = g.handShape(turned('thumbUp', degrees), 1).pose
      assert.strictEqual(square, 'thumbUp')
      assert.strictEqual(g.handShape(turned('thumbUp', degrees, aspect), aspect).pose, square, degrees + '° in ' + aspect.toFixed(2))
    }
  }
  // Leaning over a little more it is no thumb up, in a wide picture too.
  assert.strictEqual(g.handShape(turned('thumbUp', -14, 16 / 9), 16 / 9).pose, 'other')
})

test('the gap between thumb and index measures the same in a wide picture as in a square one', () => {
  const square = g.handShape(hand('openRightUp', { x: 0.5, y: 0.5 }), 1).pinchGap
  for (const aspect of [4 / 3, 16 / 9, 3 / 4]) {
    const other = g.handShape(hand('openRightUp', { x: 0.5, y: 0.5, aspect }), aspect).pinchGap
    assert.ok(Math.abs(other - square) < 0.01 * square, aspect + ': ' + other + ' vs ' + square)
  }
})

// --- Pinch ---

test('a pinch held 200 ms plays or pauses, once, however long it is held', () => {
  const rec = recognizer()
  const events = play(rec, [...repeatFor(300, [OPEN()]), ...repeatFor(3000, [PINCH()])])
  assert.deepStrictEqual(names(events), ['PINCH'])
  // Smoothing over 5 frames lets the pinch show a couple of frames late; then 200 ms of holding.
  const firedAfter = events[0].t - 300
  assert.ok(firedAfter >= 200 && firedAfter <= 400, 'fired ' + firedAfter + ' ms into the pinch')
})

test('a pinch too short to count does nothing', () => {
  const rec = recognizer()
  const events = play(rec, [...repeatFor(300, [OPEN()]), ...repeatFor(100, [PINCH()]), ...repeatFor(600, [OPEN()])])
  assert.deepStrictEqual(names(events), [])
})

test('opening the fingers, then pinching again, counts again', () => {
  const rec = recognizer()
  const open = repeatFor(500, [OPEN()])
  const pinch = repeatFor(600, [PINCH()])
  assert.deepStrictEqual(names(play(rec, [...open, ...pinch, ...open, ...pinch])), ['PINCH', 'PINCH'])
})

test('fingers that only loosen a little are still the same pinch', () => {
  const rec = recognizer()
  const loose = PINCH()
  // The index tip moved off the thumb to a gap between the pinch and its release.
  loose[8 * 3] += 0.055
  const gap = g.handShape(loose, 1).pinchGap
  assert.ok(gap > g.DEFAULT_THRESHOLDS.pinchDistance && gap < g.DEFAULT_THRESHOLDS.pinchDistance * 1.6, 'in between: ' + gap)
  const frames = [...repeatFor(300, [OPEN()]), ...repeatFor(500, [PINCH()]), ...repeatFor(400, [loose]), ...repeatFor(500, [PINCH()])]
  assert.deepStrictEqual(names(play(rec, frames)), ['PINCH'])
})

test('a fist never plays or pauses', () => {
  const rec = recognizer()
  assert.deepStrictEqual(names(play(rec, repeatFor(3000, [hand('fist')]))), [])
})

test('the hand hidden for a frame or two behind the wheel is still the same pinch', () => {
  const before = [...repeatFor(300, [OPEN()]), ...repeatFor(250, [PINCH()]), [], [], ...repeatFor(1500, [PINCH()])]
  assert.deepStrictEqual(names(play(recognizer(), before)), ['PINCH'], 'hidden before it counted')
  const after = [...repeatFor(300, [OPEN()]), ...repeatFor(700, [PINCH()]), [], [], ...repeatFor(1500, [PINCH()])]
  assert.deepStrictEqual(names(play(recognizer(), after)), ['PINCH'], 'hidden after it counted')
})

test('a pinch the camera loses for one frame in four still counts, thanks to the smoothing', () => {
  const loose = PINCH()
  loose[8 * 3] += 0.055
  const n = Math.round(2000 / STEP)
  const frames = [...repeatFor(300, [OPEN()]), ...Array.from({ length: n }, (_, i) => [i % 4 === 3 ? loose : PINCH()])]
  assert.deepStrictEqual(names(play(recognizer(), frames)), ['PINCH'])
})

test('a hand that left and came back may pinch again without opening first', () => {
  const rec = recognizer()
  const frames = [...repeatFor(600, [PINCH()]), ...repeatFor(500, []), ...repeatFor(600, [PINCH()])]
  assert.deepStrictEqual(names(play(rec, frames)), ['PINCH', 'PINCH'])
})

// --- Thumb up ---

test('a thumb up held 400 ms likes the song, once', () => {
  const rec = recognizer()
  const events = play(rec, [...repeatFor(300, [hand('fist')]), ...repeatFor(3000, [hand('thumbUp')])])
  assert.deepStrictEqual(names(events), ['THUMB_UP'])
  const after = events[0].t - 300
  assert.ok(after >= 400 && after <= 600, 'fired ' + after + ' ms in')
})

test('a thumb up flickering for a moment is not a second like', () => {
  for (const flicker of [1, 2, 3]) {
    const frames = [...repeatFor(800, [hand('thumbUp')]), ...Array.from({ length: flicker }, () => [hand('fist')]), ...repeatFor(1200, [hand('thumbUp')])]
    assert.deepStrictEqual(names(play(recognizer(), frames)), ['THUMB_UP'], flicker + ' frame(s) of fist')
  }
})

test('a thumb lowered and raised again is a second like', () => {
  const frames = [...repeatFor(800, [hand('thumbUp')]), ...repeatFor(400, [hand('fist')]), ...repeatFor(800, [hand('thumbUp')])]
  assert.deepStrictEqual(names(play(recognizer(), frames)), ['THUMB_UP', 'THUMB_UP'])
})

test('a thumb sideways never likes', () => {
  assert.deepStrictEqual(names(play(recognizer(), repeatFor(2000, [hand('thumbUpRotated')]))), [])
})

// --- Waves ---

test('the hand crossing the picture to the right is "next", within half a second', () => {
  const rec = recognizer()
  const frames = [...repeatFor(300, [hand('openRightUp', { x: 0.25, y: 0.75, scale: 0.5 })]), ...sweep(0.25, 0.75, 350)]
  const events = play(rec, frames)
  assert.deepStrictEqual(names(events), ['WAVE_RIGHT'])
  assert.ok(events[0].t - 300 <= 500, 'recognised ' + (events[0].t - 300) + ' ms after the hand started moving')
})

test('and to the left is "previous"', () => {
  const rec = recognizer()
  const frames = [...repeatFor(300, [hand('openRightUp', { x: 0.75, y: 0.75, scale: 0.5 })]), ...sweep(0.75, 0.25, 350)]
  assert.deepStrictEqual(names(play(rec, frames)), ['WAVE_LEFT'])
})

test('bringing the hand back after a wave is not a wave back; a second wave the same way is', () => {
  const rec = recognizer()
  const frames = [
    ...repeatFor(300, [hand('openRightUp', { x: 0.25, y: 0.75, scale: 0.5 })]),
    ...sweep(0.25, 0.75, 350),
    ...sweep(0.75, 0.25, 400),
    ...repeatFor(500, [hand('openRightUp', { x: 0.25, y: 0.75, scale: 0.5 })]),
    ...sweep(0.25, 0.75, 350)
  ]
  assert.deepStrictEqual(names(play(rec, frames)), ['WAVE_RIGHT', 'WAVE_RIGHT'])
})

test('waving right, back and right again quickly skips twice: only the way back is ignored', () => {
  const at = (x) => hand('openRightUp', { x, y: 0.75, scale: 0.5 })
  const frames = [...repeatFor(300, [at(0.25)]), ...sweep(0.25, 0.75, 300), ...sweep(0.75, 0.25, 300), ...repeatFor(150, [at(0.25)]), ...sweep(0.25, 0.75, 300)]
  const events = play(recognizer(), frames)
  assert.deepStrictEqual(names(events), ['WAVE_RIGHT', 'WAVE_RIGHT'])
  assert.ok(events[1].t - events[0].t < 1200, 'the second came ' + (events[1].t - events[0].t) + ' ms after the first')
})

test('a wave that carries the hand out of the picture still counts', () => {
  const frames = [...repeatFor(300, [hand('openRightUp', { x: 0.35, y: 0.75, scale: 0.5 })]), ...sweep(0.35, 0.7, 250), ...repeatFor(500, [])]
  assert.deepStrictEqual(names(play(recognizer(), frames)), ['WAVE_RIGHT'])
})

test('a slow drift across the picture is not a wave', () => {
  assert.deepStrictEqual(names(play(recognizer(), sweep(0.2, 0.8, 2500))), [])
})

test('a short movement is not a wave', () => {
  assert.deepStrictEqual(names(play(recognizer(), [...repeatFor(300, [hand('openRightUp', { x: 0.4, y: 0.75, scale: 0.5 })]), ...sweep(0.4, 0.55, 200)])), [])
})

test('a hand that only just came into the picture is not a wave (seen in too few of the frames)', () => {
  const frames = [...repeatFor(400, []), ...sweep(0.3, 0.8, 130)]
  assert.deepStrictEqual(names(play(recognizer(), frames)), [])
})

test('a hand raised across the picture is not a wave', () => {
  const n = Math.round(350 / STEP)
  const diagonal = Array.from({ length: n }, (_, i) => [hand('openRightUp', { x: 0.3 + (0.35 * i) / (n - 1), y: 0.9 - (0.6 * i) / (n - 1), scale: 0.4 })])
  assert.deepStrictEqual(names(play(recognizer(), [...repeatFor(300, [hand('openRightUp', { x: 0.3, y: 0.9, scale: 0.4 })]), ...diagonal])), [])
})

// --- Volume ---

test('an open hand held still high turns the volume up, then again every half second until it goes', () => {
  const rec = recognizer()
  const up = [hand('openRightUp', { x: 0.5, y: 0.35, scale: 0.4 })]
  const events = play(rec, [...repeatFor(2000, up), ...repeatFor(1000, [])])
  assert.ok(events.length >= 3 && events.length <= 4, events.length + ' steps')
  assert.ok(events.every((e) => e.gesture === 'PALM_UP'))
  assert.strictEqual(events[0].repeat, false)
  assert.ok(events.slice(1).every((e) => e.repeat))
  assert.ok(events[0].t >= 600 && events[0].t <= 800, 'first step at ' + events[0].t)
})

test('held low it turns the volume down; in the middle it does nothing', () => {
  const low = play(recognizer(), repeatFor(1200, [hand('openRightUp', { x: 0.5, y: 0.95, scale: 0.4 })]))
  assert.ok(low.length >= 1 && low.every((e) => e.gesture === 'PALM_DOWN'), JSON.stringify(names(low)))
  // The wrist at 0.62 puts the middle of the palm about half-way down the picture.
  const middle = play(recognizer(), repeatFor(2000, [OPEN()]))
  assert.deepStrictEqual(names(middle), [])
})

test('an open hand waiting a little low, then waving, only skips (the middle of the picture is wide)', () => {
  const waiting = hand('openRightUp', { x: 0.25, y: 0.72, scale: 0.4 })
  assert.ok(g.handShape(waiting, 1).palmY > 0.6, 'the palm is past the 60 % line: ' + g.handShape(waiting, 1).palmY)
  const frames = [...repeatFor(1500, [waiting]), ...sweep(0.25, 0.75, 350, { y: 0.72, scale: 0.4 })]
  assert.deepStrictEqual(names(play(recognizer(), frames)), ['WAVE_RIGHT'])
})

test('a moving open hand does not change the volume', () => {
  const n = Math.round(2000 / STEP)
  const drifting = Array.from({ length: n }, (_, i) => [hand('openRightUp', { x: 0.3 + 0.15 * Math.sin(i / 3), y: 0.35, scale: 0.4 })])
  assert.deepStrictEqual(names(play(recognizer(), drifting)), [])
})

test('a little jitter in a hand held still is smoothed away', () => {
  const steady = hand('openRightUp', { x: 0.5, y: 0.35, scale: 0.4 })
  const n = Math.round(1500 / STEP)
  const jittery = Array.from({ length: n }, (_, i) => [withNoise(steady, 0.012, i + 1)])
  assert.ok(names(play(recognizer(), jittery)).includes('PALM_UP'))
  const pinch = pinchPoints({ x: 0.5, y: 0.7, scale: 0.4 })
  const shaky = Array.from({ length: n }, (_, i) => [withNoise(pinch, 0.006, i + 7)])
  assert.deepStrictEqual(names(play(recognizer(), shaky)), ['PINCH'])
})

test('an open hand held up on a bumpy road, shaking as a whole, still turns the volume up', () => {
  const steady = hand('openRightUp', { x: 0.5, y: 0.3, scale: 0.4 })
  const n = Math.round(2000 / STEP)
  let s = 11
  const random = () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647 - 0.5
  }
  const bumpy = Array.from({ length: n }, () => [shifted(steady, random() * 0.07, random() * 0.07)])
  assert.ok(names(play(recognizer(), bumpy)).includes('PALM_UP'))
})

// --- Doubtful hands, two hands ---

test('a hand the landmarker is unsure of is ignored', () => {
  assert.deepStrictEqual(names(play(recognizer(), repeatFor(2000, [pinchPoints()]), { score: 0.5 })), [])
  assert.deepStrictEqual(names(play(recognizer(), repeatFor(2000, [pinchPoints()]), { score: 0.6 })), ['PINCH'])
})

test("a passenger's hand waving does not take over from the driver's", () => {
  const driver = pinchPoints({ x: 0.3, y: 0.8, scale: 0.4 })
  const passengerAt = (x) => hand('openRightUp', { x, y: 0.5, scale: 0.3 })
  const n = Math.round(1200 / STEP)
  const frames = [
    ...repeatFor(300, [hand('openRightUp', { x: 0.3, y: 0.8, scale: 0.4 })]),
    ...Array.from({ length: n }, (_, i) => [driver, passengerAt(0.5 + 0.4 * Math.min(1, i / 8))])
  ]
  assert.deepStrictEqual(names(play(recognizer(), frames)), ['PINCH'])
})

test('nor does a bigger hand coming in later (a passenger leaning closer to the phone)', () => {
  const driver = pinchPoints({ x: 0.3, y: 0.8, scale: 0.4 })
  const passengerAt = (x) => hand('openRightUp', { x, y: 0.55, scale: 0.6 })
  const n = Math.round(1200 / STEP)
  const frames = [
    ...repeatFor(300, [hand('openRightUp', { x: 0.3, y: 0.8, scale: 0.4 })]),
    ...Array.from({ length: n }, (_, i) => [passengerAt(0.45 + 0.45 * Math.min(1, i / 8)), driver])
  ]
  assert.deepStrictEqual(names(play(recognizer(), frames)), ['PINCH'])
})

// --- Settings ---

test('a gesture turned off never fires; the others still do', () => {
  const rec = recognizer({ enabled: { PINCH: false } })
  const frames = [...repeatFor(800, [pinchPoints()]), ...repeatFor(500, []), ...repeatFor(800, [hand('thumbUp')])]
  assert.deepStrictEqual(names(play(rec, frames)), ['THUMB_UP'])
})

test('just after a gesture nothing else fires; a gesture still held then fires once the pause is over', () => {
  const rec = recognizer()
  const frames = [...repeatFor(300, [hand('openRightUp', { x: 0.25, y: 0.75, scale: 0.5 })]), ...sweep(0.25, 0.75, 350), ...repeatFor(1500, [pinchPoints({ x: 0.75, y: 0.75, scale: 0.5 })])]
  const events = play(rec, frames)
  assert.deepStrictEqual(names(events), ['WAVE_RIGHT', 'PINCH'])
  assert.ok(events[1].t - events[0].t >= 600, 'pinch ' + (events[1].t - events[0].t) + ' ms after the wave')
})

test('the sensitivity moves every threshold the same way, and the middle is the default', () => {
  assert.deepStrictEqual(g.thresholdsFor(0.5), g.DEFAULT_THRESHOLDS)
  const loose = g.thresholdsFor(1)
  const strict = g.thresholdsFor(0)
  assert.ok(loose.pinchDistance > strict.pinchDistance)
  assert.ok(loose.swipeMinDistance < strict.swipeMinDistance)
  assert.ok(loose.swipeConfidenceThreshold < strict.swipeConfidenceThreshold)
  assert.deepStrictEqual(g.thresholdsFor(7), loose)
  assert.deepStrictEqual(g.thresholdsFor(-3), strict)
  assert.deepStrictEqual(g.thresholdsFor(NaN), g.DEFAULT_THRESHOLDS)
})

test('a looser sensitivity takes a shorter wave', () => {
  const frames = () => [...repeatFor(300, [hand('openRightUp', { x: 0.35, y: 0.75, scale: 0.5 })]), ...sweep(0.35, 0.6, 300), ...repeatFor(200, [hand('openRightUp', { x: 0.6, y: 0.75, scale: 0.5 })])]
  assert.deepStrictEqual(names(play(recognizer(), frames())), [])
  assert.deepStrictEqual(names(play(recognizer({ thresholds: g.thresholdsFor(1) }), frames())), ['WAVE_RIGHT'])
})

test('reset forgets the hand: a pinch cut by it starts over', () => {
  const rec = recognizer()
  play(rec, repeatFor(150, [pinchPoints()]))
  rec.reset()
  assert.strictEqual(rec.state().present, false)
  assert.deepStrictEqual(names(play(rec, repeatFor(150, [pinchPoints()]), { start: 200 })), [])
  // Nothing of the hand before is averaged into the one after.
  rec.reset()
  play(rec, [[hand('openRightUp')]], { start: 400 })
  assert.strictEqual(rec.state().pose, 'openPalm')
})

test('the state says where the hand is and what it is doing, and that it is gone', () => {
  const rec = recognizer()
  play(rec, repeatFor(300, [hand('thumbUp', { x: 0.4, y: 0.6 })]))
  const seen = rec.state()
  assert.strictEqual(seen.present, true)
  assert.strictEqual(seen.pose, 'thumbUp')
  assert.ok(Math.abs(seen.x - 0.4) < 0.01 && Math.abs(seen.y - 0.6) < 0.01)
  play(rec, repeatFor(100, []), { start: 400 })
  assert.strictEqual(rec.state().present, false)
})

let finished = false
process.on('exit', () => {
  if (!finished) {
    console.log('FAIL the run ended before every test had finished')
    process.exitCode = 1
  }
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'gestures.ts')
  fs.writeFileSync(entry, "export * from '@/services/gestureRecognizer'" + NL)
  g = require(await bundle(entry, {}, path.join(bundle.OUT, 'gestures.js')))
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log('ok   ' + name)
    } catch (err) {
      failed++
      console.log('FAIL ' + name + NL + '     ' + String(err && err.stack ? err.stack : err).split(NL).slice(0, 6).join(NL + '     '))
    }
  }
  finished = true
  console.log(failed ? failed + ' FAILED' : 'all ' + tests.length + ' gesture tests passed')
  process.exit(failed ? 1 : 0)
})()
