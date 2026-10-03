// The Now Playing screen in the colours of the cover (src/services/coverColor.ts): the palette read from the cover's
// pixels, the screen's colours made from it (readable whatever the cover), and how a cover is read and remembered.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const NL = String.fromCharCode(10)
const tests = []
const test = (name, fn) => tests.push([name, fn])
let m

const STUBS = { 'expo-file-system': 'expo-file-system.js' }

/** A 32 by 32 cover made of colours in the given shares ([[r, g, b], share], ...), as the native side sends it. */
function cover(...parts) {
  const total = 32 * 32
  const out = []
  let used = 0
  parts.forEach(([rgb, share], i) => {
    const n = i === parts.length - 1 ? total - used : Math.round(total * share)
    used += n
    for (let k = 0; k < n; k++) out.push(...rgb)
  })
  return out
}

const hueOf = (rgb) => m.toHsl(rgb)[0]
const hexHue = (hex) => m.toHsl([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)])
const near = (a, b, tolerance) => m.hueDistance(a, b) <= tolerance

const RED = [200, 30, 40]
const TEAL = [31, 138, 158]
const YELLOW = [242, 209, 107]
const BLACK = [8, 8, 10]
const WHITE = [245, 245, 245]
const GREY = [120, 120, 122]

// --- The palette ---

test('a red cover is red: base and accent, and no second colour', () => {
  const p = m.paletteFrom(cover([RED, 0.8], [BLACK, 0.1], [WHITE, 0.1]))
  assert.strictEqual(p.grey, false)
  assert.ok(near(hueOf(p.base), 355, 12), 'base ' + p.base)
  assert.ok(near(hueOf(p.accent), 355, 12), 'accent ' + p.accent)
  assert.strictEqual(p.second, null)
})

test('a teal cover with a big yellow sun: teal background, yellow second colour, yellow controls', () => {
  const p = m.paletteFrom(cover([TEAL, 0.65], [YELLOW, 0.3], [WHITE, 0.05]))
  assert.ok(near(hueOf(p.base), hueOf(TEAL), 12), 'base ' + p.base)
  assert.ok(p.second && near(hueOf(p.second), hueOf(YELLOW), 12), 'second ' + p.second)
  assert.ok(near(hueOf(p.accent), hueOf(YELLOW), 12), 'accent ' + p.accent)
})

test('a dull second colour does not take the controls: they stay in the cover’s own colour', () => {
  const BROWN = [90, 70, 60]
  const p = m.paletteFrom(cover([TEAL, 0.6], [BROWN, 0.35], [WHITE, 0.05]))
  assert.ok(p.second && near(hueOf(p.second), hueOf(BROWN), 15), 'there is a second colour: ' + p.second)
  assert.ok(near(hueOf(p.accent), hueOf(TEAL), 12), 'accent ' + p.accent)
})

test('a dull cover with a bright patch: the dull colour is the background, the bright one the controls', () => {
  const OLIVE = [100, 104, 70]
  const MAGENTA = [235, 30, 200]
  const p = m.paletteFrom(cover([OLIVE, 0.75], [MAGENTA, 0.12], [BLACK, 0.13]))
  assert.ok(near(hueOf(p.base), hueOf(OLIVE), 15), 'base ' + p.base)
  assert.ok(near(hueOf(p.accent), hueOf(MAGENTA), 12), 'accent ' + p.accent)
  assert.ok(p.second && near(hueOf(p.second), hueOf(MAGENTA), 12), 'second ' + p.second)
})

test('a colour in two close shades (a gradient) counts as one, and beats a single bigger colour', () => {
  const SKY = [40, 130, 220]
  const DEEP = [40, 60, 210]
  const ORANGE = [230, 120, 30]
  assert.ok(Math.floor(hueOf(SKY) / 15) !== Math.floor(hueOf(DEEP) / 15), 'the two shades fall in different hue bins')
  const p = m.paletteFrom(cover([SKY, 0.3], [DEEP, 0.3], [ORANGE, 0.4]))
  assert.ok(near(hueOf(p.base), 220, 15), 'base ' + p.base)
  assert.ok(p.second && near(hueOf(p.second), hueOf(ORANGE), 12), 'second ' + p.second)
})

test('reds either side of the top of the colour wheel are one colour, not two', () => {
  const CRIMSON = [210, 20, 60]
  const VERMILION = [215, 50, 15]
  assert.ok(hueOf(CRIMSON) > 340 && hueOf(VERMILION) < 15)
  const p = m.paletteFrom(cover([CRIMSON, 0.45], [VERMILION, 0.45], [BLACK, 0.1]))
  assert.strictEqual(p.second, null, 'second ' + p.second)
})

test('a speck of colour is not the accent', () => {
  const BLUE = [30, 60, 200]
  const GREEN = [20, 230, 40]
  const p = m.paletteFrom(cover([BLUE, 0.9], [GREEN, 0.01], [BLACK, 0.09]))
  assert.ok(near(hueOf(p.accent), hueOf(BLUE), 12), 'accent ' + p.accent)
  assert.strictEqual(p.second, null, 'nor a second colour')
})

test('black and white is grey, with no accent', () => {
  const p = m.paletteFrom(cover([BLACK, 0.5], [WHITE, 0.3], [GREY, 0.2]))
  assert.strictEqual(p.grey, true)
  assert.strictEqual(p.accent, null)
  assert.strictEqual(p.second, null)
})

test('a dark cover with a small red logo stays dark, and the logo gives the accent', () => {
  const p = m.paletteFrom(cover([BLACK, 0.96], [RED, 0.04]))
  assert.strictEqual(p.grey, true)
  assert.ok(Math.max(...p.base) < 40, 'dark base ' + p.base)
  assert.ok(near(hueOf(p.accent), 355, 12), 'accent ' + p.accent)
})

test('no pixels, no palette', () => {
  assert.strictEqual(m.paletteFrom([]), null)
  assert.strictEqual(m.paletteFrom([1, 2]), null)
})

test('the one colour an older build gives makes a palette of that colour', () => {
  const p = m.paletteFromColor('#c81e28')
  assert.deepStrictEqual(p, { base: [200, 30, 40], accent: [200, 30, 40], second: null, grey: false })
  assert.strictEqual(m.paletteFromColor('#7a7a7a').grey, true)
  assert.strictEqual(m.paletteFromColor('#7a7a7a').accent, null)
  assert.strictEqual(m.paletteFromColor(null), null)
  assert.strictEqual(m.paletteFromColor('nonsense'), null)
})

// --- The screen's colours ---

test("the screen keeps the cover's hues: the backdrop the base's, the glow the second colour's, the controls the accent's", () => {
  const p = m.paletteFrom(cover([TEAL, 0.65], [YELLOW, 0.3], [WHITE, 0.05]))
  const look = m.lookFor(p)
  for (const key of ['top', 'middle', 'bottom', 'card']) assert.ok(near(hexHue(look[key])[0], hueOf(p.base), 8), key + ' ' + look[key])
  assert.ok(near(hexHue(look.glow)[0], hueOf(p.second), 8), 'glow ' + look.glow)
  assert.ok(near(hexHue(look.accent)[0], hueOf(p.accent), 8), 'accent ' + look.accent)
})

test('a faint colour still tints the backdrop clearly, and a garish one is toned down', () => {
  const FAINT = [150, 120, 110]
  const faint = m.paletteFrom(cover([FAINT, 1]))
  assert.strictEqual(faint.grey, false)
  assert.ok(m.toHsl(faint.base)[1] < 0.2, 'the cover itself is faint')
  assert.ok(hexHue(m.lookFor(faint).top)[1] >= 0.25, 'top ' + m.lookFor(faint).top)
  const garish = m.lookFor(m.paletteFrom(cover([[255, 0, 0], 1])))
  assert.ok(hexHue(garish.top)[1] <= 0.7, 'top ' + garish.top)
})

test('the backdrop darkens from the top down and stays tinted to the bottom', () => {
  const look = m.lookFor(m.paletteFrom(cover([RED, 0.9], [BLACK, 0.1])))
  const l = (hex) => hexHue(hex)[2]
  assert.ok(l(look.top) > l(look.middle) && l(look.middle) > l(look.bottom))
  assert.ok(hexHue(look.bottom)[1] > 0.2, 'still red at the bottom: ' + look.bottom)
})

test('whatever the cover, the text and the controls stay readable', () => {
  let seed = 7
  const random = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  const colour = () => [Math.floor(random() * 256), Math.floor(random() * 256), Math.floor(random() * 256)]
  for (let i = 0; i < 400; i++) {
    const p = m.paletteFrom(cover([colour(), 0.5], [colour(), 0.3], [colour(), 0.2]))
    const look = m.lookFor(p)
    const white = '#ffffff'
    // The title is large, bold, and sits low on the gradient; the lyrics are on the card.
    assert.ok(m.contrast(white, look.top) >= 3, 'title on ' + look.top)
    // A dark screen: the backdrop is never lighter than 30 % at its top.
    assert.ok(hexHue(look.top)[2] <= 0.31, 'dark top ' + look.top)
    assert.ok(m.contrast(white, look.middle) >= 7, 'text on ' + look.middle)
    assert.ok(m.contrast(white, look.card) >= 4.5, 'lyrics on ' + look.card)
    assert.ok(m.contrast(look.accent, look.top) >= 3, 'accent ' + look.accent + ' on ' + look.top)
    assert.ok(m.contrast(look.onAccent, look.accent) >= 4.5, look.onAccent + ' on ' + look.accent)
  }
})

test('a black and white cover gets greys and white controls with black icons', () => {
  const look = m.lookFor(m.paletteFrom(cover([BLACK, 0.6], [WHITE, 0.4])))
  for (const key of ['top', 'middle', 'bottom', 'card']) assert.ok(hexHue(look[key])[1] < 0.02, key + ' ' + look[key])
  assert.strictEqual(look.glow, null)
  assert.strictEqual(look.accent, '#f2f2f2')
  assert.strictEqual(look.onAccent, '#000000')
})

test('a grey cover with a red logo gets grey surroundings and red controls', () => {
  const look = m.lookFor(m.paletteFrom(cover([BLACK, 0.96], [RED, 0.04])))
  assert.ok(hexHue(look.top)[1] < 0.02, 'grey top ' + look.top)
  assert.ok(near(hexHue(look.accent)[0], 355, 12) && hexHue(look.accent)[1] > 0.4, 'red accent ' + look.accent)
})

test('no cover: the app’s own colours', () => {
  assert.deepStrictEqual(m.lookFor(null), m.PLAIN_LOOK)
})

// --- Reading a cover ---

test('a cover is read once from its pixels, then remembered', async () => {
  fake.native = { covers: { a: { pixels: cover([RED, 1]) } } }
  const first = await m.coverPalette('a')
  const again = await m.coverPalette('a')
  assert.strictEqual(fake.native.coverCalls, 1)
  assert.deepStrictEqual(fake.native.coverSides, [32])
  assert.strictEqual(again, first)
  assert.strictEqual(m.cachedPalette('a'), first)
  assert.strictEqual(m.cachedPalette('never-read'), null)
})

test('a build without the pixels uses the main colour it can give', async () => {
  fake.native = { oldCoverBuild: true, covers: { b: { color: '#1f8a9e' } } }
  const p = await m.coverPalette('b')
  assert.deepStrictEqual(p.base, [31, 138, 158])
  assert.strictEqual(fake.native.colorCalls, 1)
  assert.strictEqual(fake.native.coverCalls, undefined)
})

test('a cover that cannot be read is tried again next time', async () => {
  fake.native = { covers: {}, coverError: 'offline' }
  assert.strictEqual(await m.coverPalette('c'), null)
  fake.native.coverError = undefined
  fake.native.covers.c = { pixels: cover([TEAL, 1]) }
  assert.ok(await m.coverPalette('c'))
  assert.strictEqual(fake.native.coverCalls, 2)
})

let finished = false
process.on('exit', () => {
  if (!finished) {
    console.log('FAIL the run ended before every test had finished')
    process.exitCode = 1
  }
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'palette.ts')
  fs.writeFileSync(entry, "export * from '@/services/coverColor'" + NL)
  m = require(await bundle(entry, STUBS, path.join(bundle.OUT, 'palette.js')))
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
  console.log(failed ? failed + ' FAILED' : 'all ' + tests.length + ' palette tests passed')
  process.exit(failed ? 1 : 0)
})()
