// The playback engine against fake players: loudness levels per deck, crossfades that respect them, and
// "stop after this track". (Timing is driven by status events, as on the phone; only the JS fallback fade uses a real timer.)
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')

const NL = String.fromCharCode(10)
const STUBS = { 'expo-audio': 'expo-audio.js' }
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let engine
let events
let counter = 0
const id = (name) => name + ++counter
const tests = []
const test = (name, fn) => tests.push([name, fn])

const [deckA, deckB] = (() => {
  // The engine creates its two decks when its module loads.
  return [null, null]
})()

function decks() {
  return fake.players.slice(-2)
}

/** Back to a quiet engine: nothing loaded, defaults, a fresh set of handler recordings. */
function reset() {
  const [a, b] = decks()
  for (const deck of [a, b]) {
    deck.volume = 1
    deck.playing = false
    deck.isLoaded = false
    deck.currentTime = 0
    deck.source = null
  }
  fake.native.crossfades = []
  fake.native.cancelledFades = 0
  fake.native.missing = false
  engine.setStopAfterTrack(false)
  engine.setTransitions(0, true)
  engine.setNext(null)
  engine.setVolume(1)
  events = { advance: 0, end: 0, stop: 0, external: [] }
  engine.setHandlers({
    onProgress() {},
    onTrackEnd: () => events.end++,
    onAutoAdvance: () => events.advance++,
    onExternalPlayState: (playing) => events.external.push(playing),
    onStopAfterTrack: () => events.stop++
  })
}

/** Plays the current track up to `seconds`, the way status events report it. */
function playTo(seconds) {
  const deck = engine.activePlayer
  deck.currentTime = seconds
  deck.emit({ playing: true })
}

test('a track\'s loudness factor multiplies the volume setting, and follows later changes of either', () => {
  reset()
  engine.setVolume(0.8)
  engine.load(id('a'), 'src-a', true, 0, 0.5)
  near(engine.activePlayer.volume, 0.4)
  engine.setVolume(1)
  near(engine.activePlayer.volume, 0.5)
  engine.setGain(0.25)
  near(engine.activePlayer.volume, 0.25)
  engine.setGain(1)
  near(engine.activePlayer.volume, 1)
})

test('a track loaded without a factor plays at the plain volume', () => {
  reset()
  engine.setVolume(0.6)
  engine.load(id('a'), 'src-a', true)
  near(engine.activePlayer.volume, 0.6)
})

test('a crossfade ramps each deck between silence and its own level', () => {
  reset()
  engine.setVolume(0.8)
  engine.setTransitions(6, true)
  engine.load(id('a'), 'src-a', true, 0, 0.5)
  engine.setNext({ id: 'b', source: 'src-b', gain: 0.25 })
  const first = engine.activePlayer
  playTo(75) // 25 s left: the next track starts loading
  const second = decks().find((d) => d !== first)
  assert.strictEqual(second.source, 'src-b', 'preloaded')
  assert.strictEqual(second.volume, 0, 'silent until it fades in')
  playTo(95) // 5 s left: inside the crossfade
  assert.strictEqual(fake.native.crossfades.length, 1)
  const fade = fake.native.crossfades[0]
  assert.strictEqual(fade.outgoing, first)
  assert.strictEqual(fade.incoming, second)
  near(fade.outgoingLevel, 0.4)
  near(fade.incomingLevel, 0.2)
  assert.strictEqual(events.advance, 1)
  assert.strictEqual(engine.activePlayer, second)
})

test('without the native fade the JS fallback ramps to the same levels and ends at the new track\'s level', async () => {
  reset()
  fake.native.missing = true
  engine.setVolume(0.8)
  engine.setTransitions(1, true) // a crossfade of one second (the engine never goes under half a second)
  engine.load(id('a'), 'src-a', true, 0, 0.5)
  engine.setNext({ id: 'b', source: 'src-b', gain: 0.25 })
  const first = engine.activePlayer
  playTo(79) // 21 s left
  playTo(99.5) // inside the crossfade window
  const second = engine.activePlayer
  assert.notStrictEqual(second, first)
  await sleep(150)
  // Part-way through, the old deck is below its own level (0.8 x 0.5), not the plain volume's.
  assert.ok(first.volume > 0.05 && first.volume <= 0.4 + 1e-9, `outgoing volume ${first.volume}`)
  assert.ok(second.volume <= 0.2 + 1e-9, `incoming volume ${second.volume}`)
  await sleep(550)
  near(second.volume, 0.2, 0.02)
  assert.strictEqual(first.playing, false, 'the old deck stopped')
  second.emit({ playing: true }) // a status after the fade's end lets the engine tidy up
  near(second.volume, 0.2, 1e-9)
  fake.native.missing = false
})

test('a gapless hop starts the next track at its own level', () => {
  reset()
  engine.setVolume(0.8)
  engine.setTransitions(0, true)
  engine.load(id('a'), 'src-a', true, 0, 0.5)
  engine.setNext({ id: 'b', source: 'src-b', gain: 0.25 })
  const first = engine.activePlayer
  playTo(85) // within the preload lead
  const second = decks().find((d) => d !== first)
  assert.strictEqual(second.source, 'src-b')
  first.currentTime = 100
  first.emit({ playing: false, didJustFinish: true })
  assert.strictEqual(engine.activePlayer, second)
  near(second.volume, 0.2)
  assert.strictEqual(events.advance, 1)
  assert.strictEqual(events.end, 0)
})

test('a track preloaded before the setting changed picks up the new factor when it is announced again', () => {
  reset()
  engine.setVolume(1)
  engine.setTransitions(0, true)
  engine.load(id('a'), 'src-a', true)
  engine.setNext({ id: 'b', source: 'src-b', gain: 0.5 })
  const first = engine.activePlayer
  playTo(85)
  engine.setNext({ id: 'b', source: 'src-b', gain: 0.25 })
  first.currentTime = 100
  first.emit({ playing: false, didJustFinish: true })
  near(engine.activePlayer.volume, 0.25)
})

test('stop after this track: nothing is prepared, and when it ends playback stops instead of moving on', () => {
  reset()
  engine.setTransitions(6, true)
  engine.load(id('a'), 'src-a', true)
  engine.setNext({ id: 'b', source: 'src-b' })
  engine.setStopAfterTrack(true)
  assert.strictEqual(engine.stoppingAfterTrack, true)
  const first = engine.activePlayer
  playTo(75)
  playTo(95)
  const other = decks().find((d) => d !== first)
  assert.strictEqual(other.source, null, 'the next track was not even loaded')
  assert.strictEqual(fake.native.crossfades.length, 0)
  first.currentTime = 100
  first.emit({ playing: false, didJustFinish: true })
  assert.deepStrictEqual([events.stop, events.advance, events.end], [1, 0, 0])
  assert.strictEqual(first.playing, false)
  assert.strictEqual(engine.stoppingAfterTrack, false, 'it applies once')
})

test('after a stop, the next track ends the usual way', () => {
  reset()
  engine.load(id('a'), 'src-a', true)
  engine.setStopAfterTrack(true)
  const deck = engine.activePlayer
  deck.emit({ playing: false, didJustFinish: true })
  assert.strictEqual(events.stop, 1)
  engine.load(id('b'), 'src-b', true)
  engine.activePlayer.emit({ playing: false, didJustFinish: true })
  assert.deepStrictEqual([events.stop, events.end], [1, 1])
})

test('stopping after the track is cancelled by turning the flag off', () => {
  reset()
  engine.setTransitions(0, true)
  engine.load(id('a'), 'src-a', true)
  engine.setNext({ id: 'b', source: 'src-b' })
  engine.setStopAfterTrack(true)
  engine.setStopAfterTrack(false)
  const first = engine.activePlayer
  playTo(85)
  first.currentTime = 100
  first.emit({ playing: false, didJustFinish: true })
  assert.deepStrictEqual([events.stop, events.advance], [0, 1])
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'engine.ts')
  fs.writeFileSync(entry, "export { engine } from '@/services/playbackEngine'" + NL)
  engine = require(await bundle(entry, STUBS, path.join(bundle.OUT, 'engine.js'))).engine
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log('ok   ' + name)
    } catch (err) {
      failed++
      console.log('FAIL ' + name + NL + '     ' + String(err && err.stack ? err.stack : err).split(NL).slice(0, 7).join(NL + '     '))
    }
  }
  console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' engine tests passed')
  process.exit(failed ? 1 : 0)
})()
