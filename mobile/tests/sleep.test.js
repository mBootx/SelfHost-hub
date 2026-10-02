// The sleep timer: what it asks of the native side, what it shows, and how it ends.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const bundle = require('./lib/bundle')
const fake = require('./stubs/fake')
const miniStore = require('./stubs/mini-store')

const NL = String.fromCharCode(10)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The engine as the timer sees it: two decks to hand to the native side, and the "stop after this track" flag.
const engineState = { stopAfter: [] }
globalThis.__engineStub = {
  engine: {
    decks: ['deck-0', 'deck-1'],
    setStopAfterTrack: (on) => engineState.stopAfter.push(on)
  }
}
globalThis.__navidromeStub = miniStore({ isPlaying: true })

let m
let store
const tests = []
const test = (name, fn) => tests.push([name, fn])
const reset = () => {
  m.useSleepTimerStore.getState().cancel()
  engineState.stopAfter = []
  fake.native.sleep = null
  fake.native.sleepFails = false
  fake.native.sleepCancels = 0
  globalThis.__navidromeStub.setState({ isPlaying: true })
}

test('a timer asks the native side to stop in that long, fading over the last ten seconds', () => {
  reset()
  const before = Date.now()
  store.getState().startTimer(30)
  assert.deepStrictEqual(fake.native.sleep, { first: 'deck-0', second: 'deck-1', durationMs: 1_800_000, fadeMs: 10_000 })
  const { mode, endsAt } = store.getState()
  assert.strictEqual(mode, 'timer')
  assert.ok(endsAt >= before + 1_800_000 && endsAt <= Date.now() + 1_800_000)
  assert.ok(engineState.stopAfter.includes(false), 'a pending "after this track" is replaced')
})

test('a very short timer fades over all of it, not longer than it lasts', () => {
  reset()
  store.getState().startTimer(0.05) // 3 s
  assert.strictEqual(fake.native.sleep.durationMs, 3000)
  assert.strictEqual(fake.native.sleep.fadeMs, 3000)
})

test('a new timer replaces the one running', () => {
  reset()
  store.getState().startTimer(15)
  store.getState().startTimer(60)
  assert.strictEqual(fake.native.sleep.durationMs, 3_600_000)
  assert.ok(fake.native.sleepCancels >= 2, 'the first was cancelled before the second started')
})

test('"after this track" stops the timer and sets the engine flag', () => {
  reset()
  store.getState().startTimer(30)
  engineState.stopAfter = []
  store.getState().stopAfterTrack()
  assert.strictEqual(fake.native.sleep, null, 'no timer is left running')
  assert.deepStrictEqual(engineState.stopAfter, [false, true], 'cleared, then set')
  assert.deepStrictEqual([store.getState().mode, store.getState().endsAt], ['track', null])
})

test('cancelling turns everything off', () => {
  reset()
  store.getState().startTimer(30)
  store.getState().cancel()
  assert.strictEqual(fake.native.sleep, null)
  assert.deepStrictEqual([store.getState().mode, store.getState().endsAt], ['off', null])
  assert.strictEqual(engineState.stopAfter[engineState.stopAfter.length - 1], false)
})

test('when the native side says it is over, the display goes back to off', () => {
  reset()
  m.initSleepTimer()
  const listener = fake.native.shareListeners.find(([event]) => event === 'onSleepTimerEnded')
  assert.ok(listener, 'listening for the end')
  store.getState().startTimer(30)
  listener[1]()
  assert.strictEqual(store.getState().mode, 'off')
})

test('coming back to the app after the deadline clears the display; before it, nothing changes', () => {
  reset()
  const states = require('./stubs/react-native')
  store.getState().startTimer(30)
  states.__emitAppState('active')
  assert.strictEqual(store.getState().mode, 'timer', 'not over yet')
  store.setState({ endsAt: Date.now() - 5000 })
  states.__emitAppState('background')
  assert.strictEqual(store.getState().mode, 'timer', 'only on return')
  states.__emitAppState('active')
  assert.strictEqual(store.getState().mode, 'off')
})

test('without the native timer a JS one still stops the music', async () => {
  reset()
  fake.native.sleepFails = true
  store.getState().startTimer(0.01) // 600 ms
  assert.strictEqual(store.getState().mode, 'timer')
  assert.strictEqual(globalThis.__navidromeStub.getState().isPlaying, true)
  await sleep(800)
  assert.strictEqual(globalThis.__navidromeStub.getState().isPlaying, false)
  assert.strictEqual(store.getState().mode, 'off')
})

test('cancelling also cancels the JS fallback', async () => {
  reset()
  fake.native.sleepFails = true
  store.getState().startTimer(0.01)
  store.getState().cancel()
  await sleep(800)
  assert.strictEqual(globalThis.__navidromeStub.getState().isPlaying, true, 'the music was left alone')
})

test('what is left is written for people', () => {
  assert.strictEqual(m.describeRemaining(0), "moins d'une minute")
  assert.strictEqual(m.describeRemaining(-5000), "moins d'une minute")
  assert.strictEqual(m.describeRemaining(30_000), '1 min')
  assert.strictEqual(m.describeRemaining(23 * 60_000 - 5000), '23 min')
  assert.strictEqual(m.describeRemaining(60 * 60_000), '1 h 00')
  assert.strictEqual(m.describeRemaining(65 * 60_000), '1 h 05')
  assert.strictEqual(m.describeRemaining(90 * 60_000 - 1), '1 h 30')
})

;(async () => {
  const entry = path.join(bundle.OUT, 'entries', 'sleep.ts')
  fs.writeFileSync(entry, "export * from '@/services/sleepTimer'" + NL)
  m = require(
    await bundle(
      entry,
      {
        'react-native': 'react-native.js',
        '@/services/storage': 'storage.js',
        '@/services/playbackEngine': 'engine-handle.js',
        '@/store/navidromeStore': 'navidrome-handle.js'
      },
      path.join(bundle.OUT, 'sleep.js')
    )
  )
  store = m.useSleepTimerStore
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
  console.log(failed ? failed + ' of ' + tests.length + ' failed' : 'all ' + tests.length + ' sleep timer tests passed')
  process.exit(failed ? 1 : 0)
})()
