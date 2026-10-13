// The playback engine's side of the lock screen / Now Bar and of the audio focus, against fake players that model
// the native session (one, held by the last player that claimed it). Nothing here goes through React: the engine
// alone keeps the Now Bar on the deck that plays, so it holds even when the screen's effects run late or never.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')
// Sets up fake.native, which the engine's bundle shares.
require('./stubs/selfhost-native')

const NL = String.fromCharCode(10)
const STUBS = { 'expo-audio': 'expo-audio.js' }
const OUT = path.join(bundle.OUT, 'nowbar-engine.js')

let mod
let engine
let events
const tests = []
const test = (name, fn) => tests.push([name, fn])

const info = (title, extra = {}) => ({ title, artist: 'Artist of ' + title, album: 'Album of ' + title, artworkUrl: 'https://music.test/cover/' + title, ...extra })

function decks() {
  return engine.decks
}

/** A fresh engine (a fresh app): the module is loaded again, with the native module as `native` describes. */
function load(native = {}) {
  fake.native.missing = false
  fake.native.shareListeners = []
  fake.native.crossfades = []
  fake.native.cancelledFades = 0
  fake.native.focusRequests = 0
  fake.native.focusAbandons = 0
  fake.native.focusAnswer = null
  Object.assign(fake.native, native)
  fake.lockScreen = null
  fake.lockScreenCalls = []
  fake.audioMode = null
  delete require.cache[require.resolve(OUT)]
  mod = require(OUT)
  engine = mod.engine
  events = { advance: 0, end: 0, external: [], remote: [] }
  engine.setHandlers({
    onProgress() {},
    onTrackEnd: () => events.end++,
    onAutoAdvance: () => {
      events.advance++
      // What the Now Bar shows at the moment the queue is told to advance.
      events.shownAtAdvance = fake.lockScreen && { player: fake.lockScreen.player, title: fake.lockScreen.metadata.title }
    },
    onExternalPlayState: (playing) => events.external.push(playing)
  })
  // As PlaybackController wires the presses: skips go to the queue, play and pause to the engine.
  mod.onRemoteCommand((command) => {
    events.remote.push(command)
    if (command === 'play' || command === 'pause') engine.remotePlayState(command === 'play')
  })
}

/** Android's side of the audio focus, as selfhost-native reports it. */
function focusChange(change) {
  for (const [event, listener] of fake.native.shareListeners) if (event === 'onAudioFocus') listener({ change })
}

function playTo(seconds) {
  const deck = engine.activePlayer
  deck.currentTime = seconds
  deck.emit({ playing: true })
}

function shown() {
  return fake.lockScreen && { player: fake.lockScreen.player, title: fake.lockScreen.metadata.title }
}

function assertShown(player, title) {
  const now = shown()
  assert.ok(now, 'the Now Bar is up')
  assert.strictEqual(now.title, title)
  assert.strictEqual(now.player, player, 'held by the deck that plays')
}

// --- The Now Bar follows the deck that plays ---

test('a track loaded is put on the Now Bar with its details and the seek buttons', () => {
  load()
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  assertShown(engine.activePlayer, 'Song A')
  assert.deepStrictEqual(fake.lockScreen.metadata, {
    title: 'Song A',
    artist: 'Artist of Song A',
    albumTitle: 'Album of Song A',
    artworkUrl: 'https://music.test/cover/Song A'
  })
  assert.deepStrictEqual(fake.lockScreen.options, { showSeekForward: true, showSeekBackward: true })
})

test('a crossfade hands the Now Bar to the incoming deck, with the next song, before the queue moves on', () => {
  load()
  engine.setTransitions(6, true)
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  engine.setNext({ id: 'b', source: 'src-b', info: info('Song B') })
  const first = engine.activePlayer
  playTo(75)
  playTo(95)
  const second = engine.activePlayer
  assert.notStrictEqual(second, first)
  assert.deepStrictEqual(events.shownAtAdvance, { player: second, title: 'Song B' })
})

test('a gapless hop hands the Now Bar over the same way', () => {
  load()
  engine.setTransitions(0, true)
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  engine.setNext({ id: 'b', source: 'src-b', info: info('Song B') })
  const first = engine.activePlayer
  playTo(85)
  first.emit({ playing: false, didJustFinish: true })
  assert.notStrictEqual(engine.activePlayer, first)
  assert.deepStrictEqual(events.shownAtAdvance, { player: engine.activePlayer, title: 'Song B' })
})

test('skipping to a preloaded song moves the Now Bar to its deck', () => {
  load()
  engine.setTransitions(0, true)
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  engine.setNext({ id: 'b', source: 'src-b', info: info('Song B') })
  const first = engine.activePlayer
  playTo(85)
  engine.load('b', 'src-b', true, 0, 1, info('Song B'))
  assert.notStrictEqual(engine.activePlayer, first)
  assertShown(engine.activePlayer, 'Song B')
})

test('a song loaded on the same deck replaces the details there', () => {
  load()
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  const deck = engine.activePlayer
  engine.load('c', 'src-c', true, 0, 1, info('Song C'))
  assert.strictEqual(engine.activePlayer, deck)
  assertShown(deck, 'Song C')
})

test('a one-song queue on repeat keeps the Now Bar on the deck that plays, loop after loop', () => {
  // The queue does not change at all here, so nothing on the React side would ever move the Now Bar.
  load()
  engine.setTransitions(0, true)
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  engine.setNext({ id: 'a', source: 'src-a', info: info('Song A') })
  for (let loop = 0; loop < 3; loop++) {
    const playing = engine.activePlayer
    playTo(85)
    playing.emit({ playing: false, didJustFinish: true })
    assert.notStrictEqual(engine.activePlayer, playing, 'loop ' + loop + ' went to the other deck')
    assertShown(engine.activePlayer, 'Song A')
  }
})

test('unchanged details are not sent again; a new cover is, to the deck that plays', () => {
  load()
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  const calls = fake.lockScreenCalls.length
  engine.setNowPlaying('a', info('Song A'))
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  assert.strictEqual(fake.lockScreenCalls.length, calls)
  engine.setNowPlaying('a', info('Song A', { artworkUrl: 'https://music.test/picked.jpg' }))
  assert.strictEqual(fake.lockScreenCalls.length, calls + 1)
  assert.strictEqual(fake.lockScreen.metadata.artworkUrl, 'https://music.test/picked.jpg')
  assert.strictEqual(fake.lockScreen.player, engine.activePlayer)
})

test('an emptied queue takes the Now Bar down, and the same song played again puts it back', () => {
  load()
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  engine.clearNowPlaying()
  assert.strictEqual(fake.lockScreen, null)
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  assertShown(engine.activePlayer, 'Song A')
})

// --- Presses on the Now Bar ---

test('pause pressed while a song is still loading is not undone when it has loaded', () => {
  load()
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  const deck = engine.activePlayer
  deck.playing = false // still buffering: the deck has not reported playing yet
  deck.press('pause') // the native side already paused the deck
  const plays = deck.plays
  deck.emit({ playing: false, isLoaded: true })
  assert.strictEqual(deck.plays, plays, 'not played again')
  assert.deepStrictEqual(events.external, [false], 'the app is told once')
})

test('play and pause pressed on the Now Bar become the app\'s state', () => {
  load()
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  const deck = engine.activePlayer
  deck.emit({ playing: true })
  deck.press('pause')
  deck.playing = false
  deck.emit({ playing: false })
  deck.press('play')
  deck.playing = true
  deck.emit({ playing: true })
  assert.deepStrictEqual(events.external, [false, true])
  assert.strictEqual(deck.playing, true)
})

test('pause pressed mid-crossfade stops both songs', () => {
  load()
  engine.setTransitions(6, true)
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  engine.setNext({ id: 'b', source: 'src-b', info: info('Song B') })
  const first = engine.activePlayer
  playTo(75)
  playTo(95)
  const second = engine.activePlayer
  second.press('pause')
  assert.strictEqual(first.playing, false)
  assert.strictEqual(second.playing, false)
})

test('skips pressed on the Now Bar reach the queue from whichever deck holds it', () => {
  load()
  engine.setTransitions(0, true)
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  engine.activePlayer.press('next')
  engine.setNext({ id: 'b', source: 'src-b', info: info('Song B') })
  const first = engine.activePlayer
  playTo(85)
  first.emit({ playing: false, didJustFinish: true })
  engine.activePlayer.press('previous')
  assert.deepStrictEqual(events.remote, ['next', 'previous'])
})

// --- The end of the queue ---

test('a track that ends with nothing after it is paused at once, then put back at its start when the app stops', () => {
  load()
  engine.setTransitions(0, true)
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  const deck = engine.activePlayer
  deck.currentTime = 100
  deck.emit({ playing: false, didJustFinish: true })
  assert.strictEqual(events.end, 1)
  assert.strictEqual(deck.playing, false, 'paused, so nothing loaded into it later starts by itself')
  assert.deepStrictEqual(deck.seeks, [])
  // The queue is over: the app pauses (PlaybackController's isPlaying effect).
  engine.pause()
  assert.deepStrictEqual(deck.seeks, [0], 'back at its start: the Now Bar shows it paused, not stopped')
  assertShown(deck, 'Song A')
})

test('play after the end of the queue starts the last song again from the top', () => {
  load()
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  const deck = engine.activePlayer
  deck.currentTime = 100
  deck.emit({ playing: false, didJustFinish: true })
  deck.press('play')
  assert.deepStrictEqual(deck.seeks, [0])
  assert.strictEqual(deck.playing, true)
  assert.deepStrictEqual(events.external, [true])
})

// --- Audio focus ---

test('with the native focus, expo-audio\'s own is switched off', async () => {
  load()
  await Promise.resolve()
  assert.strictEqual(fake.audioMode.interruptionMode, 'mixWithOthers')
  assert.strictEqual(fake.audioMode.shouldPlayInBackground, true)
})

test('an older build without it keeps expo-audio\'s', async () => {
  load({ missing: true })
  await Promise.resolve()
  assert.strictEqual(fake.audioMode.interruptionMode, 'doNotMix')
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  assert.strictEqual(engine.activePlayer.playing, true, 'it still plays')
  fake.native.missing = false
})

test('playing asks for the focus first', () => {
  load()
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  assert.ok(fake.native.focusRequests >= 1)
  assert.strictEqual(engine.activePlayer.playing, true)
})

test('during a call the music waits, then starts when the call ends, without the app being told of a pause', () => {
  load({ focusAnswer: 'delayed' })
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  const deck = engine.activePlayer
  assert.strictEqual(deck.playing, false)
  deck.emit({ playing: false, isLoaded: true })
  assert.strictEqual(deck.playing, false, 'not started by a status either')
  fake.native.focusAnswer = 'granted'
  focusChange('resume')
  assert.strictEqual(deck.playing, true)
  assert.deepStrictEqual(events.external, [])
})

test('a call or a voice message pauses the music, which comes back after, and the app sees no pause', () => {
  load()
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  const deck = engine.activePlayer
  deck.emit({ playing: true })
  focusChange('interrupt')
  assert.strictEqual(deck.playing, false)
  const plays = deck.plays
  deck.emit({ playing: false, isLoaded: true })
  deck.emit({ playing: false, isLoaded: true })
  assert.strictEqual(deck.plays, plays, 'not restarted while the other app has the sound')
  focusChange('resume')
  assert.strictEqual(deck.playing, true)
  deck.emit({ playing: true })
  assert.deepStrictEqual(events.external, [], 'the app\'s play state never changed')
})

test('an interruption mid-crossfade ends the fade, and only the new song comes back', () => {
  load()
  engine.setTransitions(6, true)
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  engine.setNext({ id: 'b', source: 'src-b', info: info('Song B') })
  const first = engine.activePlayer
  playTo(75)
  playTo(95)
  const second = engine.activePlayer
  focusChange('interrupt')
  assert.strictEqual(first.playing, false)
  assert.strictEqual(second.playing, false)
  assert.strictEqual(fake.native.cancelledFades, 1)
  focusChange('resume')
  assert.strictEqual(second.playing, true)
  assert.strictEqual(first.playing, false)
})

test('paused by the person during an interruption: it stays paused when the other app is done', () => {
  load()
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  const deck = engine.activePlayer
  focusChange('interrupt')
  engine.pause()
  focusChange('resume')
  assert.strictEqual(deck.playing, false)
})

test('a stray "resume" while the music plays changes nothing', () => {
  load()
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  const deck = engine.activePlayer
  deck.emit({ playing: true })
  const plays = deck.plays
  focusChange('resume')
  assert.strictEqual(deck.plays, plays)
})

test('an interruption while paused changes nothing', () => {
  load()
  engine.load('a', 'src-a', false, 0, 1, info('Song A'))
  const deck = engine.activePlayer
  const plays = deck.plays
  focusChange('interrupt')
  focusChange('resume')
  assert.strictEqual(deck.plays, plays)
  assert.strictEqual(deck.playing, false)
})

test('play pressed during an interruption takes the sound back at once', () => {
  load()
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  const deck = engine.activePlayer
  focusChange('interrupt')
  deck.press('play')
  assert.strictEqual(deck.playing, true)
  deck.emit({ playing: true })
  focusChange('resume')
  assert.strictEqual(deck.playing, true)
})

test('another app\'s playback stops the music for good, as a pause', () => {
  load()
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  const deck = engine.activePlayer
  deck.emit({ playing: true })
  focusChange('lost')
  assert.strictEqual(deck.playing, false)
  assert.deepStrictEqual(events.external, [false])
  focusChange('resume')
  assert.strictEqual(deck.playing, false, 'not started again by a stray resume')
})

test('an emptied queue gives the focus back', () => {
  load()
  engine.load('a', 'src-a', true, 0, 1, info('Song A'))
  engine.clearNowPlaying()
  assert.strictEqual(fake.native.focusAbandons, 1)
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'nowbar-engine.ts')
  fs.writeFileSync(entry, "export { engine, onRemoteCommand } from '@/services/playbackEngine'" + NL)
  await bundle(entry, STUBS, OUT)
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
  console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' Now Bar and audio focus tests passed')
  process.exit(failed ? 1 : 0)
})()
