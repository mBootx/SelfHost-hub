// The logic behind the desktop app's full-screen player (src/renderer/src/services/bigPicture.ts): the playhead between
// two reports, how far along the sung line is, how a lyric line looks by its distance, the colour of a cover.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')

const NL = String.fromCharCode(10)
const tests = []
const test = (name, fn) => tests.push([name, fn])
let m

const line = (time, text) => ({ time, text })
const SONG = [line(10, 'Premier vers de la chanson'), line(16, 'Deuxième'), line(20, ''), line(30, 'La suite arrive enfin ici maintenant')]

// --- The playhead ---

test('between two reports the position moves with the clock, at the playback rate', () => {
  const base = { time: 50, at: 1000, playing: true, rate: 1 }
  assert.strictEqual(m.estimatePosition(base, 1000, 200), 50)
  assert.strictEqual(m.estimatePosition(base, 3500, 200), 52.5)
  assert.strictEqual(m.estimatePosition({ ...base, rate: 1.5 }, 3000, 200), 53)
  assert.strictEqual(m.estimatePosition({ ...base, rate: 0 }, 3000, 200), 52, 'a rate of nothing is taken for normal speed')
})

test('a paused song stays where it is', () => {
  assert.strictEqual(m.estimatePosition({ time: 50, at: 1000, playing: false, rate: 1 }, 9000, 200), 50)
})

test('the position never passes the end, nor goes before the start, nor runs backwards with the clock', () => {
  assert.strictEqual(m.estimatePosition({ time: 198, at: 0, playing: true, rate: 1 }, 10_000, 200), 200)
  assert.strictEqual(m.estimatePosition({ time: -3, at: 0, playing: false, rate: 1 }, 0, 200), 0)
  assert.strictEqual(m.estimatePosition({ time: 50, at: 5000, playing: true, rate: 1 }, 1000, 200), 50, 'a clock that went back')
  assert.strictEqual(m.estimatePosition({ time: 500, at: 0, playing: true, rate: 1 }, 1000, 0), 501, 'a duration not known yet does not cap')
})

// --- Lyrics ---

test('the words of a line are cut at spaces, however many', () => {
  assert.deepStrictEqual(m.wordsOf('  un   deux trois '), ['un', 'deux', 'trois'])
  assert.deepStrictEqual(m.wordsOf(''), [])
  assert.deepStrictEqual(m.wordsOf('   '), [])
})

test('a line is sung over about as long as its words take to say', () => {
  assert.strictEqual(m.lineProgress(SONG, 0, 10), 0)
  const mid = m.lineProgress(SONG, 0, 11)
  assert.ok(mid > 0.3 && mid < 0.6, 'five words, a second in: ' + mid)
  assert.strictEqual(m.lineProgress(SONG, 0, 13), 1)
})

test('and after a long break it is done long before the next line starts', () => {
  assert.strictEqual(m.lineProgress(SONG, 0, 15), 1, 'five seconds in, of a gap of six')
  assert.strictEqual(m.lineProgress([line(0, 'Fin de la chanson'), line(100, 'x')], 0, 4), 1)
})

test('a line cannot be sung for longer than there is until the next', () => {
  const tight = [line(0, 'Beaucoup de mots dans très peu de temps ici'), line(1, 'Suite')]
  assert.strictEqual(m.lineProgress(tight, 0, 1), 1)
  assert.ok(m.lineProgress(tight, 0, 0.5) > 0.4)
})

test('the last line, a blank one and a missing one have a progress that makes sense', () => {
  assert.ok(m.lineProgress(SONG, 3, 31) > 0 && m.lineProgress(SONG, 3, 31) < 1)
  assert.strictEqual(m.lineProgress(SONG, 3, 99), 1)
  assert.strictEqual(m.lineProgress(SONG, 2, 25), 0, 'a break has nothing to light')
  assert.strictEqual(m.lineProgress(SONG, -1, 5), 0)
  assert.strictEqual(m.lineProgress(SONG, 9, 5), 0)
  assert.strictEqual(m.lineProgress(SONG, 0, 3), 0, 'before the line, nothing')
})

test('two lines with the same stamp do not make the progress nonsense', () => {
  const twins = [line(5, 'un deux trois'), line(5, 'quatre')]
  assert.strictEqual(m.lineProgress(twins, 0, 5), 0)
  assert.strictEqual(m.lineProgress(twins, 0, 6), 1)
})

test('words light one after the other: the first at once, all of them by the end', () => {
  assert.strictEqual(m.litWords(5, 0), 0)
  assert.strictEqual(m.litWords(5, 0.01), 1)
  assert.strictEqual(m.litWords(5, 0.5), 3)
  assert.strictEqual(m.litWords(5, 1), 5)
  assert.strictEqual(m.litWords(5, 3), 5)
  assert.strictEqual(m.litWords(0, 1), 0)
})

test('a blank line is a break, a line with words is not', () => {
  assert.strictEqual(m.isBreak(SONG, 2), true)
  assert.strictEqual(m.isBreak(SONG, 1), false)
  assert.strictEqual(m.isBreak(SONG, 7), false)
  assert.strictEqual(m.isBreak([line(0, '   ')], 0), true)
})

test('the sung line is sharp and full size, the others dim, shrink and blur with distance', () => {
  assert.deepStrictEqual(m.rowLook(0), { opacity: 1, blur: 0, scale: 1 })
  const ahead = [1, 2, 3, 4, 5].map((d) => m.rowLook(d))
  for (let i = 1; i < ahead.length; i++) {
    assert.ok(ahead[i].opacity <= ahead[i - 1].opacity, 'dimmer')
    assert.ok(ahead[i].blur >= ahead[i - 1].blur, 'blurrier')
    assert.ok(ahead[i].scale <= ahead[i - 1].scale, 'smaller')
  }
  assert.ok(m.rowLook(1).opacity > m.rowLook(-1).opacity, 'what is coming is brighter than what is gone')
})

test('far lines are faint but never gone, never absurdly blurred or small', () => {
  const far = m.rowLook(50)
  assert.ok(far.opacity >= 0.08 && far.blur <= 5 && far.scale >= 0.78)
  const farBack = m.rowLook(-50)
  assert.ok(farBack.opacity >= 0.08 && farBack.blur <= 5 && farBack.scale >= 0.78)
})

test('the scroll puts the middle of the sung row at the anchor of the viewport', () => {
  assert.strictEqual(m.scrollOffset(1000, 600, 100), 400 - 650)
  assert.strictEqual(m.scrollOffset(1000, 0, 100, 0.5), 450)
  assert.strictEqual(m.scrollOffset(1000, 650, 100, 0.5), -200)
})

// --- The controls ---

test('the controls show while something happened lately, or while one is held', () => {
  assert.strictEqual(m.controlsVisible(1000, 0, 3500, false), true)
  assert.strictEqual(m.controlsVisible(3499, 0, 3500, false), true)
  assert.strictEqual(m.controlsVisible(3500, 0, 3500, false), false)
  assert.strictEqual(m.controlsVisible(99_999, 0, 3500, true), true)
})

test('times are shown as minutes and seconds, and the clock as hours and minutes', () => {
  assert.strictEqual(m.formatClock(0), '0:00')
  assert.strictEqual(m.formatClock(65.9), '1:05')
  assert.strictEqual(m.formatClock(3600), '60:00')
  assert.strictEqual(m.formatClock(-4), '0:00')
  assert.strictEqual(m.formatClock(NaN), '0:00')
  assert.strictEqual(m.formatTimeOfDay(new Date(2026, 9, 3, 7, 5)), '07:05')
  assert.strictEqual(m.formatTimeOfDay(new Date(2026, 9, 3, 23, 59)), '23:59')
})

// --- The colour ---

const pixels = (...colors) => Uint8ClampedArray.from(colors.flatMap(([r, g, b, a = 255]) => [r, g, b, a]))
const repeat = (n, color) => Array.from({ length: n }, () => color)

test('a cover that is mostly red is red', () => {
  const [r, g, b] = m.dominantColor(pixels(...repeat(300, [210, 30, 40]), ...repeat(30, [20, 20, 20]), ...repeat(30, [240, 240, 240])))
  assert.ok(r > 190 && g < 60 && b < 70, [r, g, b].join())
})

test('a small vivid patch outweighs a big grey one', () => {
  const [r, g, b] = m.dominantColor(pixels(...repeat(400, [120, 120, 124]), ...repeat(40, [20, 120, 240])))
  assert.ok(b > r + 80, [r, g, b].join())
})

test('a dark cover with a little colour is that colour, not black', () => {
  const [r, g, b] = m.dominantColor(pixels(...repeat(600, [2, 2, 2]), ...repeat(4, [200, 30, 30])))
  assert.ok(r > 150 && g < 80 && b < 80, [r, g, b].join())
  const white = m.dominantColor(pixels(...repeat(600, [252, 252, 252]), ...repeat(4, [30, 60, 200])))
  assert.ok(white[2] > white[0] + 100, 'and a white one, the colour: ' + white.join())
})

test('black, white, transparent and grey count for nothing', () => {
  assert.strictEqual(m.dominantColor(pixels(...repeat(100, [0, 0, 0]), ...repeat(100, [255, 255, 255]))), null)
  assert.strictEqual(m.dominantColor(pixels(...repeat(100, [128, 128, 128]))), null)
  assert.strictEqual(m.dominantColor(pixels(...repeat(100, [200, 20, 20, 0]))), null)
  assert.strictEqual(m.dominantColor(new Uint8ClampedArray(0)), null)
})

test('a dark colour is lifted until it shines, a bright one is left alone, the hue stays', () => {
  const dark = m.lifted([40, 10, 90])
  assert.ok(dark[0] > 40 && dark[2] > 90)
  assert.ok(dark[2] > dark[0] && dark[2] > dark[1], 'still bluish')
  assert.deepStrictEqual(m.lifted([250, 200, 40]), [250, 200, 40])
  const black = m.lifted([0, 0, 0])
  assert.ok(black[0] > 0)
})

test('darkening pulls a colour towards black', () => {
  assert.deepStrictEqual(m.darkened([100, 200, 50], 0.5), [50, 100, 25])
  assert.deepStrictEqual(m.darkened([100, 200, 50], 1), [0, 0, 0])
})

let finished = false
process.on('exit', () => {
  if (!finished) {
    console.log('FAIL the run ended before every test had finished')
    process.exitCode = 1
  }
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'bigpicture.ts')
  fs.writeFileSync(entry, "export * from '../../../../src/renderer/src/services/bigPicture'" + NL)
  m = require(await bundle(entry, {}, path.join(bundle.OUT, 'bigpicture.js')))
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
  console.log(failed ? failed + ' FAILED' : 'all ' + tests.length + ' big picture tests passed')
  process.exit(failed ? 1 : 0)
})()
